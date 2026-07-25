-- svc-order · 002_idempotency
--
-- Closes a real bug found by replaying a checkout against the running
-- stack: three retries with the SAME Idempotency-Key produced THREE orders.
-- On a Ghanaian mobile network a timed-out POST is routine, so the client
-- retries — and the customer was charged again each time.
--
-- The key is enforced HERE rather than in application code because a unique
-- index is the only thing that holds when two replicas process the same
-- retry concurrently. An in-process cache or a SELECT-then-INSERT both lose
-- that race, and losing it means duplicate orders and duplicate charges.

CREATE TABLE idempotency_keys (
  -- The client's key. Scoped by actor so one customer cannot collide with
  -- (or replay) another's request by guessing a key.
  key            TEXT        NOT NULL,
  actor_id       UUID        NOT NULL,
  endpoint       TEXT        NOT NULL,

  -- Fingerprint of the request body. A retry MUST carry the same payload;
  -- reusing a key with different contents is a client bug, and silently
  -- returning the first order would hide it.
  request_hash   TEXT        NOT NULL,

  -- The response we already sent, replayed verbatim on a retry.
  order_id       UUID,
  response_body  JSONB,
  status_code    SMALLINT    NOT NULL DEFAULT 201,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (key, actor_id, endpoint)
);

-- Keys are only useful for as long as a client might retry. A day is far
-- longer than any sane retry window and keeps the table small.
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (created_at);

COMMENT ON TABLE idempotency_keys IS
  'Replay protection for POST /orders. A retry returns the ORIGINAL order '
  'rather than creating a second one. See 002_idempotency.sql.';
