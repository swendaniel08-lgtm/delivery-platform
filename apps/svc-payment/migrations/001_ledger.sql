-- svc-payment · 001_ledger
-- Double-entry ledger. MASTER_PLAN §3.4.
-- Closes issue #1: the database physically cannot store an unbalanced transaction.

CREATE TYPE ledger_direction AS ENUM ('debit', 'credit');
CREATE TYPE ledger_normal   AS ENUM ('debit', 'credit');

CREATE TYPE ledger_account_type AS ENUM (
  'PLATFORM_REVENUE',
  'PLATFORM_HOLDING',
  'PLATFORM_CASH_HOLDING',
  'PLATFORM_FEES_EXPENSE',
  'PLATFORM_PROMO_EXPENSE',
  'CUSTOMER_WALLET',
  'VENDOR_WALLET',
  'RIDER_WALLET',
  'RIDER_COD_OBLIGATION',
  'PAYSTACK_INFLOW',
  'PAYSTACK_OUTFLOW'
);

CREATE TABLE ledger_accounts (
  id             BIGSERIAL PRIMARY KEY,
  account_type   ledger_account_type NOT NULL,
  owner_id       UUID,
  currency       CHAR(3)     NOT NULL DEFAULT 'GHS',
  normal_balance ledger_normal NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_currency_ghs CHECK (currency = 'GHS')
);
-- platform accounts are singletons (owner_id IS NULL); user accounts unique per owner
CREATE UNIQUE INDEX ledger_accounts_platform_uq
  ON ledger_accounts (account_type) WHERE owner_id IS NULL;
CREATE UNIQUE INDEX ledger_accounts_owner_uq
  ON ledger_accounts (account_type, owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE ledger_transactions (
  id          BIGSERIAL PRIMARY KEY,
  reference   TEXT        NOT NULL UNIQUE,   -- 'order:{id}:settlement' → idempotency
  type        TEXT        NOT NULL,
  order_id    UUID,
  description TEXT,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_transactions_order_idx ON ledger_transactions (order_id);

-- Append-only. Corrections are reversing entries, never edits.
CREATE TABLE ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT      NOT NULL REFERENCES ledger_transactions (id),
  account_id     BIGINT      NOT NULL REFERENCES ledger_accounts (id),
  direction      ledger_direction NOT NULL,
  amount_pesewas BIGINT      NOT NULL CHECK (amount_pesewas > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx      ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at DESC);

CREATE TABLE account_balances (
  account_id        BIGINT PRIMARY KEY REFERENCES ledger_accounts (id),
  balance_pesewas   BIGINT      NOT NULL DEFAULT 0,
  available_pesewas BIGINT      NOT NULL DEFAULT 0,
  pending_pesewas   BIGINT      NOT NULL DEFAULT 0,
  version           BIGINT      NOT NULL DEFAULT 0,   -- optimistic lock
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- THE INVARIANT
-- Deferred so a transaction may be built up over several INSERTs, but it
-- MUST balance by COMMIT or the whole thing rolls back.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS TRIGGER AS $$
DECLARE
  total_debit  BIGINT;
  total_credit BIGINT;
  entry_count  INT;
BEGIN
  SELECT
    COALESCE(SUM(amount_pesewas) FILTER (WHERE direction = 'debit'),  0),
    COALESCE(SUM(amount_pesewas) FILTER (WHERE direction = 'credit'), 0),
    COUNT(*)
  INTO total_debit, total_credit, entry_count
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % entr(y/ies); double-entry requires at least 2',
      NEW.transaction_id, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'UNBALANCED ledger transaction %: debits=% credits=% (difference=%)',
      NEW.transaction_id, total_debit, total_credit, total_debit - total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

-- Append-only enforcement
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; use a reversing entry'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_no_update BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER trg_ledger_no_delete BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Global invariant helper: across the whole ledger, debits must equal credits.
CREATE OR REPLACE VIEW ledger_global_check AS
SELECT
  COALESCE(SUM(amount_pesewas) FILTER (WHERE direction = 'debit'),  0) AS total_debit,
  COALESCE(SUM(amount_pesewas) FILTER (WHERE direction = 'credit'), 0) AS total_credit,
  COALESCE(SUM(amount_pesewas) FILTER (WHERE direction = 'debit'),  0)
  - COALESCE(SUM(amount_pesewas) FILTER (WHERE direction = 'credit'), 0) AS drift
FROM ledger_entries;
