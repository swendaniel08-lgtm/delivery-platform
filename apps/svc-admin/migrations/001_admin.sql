-- svc-admin · 001_admin
-- Closes issue #12: an append-only audit log of every back-office action.
--
-- This exists for one reason: when GHS 40,000 has moved and a vendor disputes
-- it, we must be able to say exactly who did what, when, from where, and what
-- the values were before and after. An audit log that can be edited is not an
-- audit log.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE admin_role AS ENUM (
  'super_admin','ops_manager','dispatcher','finance',
  'support','catalogue_editor','read_only'
);

CREATE TABLE admin_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE,          -- identity-svc user
  role        admin_role NOT NULL,
  -- City/zone scoping for ops staff; empty means national.
  zones       TEXT[] NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ---------------------------------------------------------------- */
/* AUDIT LOG — append only                                           */
/* ---------------------------------------------------------------- */

CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_user_id  UUID NOT NULL,
  actor_role     admin_role NOT NULL,
  action         TEXT NOT NULL,              -- 'vendor.approve', 'payment.refund'
  entity_type    TEXT NOT NULL,              -- 'Vendor', 'Order', 'Payment'
  entity_id      TEXT NOT NULL,
  before_state   JSONB,
  after_state    JSONB,
  -- Money touched by this action, so finance can filter on impact.
  amount_pesewas BIGINT,
  reason         TEXT,
  ip             INET,
  user_agent     TEXT,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_idx  ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_money_idx  ON audit_log (created_at DESC) WHERE amount_pesewas IS NOT NULL;

-- Nothing may edit or delete history. Corrections are new entries.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

/* Sensitive actions must always carry a reason. */
ALTER TABLE audit_log ADD CONSTRAINT audit_reason_required CHECK (
  action NOT IN (
    'payment.refund','payment.payout','vendor.suspend','rider.suspend',
    'customer.suspend','order.force_cancel','order.force_status','pricing.update'
  )
  OR (reason IS NOT NULL AND length(trim(reason)) >= 10)
);

/* ---------------------------------------------------------------- */
/* Platform configuration — editable without a deploy (PDF §14)      */
/* ---------------------------------------------------------------- */

CREATE TABLE platform_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1
);

-- Every config change is versioned so a bad pricing edit can be traced.
CREATE TABLE platform_config_history (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB NOT NULL,
  changed_by  UUID NOT NULL,
  reason      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX config_history_key_idx ON platform_config_history (key, changed_at DESC);

CREATE OR REPLACE FUNCTION record_config_change() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO platform_config_history (key, old_value, new_value, changed_by)
  VALUES (NEW.key, CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END,
          NEW.value, COALESCE(NEW.updated_by, '00000000-0000-0000-0000-000000000000'::uuid));
  NEW.version := CASE WHEN TG_OP = 'UPDATE' THEN OLD.version + 1 ELSE 1 END;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_config_history
  BEFORE INSERT OR UPDATE ON platform_config
  FOR EACH ROW EXECUTE FUNCTION record_config_change();

/* ---------------------------------------------------------------- */
/* Manual-resolution queue (failed payouts, disputes, COD chases)    */
/* ---------------------------------------------------------------- */

CREATE TYPE task_status AS ENUM ('open','in_progress','resolved','escalated');

CREATE TABLE admin_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL,        -- 'payout_failed','cod_overdue','dispute'
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  amount_pesewas BIGINT,
  priority       SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status         task_status NOT NULL DEFAULT 'open',
  assigned_to    UUID,
  resolution     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  CONSTRAINT task_resolution_required CHECK (
    status <> 'resolved' OR (resolution IS NOT NULL AND length(trim(resolution)) > 0)
  )
);
CREATE INDEX tasks_open_idx ON admin_tasks (priority, created_at)
  WHERE status IN ('open','in_progress');
-- one open task per entity+kind, so a retrying job cannot flood the queue
CREATE UNIQUE INDEX tasks_one_open_per_entity
  ON admin_tasks (kind, entity_type, entity_id)
  WHERE status IN ('open','in_progress');
