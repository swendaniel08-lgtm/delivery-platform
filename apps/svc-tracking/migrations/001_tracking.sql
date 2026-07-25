-- svc-tracking · 001_tracking
-- GPS history, geofence crossings and ETA snapshots.
--
-- Live positions live in Redis (hot path, thousands of writes/minute).
-- Postgres holds what must survive and be auditable: the breadcrumb trail
-- backing a delivery dispute, and the geofence events that auto-advanced an
-- order's state.
--
-- Volume note: at 5-second pings, one active rider writes ~720 rows/hour.
-- The table is therefore partitioned by day and pruned on a retention job.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE fence_kind      AS ENUM ('pickup', 'dropoff');
CREATE TYPE fence_transition AS ENUM ('entered', 'exited');
CREATE TYPE ping_rejection  AS ENUM (
  'accepted', 'stale', 'implausible_jump', 'mock_location',
  'poor_accuracy', 'out_of_bounds'
);

/* ---------------------------------------------------------------- */
/* Breadcrumb trail                                                  */
/* ---------------------------------------------------------------- */

CREATE TABLE rider_pings (
  id            BIGSERIAL,
  rider_id      UUID NOT NULL,
  leg_id        UUID,
  position      GEOGRAPHY(POINT, 4326) NOT NULL,
  accuracy_m    REAL,
  speed_mps     REAL,
  heading_deg   REAL,
  -- Rejected pings are STORED, not discarded: a cluster of mock_location
  -- rejections is the fraud signal, and it only exists if we keep them.
  outcome       ping_rejection NOT NULL DEFAULT 'accepted',
  battery_pct   SMALLINT,
  recorded_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Partitions are created ahead by a maintenance job; two to start.
CREATE TABLE rider_pings_default PARTITION OF rider_pings DEFAULT;

CREATE INDEX pings_leg_idx    ON rider_pings (leg_id, recorded_at DESC);
CREATE INDEX pings_rider_idx  ON rider_pings (rider_id, recorded_at DESC);
-- Fraud review scans only the rejections, which stay a small slice.
CREATE INDEX pings_rejected_idx ON rider_pings (rider_id, recorded_at DESC)
  WHERE outcome <> 'accepted';

/* ---------------------------------------------------------------- */
/* Geofence crossings                                                */
/* ---------------------------------------------------------------- */

CREATE TABLE geofence_events (
  id           BIGSERIAL PRIMARY KEY,
  leg_id       UUID NOT NULL,
  order_id     UUID NOT NULL,
  rider_id     UUID NOT NULL,
  fence        fence_kind NOT NULL,
  transition   fence_transition NOT NULL,
  position     GEOGRAPHY(POINT, 4326) NOT NULL,
  distance_m   INTEGER NOT NULL,
  -- The order event this crossing emitted, if any. Null when the crossing
  -- was informational (e.g. exiting a fence).
  emitted_event TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX geofence_leg_idx ON geofence_events (leg_id, created_at);

-- An arrival must auto-advance the order exactly once. Re-entering the fence
-- after stepping away cannot fire a second 'rider_arrive'.
CREATE UNIQUE INDEX geofence_one_entry_per_fence
  ON geofence_events (leg_id, fence)
  WHERE transition = 'entered' AND emitted_event IS NOT NULL;

/* ---------------------------------------------------------------- */
/* ETA snapshots                                                     */
/* ---------------------------------------------------------------- */

CREATE TABLE eta_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  leg_id        UUID NOT NULL,
  eta_seconds   INTEGER NOT NULL CHECK (eta_seconds >= 0),
  distance_m    INTEGER NOT NULL,
  -- 'google' when we paid for it, 'fallback' when Directions was unavailable
  -- and we used straight-line x1.4. Lets us measure real API spend per order.
  source        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eta_leg_idx ON eta_snapshots (leg_id, created_at DESC);

/* Maps spend per order — verifies the issue-#8 budget against reality. */
CREATE OR REPLACE VIEW maps_call_budget AS
SELECT
  leg_id,
  count(*) FILTER (WHERE source = 'google')   AS google_calls,
  count(*) FILTER (WHERE source = 'fallback') AS fallback_calls,
  min(created_at) AS first_eta,
  max(created_at) AS last_eta
FROM eta_snapshots
GROUP BY leg_id;

/* ---------------------------------------------------------------- */
/* Proof of delivery                                                 */
/* ---------------------------------------------------------------- */

CREATE TABLE delivery_proofs (
  leg_id        UUID PRIMARY KEY,
  order_id      UUID NOT NULL,
  rider_id      UUID NOT NULL,
  photo_keys    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Where the rider actually stood when they marked it delivered.
  position      GEOGRAPHY(POINT, 4326),
  -- Distance from the customer's pin. A large value is the dispute signal:
  -- "delivered" from 800m away deserves a look.
  distance_from_dropoff_m INTEGER,
  cod_collected_pesewas BIGINT,
  recipient_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX proofs_suspicious_idx ON delivery_proofs (created_at DESC)
  WHERE distance_from_dropoff_m > 300;

/* Latest known position per leg, for reconnecting a dropped map. */
CREATE OR REPLACE FUNCTION last_known_position(p_leg_id UUID)
RETURNS TABLE (lat DOUBLE PRECISION, lng DOUBLE PRECISION, recorded_at TIMESTAMPTZ) AS $$
  SELECT ST_Y(position::geometry), ST_X(position::geometry), rp.recorded_at
  FROM rider_pings rp
  WHERE rp.leg_id = p_leg_id AND rp.outcome = 'accepted'
  ORDER BY rp.recorded_at DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;
