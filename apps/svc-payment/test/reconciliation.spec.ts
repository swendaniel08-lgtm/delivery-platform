/** reconciliation.spec — nightly Paystack-vs-ledger match. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, shouldHaltPayouts, type PaystackSettlementRow } from '../src/paystack/reconciliation.ts';
import { fromCedis } from '../../../libs/money/src/money.ts';

const ps = (reference: string, amount: string, status: PaystackSettlementRow['status'] = 'success'): PaystackSettlementRow =>
  ({ reference, amountPesewas: fromCedis(amount), feePesewas: fromCedis('1.59'), status, settledAt: '2026-07-25' });

describe('clean day', () => {
  test('matching rows reconcile with no discrepancies', () => {
    const r = reconcile({
      date: '2026-07-25',
      paystackRows: [ps('ord_1_a1', '81.50'), ps('ord_2_a1', '45.00')],
      ledgerRows: [
        { reference: 'ord_1_a1', amountPesewas: fromCedis('81.50') },
        { reference: 'ord_2_a1', amountPesewas: fromCedis('45.00') },
      ],
      internalDrift: 0n,
    });
    assert.equal(r.clean, true);
    assert.equal(r.discrepancies.length, 0);
    assert.equal(r.paystackTotal, r.ledgerTotal);
    assert.equal(shouldHaltPayouts(r).halt, false);
  });
});

describe('discrepancy detection', () => {
  test('money at Paystack we never recorded', () => {
    const r = reconcile({
      date: 'd', paystackRows: [ps('ord_ghost_a1', '120.00')], ledgerRows: [], internalDrift: 0n,
    });
    assert.equal(r.clean, false);
    assert.equal(r.discrepancies[0]!.kind, 'missing_in_ledger');
  });

  test('we captured but Paystack has nothing', () => {
    const r = reconcile({
      date: 'd', paystackRows: [],
      ledgerRows: [{ reference: 'ord_x_a1', amountPesewas: fromCedis('60.00') }],
      internalDrift: 0n,
    });
    assert.equal(r.discrepancies[0]!.kind, 'missing_at_paystack');
  });

  test('amount mismatch is flagged with both figures', () => {
    const r = reconcile({
      date: 'd', paystackRows: [ps('ord_1_a1', '81.50')],
      ledgerRows: [{ reference: 'ord_1_a1', amountPesewas: fromCedis('80.00') }],
      internalDrift: 0n,
    });
    const d = r.discrepancies[0]!;
    assert.equal(d.kind, 'amount_mismatch');
    assert.equal(d.expected, '81.50');
    assert.equal(d.actual, '80.00');
  });

  test('a reversal we recorded as captured', () => {
    const r = reconcile({
      date: 'd', paystackRows: [ps('ord_1_a1', '81.50', 'reversed')],
      ledgerRows: [{ reference: 'ord_1_a1', amountPesewas: fromCedis('81.50') }],
      internalDrift: 0n,
    });
    assert.equal(r.discrepancies[0]!.kind, 'unexpected_reversal');
  });

  test('discrepancies are ordered by money at risk', () => {
    const r = reconcile({
      date: 'd',
      paystackRows: [ps('small', '5.00'), ps('big', '900.00')],
      ledgerRows: [], internalDrift: 0n,
    });
    assert.equal(r.discrepancies[0]!.reference, 'big');
  });
});

describe('payout halting', () => {
  test('internal drift halts payouts immediately', () => {
    const r = reconcile({ date: 'd', paystackRows: [], ledgerRows: [], internalDrift: 100n });
    const h = shouldHaltPayouts(r);
    assert.equal(h.halt, true);
    assert.match(h.reason!, /internally inconsistent/);
  });

  test('large unreconciled sums halt payouts', () => {
    const r = reconcile({
      date: 'd', paystackRows: [ps('a', '600.00')], ledgerRows: [], internalDrift: 0n,
    });
    assert.equal(shouldHaltPayouts(r).halt, true);
  });

  test('a small discrepancy does not halt the platform', () => {
    const r = reconcile({
      date: 'd', paystackRows: [ps('a', '10.00')], ledgerRows: [], internalDrift: 0n,
    });
    assert.equal(r.clean, false);
    assert.equal(shouldHaltPayouts(r).halt, false, 'must not stop all payouts for GHS 10');
  });
});
