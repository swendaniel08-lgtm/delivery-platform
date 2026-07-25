-- svc-messaging · 001_messaging
-- Chat, notification delivery log and device tokens.
--
-- Two reasons this is durable rather than fire-and-forget:
--   1. Chat is the evidence in a delivery dispute ("I told the rider the
--      gate was locked"). It must survive.
--   2. SMS costs real money per segment. Without a delivery log we cannot
--      reconcile the Hubtel bill or spot a loop that sends 400 messages.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE chat_pair    AS ENUM ('customer_rider', 'customer_vendor');
CREATE TYPE chat_party   AS ENUM ('customer', 'rider', 'vendor');
CREATE TYPE notify_channel AS ENUM ('push', 'sms', 'in_app', 'email');
CREATE TYPE notify_status  AS ENUM ('queued', 'sent', 'failed', 'suppressed');
CREATE TYPE device_platform AS ENUM ('android', 'ios', 'web');

/* ---------------------------------------------------------------- */
/* Chat                                                              */
/* ---------------------------------------------------------------- */

CREATE TABLE chat_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL,
  pair         chat_pair NOT NULL,
  customer_id  UUID NOT NULL,
  counterparty_id UUID,
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  -- PDF §9: chat closes 30 minutes after delivery. Stored rather than
  -- computed so the window survives a change to the policy constant.
  closes_at    TIMESTAMPTZ,
  UNIQUE (order_id, pair)
);
CREATE INDEX chat_threads_order_idx ON chat_threads (order_id);

CREATE TABLE chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  thread_id  UUID NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  from_party chat_party NOT NULL,
  from_user_id UUID NOT NULL,
  body       TEXT,
  image_key  TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An empty message is meaningless; one of the two must be present.
  CONSTRAINT chat_message_has_content CHECK (
    (body IS NOT NULL AND length(trim(body)) > 0) OR image_key IS NOT NULL
  ),
  CONSTRAINT chat_message_length CHECK (body IS NULL OR length(body) <= 1000)
);
CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, created_at);
CREATE INDEX chat_messages_unread_idx ON chat_messages (thread_id)
  WHERE read_at IS NULL;

-- Chat is dispute evidence: it may be read and closed, never rewritten.
CREATE OR REPLACE FUNCTION reject_chat_rewrite() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.image_key IS DISTINCT FROM OLD.image_key THEN
    RAISE EXCEPTION 'chat message content is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chat_immutable BEFORE UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION reject_chat_rewrite();

/* ---------------------------------------------------------------- */
/* Device tokens                                                     */
/* ---------------------------------------------------------------- */

CREATE TABLE device_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  platform    device_platform NOT NULL,
  app         TEXT NOT NULL,          -- customer | vendor | rider
  -- FCM reports permanently-dead tokens; keeping them wastes quota and
  -- pollutes delivery statistics.
  revoked_at  TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_tokens_user_idx ON device_tokens (user_id)
  WHERE revoked_at IS NULL;

/* ---------------------------------------------------------------- */
/* Delivery log                                                      */
/* ---------------------------------------------------------------- */

CREATE TABLE notification_log (
  id           BIGSERIAL PRIMARY KEY,
  -- The outbox event id. Dedupe key: an at-least-once relay must not
  -- produce two "your rider is here" pushes.
  event_id     UUID NOT NULL,
  event_type   TEXT NOT NULL,
  recipient_user_id UUID,
  recipient_phone   TEXT,
  channel      notify_channel NOT NULL,
  status       notify_status NOT NULL DEFAULT 'queued',
  provider     TEXT,
  provider_message_id TEXT,
  -- SMS billing driver. Reconciles against the Hubtel invoice.
  sms_segments SMALLINT,
  is_critical  BOOLEAN NOT NULL DEFAULT false,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One delivery per (event, recipient, channel). This is the durable half of
-- the idempotency guarantee; the Redis dedupe is the fast half.
CREATE UNIQUE INDEX notification_once_per_event
  ON notification_log (event_id, coalesce(recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid), channel);

CREATE INDEX notification_recent_idx ON notification_log (created_at DESC);
CREATE INDEX notification_failed_idx ON notification_log (created_at DESC)
  WHERE status = 'failed';

/* Daily SMS spend — catches a runaway loop before the invoice does. */
CREATE OR REPLACE VIEW sms_spend_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  provider,
  count(*)                       AS messages,
  coalesce(sum(sms_segments), 0) AS segments,
  count(*) FILTER (WHERE status = 'failed') AS failures
FROM notification_log
WHERE channel = 'sms'
GROUP BY 1, 2
ORDER BY 1 DESC;
