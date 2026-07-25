/**
 * Nightly reconciliation. Carried from Sprint 5, completed here because it
 * needs the Paystack settlement feed to compare against.
 *
 * Three independent checks, because each catches a different failure:
 *   A. internal — do our own debits equal our own credits?
 *   B. external — does our PAYSTACK_INFLOW match what Paystack settled?
 *   C. orphans  — money at Paystack we never recorded, or recorded and
 *                 they never received.
 *
 * Any discrepancy is an admin task, never an automatic correction. Silently
 * "fixing" a ledger is how money goes missing undetected.
 */

import { add, toCedis, type Pesewas } from '../../../../libs/money/src/money.ts';

export interface PaystackSettlementRow {
  reference: string;
  amountPesewas: Pesewas;
  feePesewas: Pesewas;
  status: 'success' | 'failed' | 'reversed';
  settledAt: string;
}

export interface LedgerCaptureRow {
  reference: string;
  amountPesewas: Pesewas;
}

export type DiscrepancyKind =
  | 'internal_drift'
  | 'missing_in_ledger'
  | 'missing_at_paystack'
  | 'amount_mismatch'
  | 'unexpected_reversal';

export interface Discrepancy {
  kind: DiscrepancyKind;
  reference?: string;
  expected?: string;
  actual?: string;
  detail: string;
  /** Money at risk, for triage ordering. */
  amountPesewas: Pesewas;
}

export interface ReconciliationReport {
  date: string;
  paystackCount: number;
  ledgerCount: number;
  paystackTotal: Pesewas;
  ledgerTotal: Pesewas;
  feesTotal: Pesewas;
  internalDrift: Pesewas;
  discrepancies: Discrepancy[];
  clean: boolean;
}

export function reconcile(input: {
  date: string;
  paystackRows: PaystackSettlementRow[];
  ledgerRows: LedgerCaptureRow[];
  /** From the `ledger_global_check` view: debits − credits. Must be zero. */
  internalDrift: Pesewas;
}): ReconciliationReport {
  const discrepancies: Discrepancy[] = [];

  // A. internal consistency
  if (input.internalDrift !== 0n) {
    discrepancies.push({
      kind: 'internal_drift',
      detail: `ledger debits and credits differ by ${toCedis(input.internalDrift)} — halt payouts`,
      amountPesewas: input.internalDrift < 0n ? -input.internalDrift : input.internalDrift,
    });
  }

  const successful = input.paystackRows.filter((r) => r.status === 'success');
  const byRefPaystack = new Map(successful.map((r) => [r.reference, r]));
  const byRefLedger = new Map(input.ledgerRows.map((r) => [r.reference, r]));

  // B/C. two-way match
  for (const [ref, ps] of byRefPaystack) {
    const led = byRefLedger.get(ref);
    if (!led) {
      discrepancies.push({
        kind: 'missing_in_ledger',
        reference: ref,
        detail: `Paystack settled ${toCedis(ps.amountPesewas)} that we never recorded`,
        amountPesewas: ps.amountPesewas,
      });
      continue;
    }
    if (led.amountPesewas !== ps.amountPesewas) {
      discrepancies.push({
        kind: 'amount_mismatch',
        reference: ref,
        expected: toCedis(ps.amountPesewas),
        actual: toCedis(led.amountPesewas),
        detail: `amount differs for ${ref}`,
        amountPesewas: absDiff(ps.amountPesewas, led.amountPesewas),
      });
    }
  }

  for (const [ref, led] of byRefLedger) {
    if (!byRefPaystack.has(ref)) {
      const reversed = input.paystackRows.find((r) => r.reference === ref && r.status !== 'success');
      discrepancies.push({
        kind: reversed ? 'unexpected_reversal' : 'missing_at_paystack',
        reference: ref,
        detail: reversed
          ? `we captured ${toCedis(led.amountPesewas)} but Paystack reports ${reversed.status}`
          : `we captured ${toCedis(led.amountPesewas)} with no matching Paystack settlement`,
        amountPesewas: led.amountPesewas,
      });
    }
  }

  const paystackTotal = successful.length ? add(...successful.map((r) => r.amountPesewas)) : 0n;
  const ledgerTotal = input.ledgerRows.length ? add(...input.ledgerRows.map((r) => r.amountPesewas)) : 0n;
  const feesTotal = successful.length ? add(...successful.map((r) => r.feePesewas)) : 0n;

  return {
    date: input.date,
    paystackCount: successful.length,
    ledgerCount: input.ledgerRows.length,
    paystackTotal,
    ledgerTotal,
    feesTotal,
    internalDrift: input.internalDrift,
    discrepancies: discrepancies.sort((a, b) => (b.amountPesewas > a.amountPesewas ? 1 : -1)),
    clean: discrepancies.length === 0,
  };
}

function absDiff(a: Pesewas, b: Pesewas): Pesewas {
  const d = a - b;
  return d < 0n ? -d : d;
}

/**
 * Payouts must stop when the ledger is internally inconsistent or a large
 * sum is unexplained. Paying out on a broken ledger turns a reporting
 * problem into an unrecoverable cash loss.
 */
export const PAYOUT_HALT_THRESHOLD_PESEWAS = 50_000n; // GHS 500

export function shouldHaltPayouts(report: ReconciliationReport): { halt: boolean; reason?: string } {
  if (report.internalDrift !== 0n) {
    return { halt: true, reason: 'ledger is internally inconsistent' };
  }
  const atRisk = report.discrepancies.reduce((s, d) => s + d.amountPesewas, 0n);
  if (atRisk >= PAYOUT_HALT_THRESHOLD_PESEWAS) {
    return { halt: true, reason: `${toCedis(atRisk)} unreconciled` };
  }
  return { halt: false };
}
