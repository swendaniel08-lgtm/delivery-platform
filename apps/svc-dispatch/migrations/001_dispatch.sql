-- svc-dispatch · 001_dispatch
-- Rider availability, broadcast offers and assignments.
--
-- The atomic first-to-accept claim lives in Redis (issue #7) because only
-- SET NX can arbitrate across API instances. Postgres holds the DURABLE
-- record: who was offered what, who accepted, and why an assignment failed.
-- Redis is the referee; this is the ledger of the match.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE vehicle_kind  AS ENUM ('bicycle', 'motorbike', 'car');
CREATE TYPE offer_outcome AS ENUM ('pending', 'accepted', 'declined', 'expired', 'superseded');
CREATE TYPE assignment_state AS ENUM ('active', 'completed', 'cancelled', 'reassigned');

/* ---------------------------------------------------------------- */
/* Rider availability                                                */
/* ---------------------------------------------------------------- */

CREATE TABLE rider_availability (
  rider_id            UUID PRIMARY KEY,
  vehicle             vehicle_kind NOT NULL,
  is_online           BOOLEAN NOT NULL DEFAULT false,
  -- Denormalised from payment-svc so dispatch can gate COD offers without a
  -- synchronous call on every broadcast. Refreshed by payment events.
  cod_obligation_pesewas BIGINT NOT NULL DEFAULT 0 CHECK (cod_obligation_pesewas >= 0),
  acceptance_rate     NUMERIC(4,3) NOT NULL DEFAULT 1.000
                        CHECK (acceptance_rate BETWEEN 0 AND 1),
  cancellations_today INTEGER NOT NULL DEFAULT 0 CHECK (cancellations_today >= 0),
  -- PDF §8: 3 cancellations in a day = 2 hours offline
  sidelined_until     TIMESTAMPTZ,
  last_position       GEOGRAPHY(POINT, 4326),
  last_ping_at        TIMESTAMPTZ,
  zone                TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Candidate search: online riders with a recent fix, nearest first.
CREATE INDEX rider_available_geo_idx
  ON rider_availability USING GIST (last_position)
  WHERE is_online;
CREATE INDEX rider_available_zone_idx ON rider_availability (zone) WHERE is_online;

/* ---------------------------------------------------------------- */
/* Broadcast offers                                                  */
/* ---------------------------------------------------------------- */

CREATE TABLE dispatch_offers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leg_id        UUID NOT NULL,
  order_id      UUID NOT NULL,
  round         SMALLINT NOT NULL CHECK (round BETWEEN 1 AND 10),
  radius_metres INTEGER NOT NULL,
  earnings_pesewas BIGINT NOT NULL CHECK (earnings_pesewas >= 0),
  is_cod        BOOLEAN NOT NULL DEFAULT false,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (leg_id, round)
);
CREATE INDEX offers_leg_idx ON dispatch_offers (leg_id, round);

CREATE TABLE offer_recipients (
  offer_id     UUID NOT NULL REFERENCES dispatch_offers (id) ON DELETE CASCADE,
  rider_id     UUID NOT NULL,
  distance_metres INTEGER NOT NULL,
  rank         SMALLINT NOT NULL,
  outcome      offer_outcome NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMPTZ,
  PRIMARY KEY (offer_id, rider_id)
);
-- Acceptance-rate maintenance reads this per rider.
CREATE INDEX offer_recipients_rider_idx ON offer_recipients (rider_id, outcome);

/* ---------------------------------------------------------------- */
/* Assignments                                                       */
/* ---------------------------------------------------------------- */

CREATE TABLE assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leg_id       UUID NOT NULL,
  order_id     UUID NOT NULL,
  rider_id     UUID NOT NULL,
  offer_id     UUID REFERENCES dispatch_offers (id),
  state        assignment_state NOT NULL DEFAULT 'active',
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  CONSTRAINT assignment_cancel_reason CHECK (
    state <> 'cancelled' OR cancel_reason IS NOT NULL
  )
);

-- THE DURABLE GUARD behind issue #7: even if Redis were flushed mid-flight,
-- the database refuses a second active assignment for the same leg.
CREATE UNIQUE INDEX assignments_one_active_per_leg
  ON assignments (leg_id) WHERE state = 'active';

-- A rider carries one job at a time (no batching at launch, PDF §12).
CREATE UNIQUE INDEX assignments_one_active_per_rider
  ON assignments (rider_id) WHERE state = 'active';

CREATE INDEX assignments_order_idx ON assignments (order_id);

/* ---------------------------------------------------------------- */
/* Failures — the retry/escalation record                            */
/* ---------------------------------------------------------------- */

CREATE TABLE dispatch_failures (
  id          BIGSERIAL PRIMARY KEY,
  leg_id      UUID NOT NULL,
  order_id    UUID NOT NULL,
  rounds_attempted SMALLINT NOT NULL,
  riders_reached   SMALLINT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dispatch_failures_time_idx ON dispatch_failures (created_at DESC);

/* ---------------------------------------------------------------- */
/* Candidate search                                                  */
/* ---------------------------------------------------------------- */

/*
 * Eligible riders within a radius, nearest first.
 *
 * The COD ceiling is evaluated against the balance AFTER this order, which
 * is the check a naive "under GHS 300?" test gets wrong: a rider holding
 * GHS 250 passes it, then takes a GHS 100 cash order and ends at GHS 350.
 */
CREATE OR REPLACE FUNCTION find_dispatch_candidates(
  pickup_lat        DOUBLE PRECISION,
  pickup_lng        DOUBLE PRECISION,
  radius_m          INTEGER,
  required_vehicles vehicle_kind[],
  order_is_cod      BOOLEAN,
  order_total_pesewas BIGINT,
  cod_ceiling_pesewas BIGINT DEFAULT 30000,
  stale_after       INTERVAL DEFAULT INTERVAL '2 minutes',
  max_rows          INTEGER DEFAULT 10
)
RETURNS TABLE (rider_id UUID, distance_metres INTEGER, acceptance_rate NUMERIC) AS $$
  SELECT
    ra.rider_id,
    ST_Distance(ra.last_position,
      ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography)::INTEGER,
    ra.acceptance_rate
  FROM rider_availability ra
  WHERE ra.is_online
    AND ra.vehicle = ANY (required_vehicles)
    AND ra.last_position IS NOT NULL
    -- A rider whose phone stopped reporting is not actually available.
    AND ra.last_ping_at > now() - stale_after
    AND (ra.sidelined_until IS NULL OR ra.sidelined_until < now())
    AND NOT EXISTS (
      SELECT 1 FROM assignments a
       WHERE a.rider_id = ra.rider_id AND a.state = 'active'
    )
    AND (
      NOT order_is_cod
      OR ra.cod_obligation_pesewas + order_total_pesewas <= cod_ceiling_pesewas
    )
    AND ST_DWithin(ra.last_position,
          ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography,
          radius_m)
  ORDER BY ra.last_position <-> ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography
  LIMIT max_rows;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rider_availability_touch BEFORE UPDATE ON rider_availability
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
