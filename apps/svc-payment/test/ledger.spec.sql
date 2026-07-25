-- ledger.spec — exit criterion for issue #1.
-- Run against a database with 001_ledger.sql applied.
-- Any FAIL raises and aborts with a non-zero exit.

\set ON_ERROR_STOP on

-- seed the chart of accounts
INSERT INTO ledger_accounts (account_type, normal_balance) VALUES
  ('PAYSTACK_INFLOW',       'debit'),
  ('PLATFORM_HOLDING',      'credit'),
  ('PLATFORM_REVENUE',      'credit'),
  ('PLATFORM_CASH_HOLDING', 'credit'),
  ('PLATFORM_FEES_EXPENSE', 'debit');
INSERT INTO ledger_accounts (account_type, owner_id, normal_balance) VALUES
  ('VENDOR_WALLET',        '11111111-1111-1111-1111-111111111111', 'credit'),
  ('RIDER_WALLET',         '22222222-2222-2222-2222-222222222222', 'credit'),
  ('RIDER_COD_OBLIGATION', '22222222-2222-2222-2222-222222222222', 'debit');

\echo '=== TEST 1: canonical settlement (81.50 = 59.50 + 8.00 + 14.00) must COMMIT ==='
BEGIN;
  INSERT INTO ledger_transactions (id, reference, type)
    VALUES (1, 'order:t1:settlement', 'settlement');
  INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
  SELECT 1, id, 'debit', 8150 FROM ledger_accounts WHERE account_type='PLATFORM_HOLDING';
  INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
  SELECT 1, id, 'credit', 5950 FROM ledger_accounts WHERE account_type='VENDOR_WALLET';
  INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
  SELECT 1, id, 'credit', 800 FROM ledger_accounts WHERE account_type='RIDER_WALLET';
  INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
  SELECT 1, id, 'credit', 1400 FROM ledger_accounts WHERE account_type='PLATFORM_REVENUE';
COMMIT;

DO $$ BEGIN
  IF (SELECT count(*) FROM ledger_entries WHERE transaction_id = 1) <> 4 THEN
    RAISE EXCEPTION 'FAIL T1: expected 4 entries';
  END IF;
  RAISE NOTICE 'PASS T1: balanced settlement committed';
END $$;

\echo '=== TEST 2: PDF section-7 figures (81.50 vs 61.00) MUST be rejected ==='
DO $$
DECLARE ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO ledger_transactions (id, reference, type)
      VALUES (2, 'order:t2:pdf_s7', 'settlement');
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
    SELECT 2, id, 'debit', 8150 FROM ledger_accounts WHERE account_type='PLATFORM_HOLDING';
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
    SELECT 2, id, 'credit', 4250 FROM ledger_accounts WHERE account_type='VENDOR_WALLET';
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
    SELECT 2, id, 'credit', 800 FROM ledger_accounts WHERE account_type='RIDER_WALLET';
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
    SELECT 2, id, 'credit', 1050 FROM ledger_accounts WHERE account_type='PLATFORM_REVENUE';
    -- force the deferred constraint to fire inside this block
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    ok := true;
    RAISE NOTICE 'PASS T2: rejected as expected -> %', SQLERRM;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL T2: unbalanced transaction was accepted!';
  END IF;
END $$;

\echo '=== TEST 3: single-sided entry must be rejected ==='
DO $$
DECLARE ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO ledger_transactions (id, reference, type)
      VALUES (3, 'order:t3:single', 'capture');
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
    SELECT 3, id, 'debit', 5000 FROM ledger_accounts WHERE account_type='PAYSTACK_INFLOW';
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    ok := true;
    RAISE NOTICE 'PASS T3: rejected -> %', SQLERRM;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL T3: single-sided entry accepted!'; END IF;
END $$;

\echo '=== TEST 4: negative / zero amounts rejected ==='
DO $$
DECLARE ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO ledger_transactions (id, reference, type) VALUES (4,'order:t4:neg','x');
    INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
    SELECT 4, id, 'debit', -100 FROM ledger_accounts WHERE account_type='PAYSTACK_INFLOW';
  EXCEPTION WHEN check_violation THEN
    ok := true; RAISE NOTICE 'PASS T4: negative amount rejected';
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL T4: negative amount accepted!'; END IF;
END $$;

\echo '=== TEST 5: ledger_entries is append-only ==='
DO $$
DECLARE ok_u BOOLEAN := false; ok_d BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE ledger_entries SET amount_pesewas = 1 WHERE transaction_id = 1;
  EXCEPTION WHEN check_violation THEN ok_u := true; END;
  BEGIN
    DELETE FROM ledger_entries WHERE transaction_id = 1;
  EXCEPTION WHEN check_violation THEN ok_d := true; END;
  IF NOT ok_u THEN RAISE EXCEPTION 'FAIL T5: UPDATE allowed on ledger_entries!'; END IF;
  IF NOT ok_d THEN RAISE EXCEPTION 'FAIL T5: DELETE allowed on ledger_entries!'; END IF;
  RAISE NOTICE 'PASS T5: append-only enforced';
END $$;

\echo '=== TEST 6: COD sequence (issue #2 shape) balances at every step ==='
BEGIN;
  INSERT INTO ledger_transactions (id, reference, type) VALUES (6,'order:t6:cod_obligation','cod');
  INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
  SELECT 6, id, 'debit', 8150 FROM ledger_accounts WHERE account_type='RIDER_COD_OBLIGATION';
  INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
  SELECT 6, id, 'credit', 8150 FROM ledger_accounts WHERE account_type='PLATFORM_CASH_HOLDING';
COMMIT;
DO $$ BEGIN RAISE NOTICE 'PASS T6: COD obligation booked'; END $$;

\echo '=== TEST 7: global invariant — total debits = total credits ==='
DO $$
DECLARE d BIGINT;
BEGIN
  SELECT drift INTO d FROM ledger_global_check;
  IF d <> 0 THEN RAISE EXCEPTION 'FAIL T7: global ledger drift = %', d; END IF;
  RAISE NOTICE 'PASS T7: global drift = 0';
END $$;

\echo ''
\echo 'ledger.spec: ALL TESTS PASSED'
