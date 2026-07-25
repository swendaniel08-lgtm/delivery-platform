/**
 * ledger-service.spec — runs against a REAL Postgres with the real migration,
 * so the deferred balance constraint is genuinely in play.
 *
 * Skips (rather than fails) when no database is reachable, so the pure-unit
 * suite still runs anywhere.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { LedgerService, riderWithdrawable, vendorWithdrawable } from '../src/ledger.ts';
import { PgLedgerRepository } from '../src/pg-ledger-repository.ts';
import { fromCedis, toCedis } from '../../../libs/money/src/money.ts';
import { ValidationError, ConflictError } from '../../../libs/platform/src/errors.ts';

const DSN = process.env.LEDGER_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55432/payment';

let pool: pg.Pool | undefined;
let svc: LedgerService;
let dbUp = false;

before(async () => {
  try {
    pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    const sql = readFileSync(join(process.cwd(), 'apps/svc-payment/migrations/001_ledger.sql'), 'utf8');
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await pool.query(sql);
    svc = new LedgerService(new PgLedgerRepository(pool));
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

after(async () => { await pool?.end(); });

const V = 'aaaaaaaa-0000-0000-0000-000000000001';
const R = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const O_PREPAID = '11111111-0000-0000-0000-00000000aaaa';
const O_IDEM    = '22222222-0000-0000-0000-00000000bbbb';
const O_COD     = '33333333-0000-0000-0000-00000000cccc';
const O_REFUND  = '44444444-0000-0000-0000-00000000dddd';

describe('pre-flight validation (before touching the DB)', () => {
  test('rejects an unbalanced posting', async () => {
    const s = new LedgerService({ withTransaction: async () => { throw new Error('must not reach DB'); } });
    await assert.rejects(() => s.post({
      reference: 'x', type: 't',
      entries: [
        { account: { type: 'PLATFORM_HOLDING' }, direction: 'debit', amount: 8150n },
        { account: { type: 'PLATFORM_REVENUE' }, direction: 'credit', amount: 6100n },
      ],
    }), ValidationError);
  });

  test('rejects a single-sided posting', async () => {
    const s = new LedgerService({ withTransaction: async () => { throw new Error('unreachable'); } });
    await assert.rejects(() => s.post({
      reference: 'x', type: 't',
      entries: [{ account: { type: 'PAYSTACK_INFLOW' }, direction: 'debit', amount: 100n }],
    }), ValidationError);
  });

  test('rejects a settlement split that does not sum to the total', () => {
    const s = new LedgerService({ withTransaction: async () => { throw new Error('unreachable'); } });
    // These are the erroneous PDF §7 figures: 42.50 + 8.00 + 10.50 = 61.00,
    // not 81.50. The service must refuse before the DB is ever touched.
    // assertSplit runs synchronously, so this throws rather than rejecting.
    assert.throws(
      () => s.settlePrepaid({
        orderId: O_PREPAID, vendorId: V, riderId: R,
        total: fromCedis('81.50'),
        vendorAmount: fromCedis('42.50'),
        riderAmount: fromCedis('8.00'),
        platformAmount: fromCedis('10.50'),
      }),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError, `expected ConflictError, got ${err}`);
        assert.match((err as Error).message, /6100 does not equal total 8150/);
        return true;
      },
    );
  });
});

describe('prepaid order lifecycle (real Postgres)', () => {
  test('capture → settle produces the canonical balances', async (t) => {
    if (!dbUp) return t.skip('no database');

    const orderId = O_PREPAID;
    await svc.capture(orderId, fromCedis('81.50'));
    assert.equal(toCedis(await svc.balance({ type: 'PLATFORM_HOLDING' })), '81.50');

    await svc.settlePrepaid({
      orderId, vendorId: V, riderId: R,
      total: fromCedis('81.50'),
      vendorAmount: fromCedis('59.50'),
      riderAmount: fromCedis('8.00'),
      platformAmount: fromCedis('14.00'),
    });

    assert.equal(toCedis(await svc.balance({ type: 'PLATFORM_HOLDING' })), '0.00');
    assert.equal(toCedis(await svc.balance({ type: 'VENDOR_WALLET', ownerId: V })), '59.50');
    assert.equal(toCedis(await svc.balance({ type: 'RIDER_WALLET', ownerId: R })), '8.00');
    assert.equal(toCedis(await svc.balance({ type: 'PLATFORM_REVENUE' })), '14.00');
  });

  test('PSP fee is booked as a real expense', async (t) => {
    if (!dbUp) return t.skip('no database');
    await svc.pspFee(O_PREPAID, fromCedis('1.59'));
    assert.equal(toCedis(await svc.balance({ type: 'PLATFORM_FEES_EXPENSE' })), '1.59');
  });

  test('IDEMPOTENCY: replaying capture does not double-credit', async (t) => {
    if (!dbUp) return t.skip('no database');
    const orderId = O_IDEM;
    const first = await svc.capture(orderId, fromCedis('50.00'));
    const before = await svc.balance({ type: 'PLATFORM_HOLDING' });

    // simulate Paystack redelivering the same webhook 5 times
    for (let i = 0; i < 5; i++) {
      const replay = await svc.capture(orderId, fromCedis('50.00'));
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.id, first.id);
    }
    assert.equal(await svc.balance({ type: 'PLATFORM_HOLDING' }), before);
  });
});

describe('COD lifecycle — obligation booked at DELIVERY (issue #2)', () => {
  test('obligation → settlement → remittance nets to zero', async (t) => {
    if (!dbUp) return t.skip('no database');

    const orderId = O_COD;
    const total = fromCedis('81.50');

    await svc.codObligation(orderId, R, total);
    assert.equal(toCedis(await svc.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R })), '81.50');

    await svc.settleCod({
      orderId, vendorId: V, riderId: R, total,
      vendorAmount: fromCedis('59.50'),
      riderAmount: fromCedis('8.00'),
      platformAmount: fromCedis('14.00'),
    });
    assert.equal(toCedis(await svc.balance({ type: 'PLATFORM_CASH_HOLDING' })), '0.00');

    await svc.codRemittance(R, 'rem-1', total);
    assert.equal(toCedis(await svc.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R })), '0.00');
  });
});

describe('refunds and payouts', () => {
  test('refund credits the customer wallet', async (t) => {
    if (!dbUp) return t.skip('no database');
    await svc.capture(O_REFUND, fromCedis('30.00'));
    await svc.refundToWallet(O_REFUND, C, fromCedis('30.00'));
    assert.equal(toCedis(await svc.balance({ type: 'CUSTOMER_WALLET', ownerId: C })), '30.00');
  });

  test('failed payout is REVERSED, never deleted (append-only)', async (t) => {
    if (!dbUp) return t.skip('no database');
    const acct = { type: 'VENDOR_WALLET' as const, ownerId: V };
    const before = await svc.balance(acct);

    await svc.payout('pay-1', acct, fromCedis('20.00'));
    assert.equal(await svc.balance(acct), before - fromCedis('20.00'));

    await svc.reversePayout('pay-1', acct, fromCedis('20.00'));
    assert.equal(await svc.balance(acct), before, 'reversal must restore the balance exactly');
  });
});

describe('global invariant', () => {
  test('after all activity, total debits still equal total credits', async (t) => {
    if (!dbUp) return t.skip('no database');
    const r = await pool!.query<{ drift: string }>('SELECT drift FROM ledger_global_check');
    assert.equal(r.rows[0]!.drift, '0', 'ledger has drifted');
  });

  test('materialised balances match a full replay of the entries', async (t) => {
    if (!dbUp) return t.skip('no database');
    const r = await pool!.query<{ mismatches: string }>(`
      SELECT count(*) AS mismatches FROM (
        SELECT b.account_id,
               b.balance_pesewas AS stored,
               COALESCE(SUM(CASE WHEN e.direction::text = a.normal_balance::text
                                 THEN e.amount_pesewas ELSE -e.amount_pesewas END), 0) AS replayed
          FROM account_balances b
          JOIN ledger_accounts a ON a.id = b.account_id
          LEFT JOIN ledger_entries e ON e.account_id = b.account_id
         GROUP BY b.account_id, b.balance_pesewas
      ) x WHERE stored <> replayed`);
    assert.equal(r.rows[0]!.mismatches, '0', 'materialised balance drifted from the entry log');
  });
});

describe('withdrawal guards', () => {
  test('rider cannot withdraw earnings while holding our cash', () => {
    const d = riderWithdrawable(fromCedis('100'), fromCedis('80'), fromCedis('50'));
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /remit/i);
    assert.equal(toCedis(d.maxWithdrawablePesewas), '20.00');
  });

  test('rider with no COD can withdraw freely', () => {
    assert.equal(riderWithdrawable(fromCedis('100'), 0n, fromCedis('50')).allowed, true);
  });

  test('COD exceeding the wallet leaves nothing withdrawable', () => {
    const d = riderWithdrawable(fromCedis('50'), fromCedis('120'), fromCedis('20'));
    assert.equal(d.allowed, false);
    assert.equal(toCedis(d.maxWithdrawablePesewas), '0.00');
  });

  test('GHS 20 minimum is enforced', () => {
    assert.equal(riderWithdrawable(fromCedis('100'), 0n, fromCedis('5')).allowed, false);
  });

  test('vendor 24-hour hold blocks early withdrawal', () => {
    const d = vendorWithdrawable(fromCedis('100'), fromCedis('60'), fromCedis('80'));
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /dispute hold/);
    assert.equal(toCedis(d.maxWithdrawablePesewas), '40.00');
  });
});
