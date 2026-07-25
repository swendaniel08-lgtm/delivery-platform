/**
 * cod.spec — exit criterion for issue #2.
 *
 * Proves the obligation is created at DELIVERY (not at placement), that the
 * float is bounded, and that a rider cannot walk away with our cash.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { LedgerService, riderWithdrawable } from '../src/ledger.ts';
import { PgLedgerRepository } from '../src/pg-ledger-repository.ts';
import {
  CodService, codStatus, evaluateRefusal, floatReport, COD_LIMITS,
} from '../src/cod/cod-service.ts';
import { fromCedis, toCedis } from '../../../libs/money/src/money.ts';
import { ConflictError, ValidationError } from '../../../libs/platform/src/errors.ts';

const DSN = process.env.LEDGER_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55432/payment';
let pool: pg.Pool | undefined;
let ledger: LedgerService;
let cod: CodService;
let dbUp = false;

before(async () => {
  try {
    pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync(join(process.cwd(), 'apps/svc-payment/migrations/001_ledger.sql'), 'utf8'));
    ledger = new LedgerService(new PgLedgerRepository(pool));
    cod = new CodService(ledger);
    dbUp = true;
  } catch { dbUp = false; }
});
after(async () => { await pool?.end(); });

const V = 'aaaaaaaa-0000-0000-0000-00000000000a';
const R = 'bbbbbbbb-0000-0000-0000-00000000000b';
const O1 = '11111111-0000-0000-0000-0000000000c1';
const O2 = '22222222-0000-0000-0000-0000000000c2';

const canonical = {
  vendorAmount: fromCedis('59.50'),
  riderAmount: fromCedis('8.00'),
  platformAmount: fromCedis('14.00'),
};

describe('obligation is booked at DELIVERY, not placement (closes issue #2)', () => {
  test('no obligation exists before the cash changes hands', async (t) => {
    if (!dbUp) return t.skip('no database');
    // an order merely existing must not create a debt
    assert.equal(toCedis(await ledger.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R })), '0.00');
  });

  test('delivery creates the obligation AND settles in one moment', async (t) => {
    if (!dbUp) return t.skip('no database');
    await cod.recordDelivery({
      orderId: O1, riderId: R, vendorId: V,
      collectedPesewas: fromCedis('81.50'),
      expectedPesewas: fromCedis('81.50'),
      ...canonical,
    });

    assert.equal(toCedis(await ledger.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R })), '81.50');
    assert.equal(toCedis(await ledger.balance({ type: 'VENDOR_WALLET', ownerId: V })), '59.50');
    assert.equal(toCedis(await ledger.balance({ type: 'RIDER_WALLET', ownerId: R })), '8.00');
    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_REVENUE' })), '14.00');
    // cash holding nets to zero: obligation in, settlement out
    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_CASH_HOLDING' })), '0.00');
  });

  test('short payment is a dispute, never a silent write-off', async (t) => {
    if (!dbUp) return t.skip('no database');
    await assert.rejects(() => cod.recordDelivery({
      orderId: O2, riderId: R, vendorId: V,
      collectedPesewas: fromCedis('70.00'),   // customer paid less
      expectedPesewas: fromCedis('81.50'),
      ...canonical,
    }), ConflictError);
  });

  test('remittance clears the obligation', async (t) => {
    if (!dbUp) return t.skip('no database');
    const owed = await ledger.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R });
    const res = await cod.remit({
      riderId: R, remittanceId: 'rem-1', amountPesewas: owed, currentObligation: owed,
    });
    assert.equal(res.remainingPesewas, 0n);
    assert.equal(toCedis(await ledger.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R })), '0.00');
  });

  test('the whole COD cycle leaves the ledger balanced', async (t) => {
    if (!dbUp) return t.skip('no database');
    const r = await pool!.query<{ drift: string }>('SELECT drift FROM ledger_global_check');
    assert.equal(r.rows[0]!.drift, '0');
  });

  test('a rider cannot remit more than they owe', async (t) => {
    if (!dbUp) return t.skip('no database');
    await assert.rejects(() => cod.remit({
      riderId: R, remittanceId: 'rem-x',
      amountPesewas: fromCedis('500'), currentObligation: fromCedis('100'),
    }), ValidationError);
  });

  test('partial remittance leaves the remainder outstanding', async (t) => {
    if (!dbUp) return t.skip('no database');
    await cod.recordDelivery({
      orderId: '33333333-0000-0000-0000-0000000000c3', riderId: R, vendorId: V,
      collectedPesewas: fromCedis('81.50'), expectedPesewas: fromCedis('81.50'), ...canonical,
    });
    const res = await cod.remit({
      riderId: R, remittanceId: 'rem-2',
      amountPesewas: fromCedis('50'), currentObligation: fromCedis('81.50'),
    });
    assert.equal(toCedis(res.remainingPesewas), '31.50');
    assert.equal(toCedis(await ledger.balance({ type: 'RIDER_COD_OBLIGATION', ownerId: R })), '31.50');
  });
});

describe('rider standing escalation (PDF §7)', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 6, 25, 12, 0, 0) + h * 3_600_000);
  const base = new Date(Date.UTC(2026, 6, 25, 12, 0, 0));

  test('no cash held = clear', () => {
    const s = codStatus({ riderId: R, obligationPesewas: 0n, oldestUnremittedAt: null });
    assert.equal(s.status, 'clear');
    assert.equal(s.canAcceptCod, true);
  });

  test('holding a normal amount is fine', () => {
    const s = codStatus({ riderId: R, obligationPesewas: fromCedis('120'), oldestUnremittedAt: base }, at(1));
    assert.equal(s.status, 'holding');
    assert.equal(s.canAcceptCod, true);
  });

  test('over GHS 300 blocks CASH orders but not all orders', () => {
    const s = codStatus({ riderId: R, obligationPesewas: fromCedis('350'), oldestUnremittedAt: base }, at(2));
    assert.equal(s.status, 'blocked');
    assert.equal(s.canAcceptCod, false);
    assert.equal(s.canAcceptAnyOrder, true, 'a rider may still take prepaid work');
  });

  test('24 hours outstanding triggers a warning', () => {
    const s = codStatus({ riderId: R, obligationPesewas: fromCedis('100'), oldestUnremittedAt: base }, at(25));
    assert.equal(s.status, 'warned');
    assert.equal(s.canAcceptAnyOrder, true);
    assert.match(s.message!, /suspended in/);
  });

  test('48 hours outstanding suspends ALL work', () => {
    const s = codStatus({ riderId: R, obligationPesewas: fromCedis('100'), oldestUnremittedAt: base }, at(49));
    assert.equal(s.status, 'suspended');
    assert.equal(s.canAcceptAnyOrder, false, 'debt must stop all earning');
    assert.match(s.message!, /Remit GHS 100.00/);
  });

  test('the documented thresholds are what we enforce', () => {
    assert.equal(COD_LIMITS.blockNewOrdersPesewas, fromCedis('300'));
    assert.equal(COD_LIMITS.warnAfterHours, 24);
    assert.equal(COD_LIMITS.suspendAfterHours, 48);
  });
});

describe('withdrawal guard interacts correctly with COD', () => {
  test('a rider holding cash cannot cash out their earnings', () => {
    const d = riderWithdrawable(fromCedis('100'), fromCedis('80'), fromCedis('50'));
    assert.equal(d.allowed, false);
    assert.equal(toCedis(d.maxWithdrawablePesewas), '20.00');
  });

  test('once remitted, the full balance is available', () => {
    const d = riderWithdrawable(fromCedis('100'), 0n, fromCedis('100'));
    assert.equal(d.allowed, true);
  });
});

describe('customer refuses to pay (PDF §7)', () => {
  const start = new Date(Date.UTC(2026, 6, 25, 12, 0, 0));
  const after = (m: number) => new Date(start.getTime() + m * 60_000);

  test('the 5-minute wait is enforced server-side', () => {
    const d = evaluateRefusal({ waitStartedAt: start, customerStrikes: 0 }, after(2));
    assert.equal(d.outcome, 'wait');
    assert.equal(d.canReturnNow, false);
    assert.ok(d.secondsRemaining > 0);
  });

  test('after 5 minutes the rider may return the order', () => {
    const d = evaluateRefusal({ waitStartedAt: start, customerStrikes: 0 }, after(6));
    assert.equal(d.outcome, 'return_to_vendor');
    assert.equal(d.canReturnNow, true);
    assert.equal(d.newStrikeCount, 1);
    assert.equal(d.codRevoked, false);
  });

  test('a third strike revokes COD for that customer', () => {
    const d = evaluateRefusal({ waitStartedAt: start, customerStrikes: 2 }, after(6));
    assert.equal(d.newStrikeCount, 3);
    assert.equal(d.codRevoked, true);
  });
});

describe('float report — the collections work queue', () => {
  const base = new Date(Date.UTC(2026, 6, 25, 12, 0, 0));
  const now = new Date(base.getTime() + 50 * 3_600_000);

  test('totals the outstanding float and ranks the worst offenders', () => {
    const rep = floatReport([
      { riderId: 'clean', obligationPesewas: 0n, oldestUnremittedAt: null },
      { riderId: 'ok', obligationPesewas: fromCedis('50'), oldestUnremittedAt: now },
      { riderId: 'big', obligationPesewas: fromCedis('400'), oldestUnremittedAt: base },
      { riderId: 'old', obligationPesewas: fromCedis('120'), oldestUnremittedAt: base },
    ], now);

    assert.equal(toCedis(rep.totalOutstandingPesewas), '570.00');
    assert.equal(rep.riderCount, 3);
    assert.equal(rep.suspendedRiders, 2, 'both aged debts are suspended');
    assert.equal(rep.atRisk[0]!.riderId, 'big', 'largest debt first');
  });

  test('a clean fleet reports nothing at risk', () => {
    const rep = floatReport([{ riderId: 'a', obligationPesewas: 0n, oldestUnremittedAt: null }]);
    assert.equal(rep.totalOutstandingPesewas, 0n);
    assert.equal(rep.atRisk.length, 0);
  });
});
