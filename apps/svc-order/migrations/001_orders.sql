-- svc-order · 001_orders
-- Closes issue #10: Order 1..N DeliveryLeg from the FIRST migration.
-- Laundry needs 2 legs, errands have top-ups; retrofitting this later is a
-- rewrite, so legs are first-class from day one.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE order_service AS ENUM (
  'food','groceries','shop','market_catalogue','market_list',
  'pharmacy','laundry','parcel','errand'
);
CREATE TYPE order_engine   AS ENUM ('catalogue','request');
CREATE TYPE state_machine  AS ENUM ('A','B','C','D','E');
CREATE TYPE payment_intent AS ENUM ('prepaid','cod','wallet','mixed');
CREATE TYPE leg_type AS ENUM (
  'vendor_to_customer','customer_to_vendor','vendor_to_customer_return',
  'pickup_to_dropoff','task_to_customer'
);
CREATE TYPE leg_state AS ENUM (
  'pending','assigned','rider_at_pickup','picked_up','in_transit',
  'arrived','completed','failed','cancelled'
);

CREATE TABLE orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  human_ref         TEXT NOT NULL UNIQUE,          -- "#1234" shown to users
  customer_id       UUID NOT NULL,
  store_id          UUID,                          -- NULL for parcel/errand
  service           order_service NOT NULL,
  engine            order_engine  NOT NULL,
  machine           state_machine NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending_payment',

  -- immutable pesewa snapshot taken at checkout (issue #5)
  item_total_pesewas     BIGINT NOT NULL DEFAULT 0 CHECK (item_total_pesewas >= 0),
  delivery_fee_pesewas   BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_pesewas >= 0),
  service_fee_pesewas    BIGINT NOT NULL DEFAULT 0 CHECK (service_fee_pesewas >= 0),
  total_pesewas          BIGINT NOT NULL CHECK (total_pesewas >= 0),
  vendor_amount_pesewas  BIGINT NOT NULL DEFAULT 0,
  rider_amount_pesewas   BIGINT NOT NULL DEFAULT 0,
  platform_amount_pesewas BIGINT NOT NULL DEFAULT 0,

  payment_intent    payment_intent NOT NULL,
  paystack_reference TEXT,
  requires_prescription BOOLEAN NOT NULL DEFAULT false,
  prescription_url  TEXT,

  -- request-engine payloads
  errand_estimate_pesewas BIGINT,
  shopping_list     JSONB,
  parcel_weight_kg  NUMERIC(5,2),

  cancellation_reason TEXT,
  placed_at         TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the settlement split must reconstruct the total, or the ledger will
  -- refuse the settlement transaction downstream
  CONSTRAINT orders_split_balances CHECK (
    state NOT IN ('delivered','delivered_to_customer')
    OR vendor_amount_pesewas + rider_amount_pesewas + platform_amount_pesewas = total_pesewas
  ),
  CONSTRAINT orders_total_consistent CHECK (
    total_pesewas = item_total_pesewas + delivery_fee_pesewas + service_fee_pesewas
  ),
  -- PDF §2: shop is prepaid only, never cash
  CONSTRAINT orders_shop_prepaid CHECK (service <> 'shop' OR payment_intent <> 'cod')
);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_store_idx    ON orders (store_id, state);
CREATE INDEX orders_state_idx    ON orders (state) WHERE state NOT IN
  ('delivered','delivered_to_customer','cancelled','failed','vendor_rejected');

CREATE TABLE order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  item_id        UUID NOT NULL,
  name           TEXT NOT NULL,                   -- denormalised: menus change
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  unit_base_pesewas   BIGINT NOT NULL CHECK (unit_base_pesewas >= 0),
  addons_pesewas      BIGINT NOT NULL DEFAULT 0,
  variants_pesewas    BIGINT NOT NULL DEFAULT 0,
  line_total_pesewas  BIGINT NOT NULL CHECK (line_total_pesewas >= 0),
  addon_names    JSONB NOT NULL DEFAULT '[]'::jsonb,
  variant_names  JSONB NOT NULL DEFAULT '[]'::jsonb,
  note           TEXT,
  substitution_allowed BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

/* ---------------------------------------------------------------- */
/* DELIVERY LEGS — issue #10                                         */
/* ---------------------------------------------------------------- */

CREATE TABLE delivery_legs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sequence      SMALLINT NOT NULL CHECK (sequence >= 1),
  leg_type      leg_type NOT NULL,
  state         leg_state NOT NULL DEFAULT 'pending',

  pickup_lat    DOUBLE PRECISION NOT NULL,
  pickup_lng    DOUBLE PRECISION NOT NULL,
  pickup_label  TEXT,
  dropoff_lat   DOUBLE PRECISION NOT NULL,
  dropoff_lng   DOUBLE PRECISION NOT NULL,
  dropoff_label TEXT,

  assigned_rider_id UUID,
  assignment_id     UUID,
  fee_pesewas       BIGINT NOT NULL DEFAULT 0 CHECK (fee_pesewas >= 0),
  distance_metres   INTEGER,

  -- proof of delivery
  proof_photo_urls  JSONB NOT NULL DEFAULT '[]'::jsonb,
  proof_lat         DOUBLE PRECISION,
  proof_lng         DOUBLE PRECISION,
  cod_collected_pesewas BIGINT,

  assigned_at   TIMESTAMPTZ,
  picked_up_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (order_id, sequence),
  CONSTRAINT legs_assigned_has_rider CHECK (
    state IN ('pending','cancelled','failed') OR assigned_rider_id IS NOT NULL
  )
);
CREATE INDEX legs_order_idx ON delivery_legs (order_id, sequence);
CREATE INDEX legs_rider_idx ON delivery_legs (assigned_rider_id)
  WHERE state NOT IN ('completed','cancelled','failed');

-- A rider may hold only ONE active leg at a time (no batching at launch, PDF §12)
CREATE UNIQUE INDEX legs_one_active_per_rider
  ON delivery_legs (assigned_rider_id)
  WHERE assigned_rider_id IS NOT NULL
    AND state IN ('assigned','rider_at_pickup','picked_up','in_transit','arrived');

/* ---------------------------------------------------------------- */
/* State history — audit trail for every transition                  */
/* ---------------------------------------------------------------- */

CREATE TABLE order_state_history (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  event       TEXT NOT NULL,
  actor_type  TEXT NOT NULL,     -- customer | vendor | rider | system | admin
  actor_id    UUID,
  correlation_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_history_order_idx ON order_state_history (order_id, created_at);

/* ---------------------------------------------------------------- */
/* TRANSACTIONAL OUTBOX — MASTER_PLAN §1.2.2                         */
/* Never save() then publish(): the event is written in the SAME     */
/* transaction as the state change, then relayed asynchronously.     */
/* ---------------------------------------------------------------- */

CREATE TABLE outbox (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  event_type     TEXT NOT NULL,
  aggregate_type TEXT NOT NULL DEFAULT 'order',
  aggregate_id   UUID NOT NULL,
  payload        JSONB NOT NULL,
  correlation_id TEXT,
  causation_id   TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT
);
-- relay scans this partial index; it stays small because published rows drop out
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE UNIQUE INDEX outbox_event_id_idx ON outbox (event_id);

/* ---------------------------------------------------------------- */
/* Durable timers — issue #9                                         */
/* In-process setTimeout dies on redeploy. These rows survive, and   */
/* a worker claims them with SKIP LOCKED.                            */
/* ---------------------------------------------------------------- */

CREATE TABLE order_timers (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  fire_at     TIMESTAMPTZ NOT NULL,
  event       TEXT NOT NULL,
  -- state the order must still be in for the timer to be meaningful
  expect_state TEXT NOT NULL,
  fired_at    TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX timers_due_idx ON order_timers (fire_at)
  WHERE fired_at IS NULL AND cancelled_at IS NULL;
-- only one live timer of a given name per order
CREATE UNIQUE INDEX timers_one_live_per_name
  ON order_timers (order_id, name)
  WHERE fired_at IS NULL AND cancelled_at IS NULL;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

/* Claim due timers atomically — safe with N workers running concurrently. */
CREATE OR REPLACE FUNCTION claim_due_timers(batch INTEGER DEFAULT 50)
RETURNS TABLE (id BIGINT, order_id UUID, name TEXT, event TEXT, expect_state TEXT) AS $$
  UPDATE order_timers t
     SET fired_at = now()
   WHERE t.id IN (
     SELECT t2.id FROM order_timers t2
      WHERE t2.fired_at IS NULL AND t2.cancelled_at IS NULL AND t2.fire_at <= now()
      ORDER BY t2.fire_at
      LIMIT batch
      FOR UPDATE SKIP LOCKED
   )
  RETURNING t.id, t.order_id, t.name, t.event, t.expect_state;
$$ LANGUAGE sql;
