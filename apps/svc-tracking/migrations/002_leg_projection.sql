/*
 * Local projections tracking-svc reads on the hot path.
 *
 * Why projections rather than calling dispatch-svc and order-svc?
 *
 * `fencesFor()` runs on EVERY ping from EVERY online rider — at 5-second
 * intervals with a few hundred riders that is tens of calls a second, on the
 * path that must never be slow. A synchronous cross-service HTTP call there
 * would be the first thing to collapse at dinner time, and it would take
 * rider tracking down with it whenever dispatch-svc was merely slow.
 *
 * These tables are owned by tracking-svc but WRITTEN from consumed domain
 * events (leg.assigned, leg.completed, order.state_changed). They are a cache
 * with a clear source of truth elsewhere, so they are allowed to be
 * momentarily stale — a ping arriving one second after assignment simply sees
 * no active leg, and the next ping five seconds later sees it.
 *
 * They are NOT allowed to be wrong in a way that matters: nothing here
 * decides money. The fences decide when to *emit* an event; order-svc still
 * validates the transition.
 */

/* ---------------------------------------------------------------- */
/* Running distance on the current leg                               */
/* ---------------------------------------------------------------- */

-- Denormalised onto the ping row so `lastTrack` stays one indexed read
-- instead of a SUM over the whole leg. At 5s intervals a two-hour laundry
-- leg is ~1,400 rows; summing that on every ping is work we can simply not do.
ALTER TABLE rider_pings ADD COLUMN IF NOT EXISTS leg_distance_m INTEGER;

/* ---------------------------------------------------------------- */
/* Active legs — the fence source                                    */
/* ---------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS active_legs (
  leg_id        UUID PRIMARY KEY,
  order_id      UUID NOT NULL,
  rider_id      UUID NOT NULL,

  pickup_position  GEOGRAPHY(POINT, 4326),
  dropoff_position GEOGRAPHY(POINT, 4326),

  -- Radii are per-leg, not global. A dense Osu street needs a tight fence or
  -- the rider "arrives" while still two buildings away; a sparse Tema
  -- industrial estate needs a loose one or they never arrive at all.
  pickup_radius_m  INTEGER NOT NULL DEFAULT 100
    CHECK (pickup_radius_m BETWEEN 20 AND 1000),
  dropoff_radius_m INTEGER NOT NULL DEFAULT 100
    CHECK (dropoff_radius_m BETWEEN 20 AND 1000),

  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- The hot-path lookup: one active leg per rider. Partial, because completed
-- legs accumulate forever and must not slow down the live query.
CREATE INDEX IF NOT EXISTS active_legs_rider_idx
  ON active_legs (rider_id, assigned_at DESC)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS active_legs_order_idx ON active_legs (order_id);

-- A rider may hold only ONE active leg at a time. This is the database
-- backstop for the dispatch accept-race: Redis SET NX arbitrates it first,
-- but if that ever fails open, a rider physically cannot carry two orders
-- and the data should not claim they can.
CREATE UNIQUE INDEX IF NOT EXISTS active_legs_one_per_rider
  ON active_legs (rider_id)
  WHERE completed_at IS NULL;

/* ---------------------------------------------------------------- */
/* Who may watch an order                                            */
/* ---------------------------------------------------------------- */

-- Subscribe-time authorisation for the tracking socket. Without this,
-- deciding whether a customer may watch a rider means an HTTP call to
-- order-svc on every socket connect — including every reconnect on a flaky
-- Ghanaian mobile network, which is exactly when it would be slowest.
CREATE TABLE IF NOT EXISTS order_participants (
  order_id     UUID PRIMARY KEY,
  customer_id  UUID NOT NULL,
  rider_id     UUID,
  vendor_id    UUID,
  state        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_participants_customer_idx
  ON order_participants (customer_id);
CREATE INDEX IF NOT EXISTS order_participants_rider_idx
  ON order_participants (rider_id)
  WHERE rider_id IS NOT NULL;
