/**
 * Cash on Delivery. PDF §7, MASTER_PLAN §3.5.
 *
 * Closes issue #2. The spec booked the rider's cash obligation at `placed`,
 * but no cash exists until the customer hands it over. Booking early means
 * the ledger claims a rider owes money for an order that may never be
 * delivered. The obligation is created at DELIVERY, and only then.
 *
 * COD is the highest-risk flow on the platform: real banknotes, in the field,
 * held by contractors. Everything here is about making the float visible and
 * bounded.
 */

import { add, toCedis, type Pesewas } from '../../../../libs/money/src/money.ts';
import { ConflictError, ValidationError } from '../../../../libs/platform/src/errors.ts';
import type { LedgerService } from '../ledger.ts';

/* ------------------------------------------------------------------ */
/* Remittance thresholds (PDF §7)                                      */
/* ------------------------------------------------------------------ */

export const COD_LIMITS = {
  /** Above this, no new cash orders are offered. */
  blockNewOrdersPesewas: 30_000n,      // GHS 300
  /** Hours before the rider is warned. */
  warnAfterHours: 24,
  /** Hours before the rider is suspended from all new orders. */
  suspendAfterHours: 48,
  /** Customer strikes before COD privilege is revoked. */
  maxCustomerStrikes: 3,
  /** How long the rider must wait before declaring a customer unreachable. */
  refusalWaitMinutes: 5,
} as const;

export type CodRiderStatus = 'clear' | 'holding' | 'blocked' | 'warned' | 'suspended';

export interface CodRiderState {
  riderId: string;
  obligationPesewas: Pesewas;
  /** When the oldest unremitted collection happened. */
  oldestUnremittedAt: Date | null;
}

export interface CodStatusResult {
  status: CodRiderStatus;
  obligationPesewas: Pesewas;
  canAcceptCod: boolean;
  canAcceptAnyOrder: boolean;
  message?: string;
  hoursOutstanding?: number;
}

/**
 * A rider's standing. Note the escalation: holding cash is normal, holding
 * too much blocks *cash* orders only, but holding it too LONG blocks
 * everything — that is the difference between a limit and a debt.
 */
export function codStatus(state: CodRiderState, now: Date = new Date()): CodStatusResult {
  const owed = state.obligationPesewas;

  if (owed <= 0n) {
    return { status: 'clear', obligationPesewas: 0n, canAcceptCod: true, canAcceptAnyOrder: true };
  }

  const hours = state.oldestUnremittedAt
    ? (now.getTime() - state.oldestUnremittedAt.getTime()) / 3_600_000
    : 0;

  if (hours >= COD_LIMITS.suspendAfterHours) {
    return {
      status: 'suspended',
      obligationPesewas: owed,
      canAcceptCod: false,
      canAcceptAnyOrder: false,
      hoursOutstanding: hours,
      message: `Remit GHS ${toCedis(owed)} to resume taking orders`,
    };
  }
  if (hours >= COD_LIMITS.warnAfterHours) {
    return {
      status: 'warned',
      obligationPesewas: owed,
      canAcceptCod: owed <= COD_LIMITS.blockNewOrdersPesewas,
      canAcceptAnyOrder: true,
      hoursOutstanding: hours,
      message: `Please remit GHS ${toCedis(owed)} — your account will be suspended in ${
        Math.ceil(COD_LIMITS.suspendAfterHours - hours)} hours`,
    };
  }
  if (owed > COD_LIMITS.blockNewOrdersPesewas) {
    return {
      status: 'blocked',
      obligationPesewas: owed,
      canAcceptCod: false,
      canAcceptAnyOrder: true,
      hoursOutstanding: hours,
      message: `Remit some cash to accept cash orders again (holding GHS ${toCedis(owed)})`,
    };
  }
  return {
    status: 'holding',
    obligationPesewas: owed,
    canAcceptCod: true,
    canAcceptAnyOrder: true,
    hoursOutstanding: hours,
  };
}

/* ------------------------------------------------------------------ */
/* Delivery + remittance                                               */
/* ------------------------------------------------------------------ */

export interface CodDeliveryInput {
  orderId: string;
  riderId: string;
  vendorId: string;
  /** What the customer actually handed over. */
  collectedPesewas: Pesewas;
  /** What the order says is owed. */
  expectedPesewas: Pesewas;
  vendorAmount: Pesewas;
  riderAmount: Pesewas;
  platformAmount: Pesewas;
}

export class CodService {
  constructor(private readonly ledger: LedgerService) {}

  /**
   * Rider confirms cash collected at handover.
   *
   * Two ledger transactions, both at this moment:
   *   1. obligation  — the rider now holds our money
   *   2. settlement  — vendor/rider/platform earn out of cash holding
   */
  async recordDelivery(input: CodDeliveryInput): Promise<{ obligationRef: string; settlementRef: string }> {
    if (input.collectedPesewas !== input.expectedPesewas) {
      // Short payment is a dispute, not a silent write-off.
      throw new ConflictError(
        `cash mismatch: expected GHS ${toCedis(input.expectedPesewas)}, ` +
        `collected GHS ${toCedis(input.collectedPesewas)}`,
      );
    }
    const split = add(input.vendorAmount, input.riderAmount, input.platformAmount);
    if (split !== input.expectedPesewas) {
      throw new ConflictError(`settlement split ${split} does not equal total ${input.expectedPesewas}`);
    }

    const obligation = await this.ledger.codObligation(
      input.orderId, input.riderId, input.collectedPesewas,
    );
    const settlement = await this.ledger.settleCod({
      orderId: input.orderId,
      vendorId: input.vendorId,
      riderId: input.riderId,
      total: input.expectedPesewas,
      vendorAmount: input.vendorAmount,
      riderAmount: input.riderAmount,
      platformAmount: input.platformAmount,
    });

    return { obligationRef: obligation.reference, settlementRef: settlement.reference };
  }

  /** Rider pays the collected cash back in via mobile money. */
  async remit(input: {
    riderId: string; remittanceId: string;
    amountPesewas: Pesewas; currentObligation: Pesewas;
  }): Promise<{ reference: string; remainingPesewas: Pesewas }> {
    if (input.amountPesewas <= 0n) {
      throw new ValidationError({ amount: ['must be greater than zero'] });
    }
    if (input.amountPesewas > input.currentObligation) {
      throw new ValidationError({
        amount: [`you owe GHS ${toCedis(input.currentObligation)}, cannot remit more`],
      });
    }
    const posted = await this.ledger.codRemittance(
      input.riderId, input.remittanceId, input.amountPesewas,
    );
    return {
      reference: posted.reference,
      remainingPesewas: input.currentObligation - input.amountPesewas,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Customer refuses to pay (PDF §7)                                    */
/* ------------------------------------------------------------------ */

export type RefusalOutcome = 'wait' | 'return_to_vendor';

export interface RefusalState {
  waitStartedAt: Date;
  customerStrikes: number;
}

export interface RefusalDecision {
  outcome: RefusalOutcome;
  canReturnNow: boolean;
  secondsRemaining: number;
  newStrikeCount: number;
  codRevoked: boolean;
  message: string;
}

/**
 * The rider taps "customer unavailable / refused". They must wait 5 minutes,
 * enforced server-side — a client-side timer can be bypassed by restarting
 * the app, and "I waited" is exactly the claim we cannot verify later.
 */
export function evaluateRefusal(state: RefusalState, now: Date = new Date()): RefusalDecision {
  const elapsedSeconds = (now.getTime() - state.waitStartedAt.getTime()) / 1000;
  const requiredSeconds = COD_LIMITS.refusalWaitMinutes * 60;
  const remaining = Math.max(0, Math.ceil(requiredSeconds - elapsedSeconds));

  if (remaining > 0) {
    return {
      outcome: 'wait',
      canReturnNow: false,
      secondsRemaining: remaining,
      newStrikeCount: state.customerStrikes,
      codRevoked: false,
      message: `Keep trying to reach the customer — you can return the order in ${
        Math.ceil(remaining / 60)} minute(s)`,
    };
  }

  const strikes = state.customerStrikes + 1;
  return {
    outcome: 'return_to_vendor',
    canReturnNow: true,
    secondsRemaining: 0,
    newStrikeCount: strikes,
    codRevoked: strikes >= COD_LIMITS.maxCustomerStrikes,
    message: 'Return the order to the vendor. Support has been notified.',
  };
}

/* ------------------------------------------------------------------ */
/* Float reporting — admin view                                        */
/* ------------------------------------------------------------------ */

export interface RiderFloat {
  riderId: string;
  obligationPesewas: Pesewas;
  oldestUnremittedAt: Date | null;
}

export interface FloatReport {
  totalOutstandingPesewas: Pesewas;
  riderCount: number;
  blockedRiders: number;
  suspendedRiders: number;
  /** Worst offenders first — this is the collections work queue. */
  atRisk: Array<RiderFloat & { status: CodRiderStatus; hoursOutstanding: number }>;
}

export function floatReport(riders: RiderFloat[], now: Date = new Date()): FloatReport {
  const evaluated = riders.map((r) => {
    const s = codStatus(
      { riderId: r.riderId, obligationPesewas: r.obligationPesewas, oldestUnremittedAt: r.oldestUnremittedAt },
      now,
    );
    return { ...r, status: s.status, hoursOutstanding: s.hoursOutstanding ?? 0 };
  });

  return {
    totalOutstandingPesewas: riders.length ? add(...riders.map((r) => r.obligationPesewas)) : 0n,
    riderCount: riders.filter((r) => r.obligationPesewas > 0n).length,
    blockedRiders: evaluated.filter((r) => r.status === 'blocked').length,
    suspendedRiders: evaluated.filter((r) => r.status === 'suspended').length,
    atRisk: evaluated
      .filter((r) => r.status === 'blocked' || r.status === 'warned' || r.status === 'suspended')
      .sort((a, b) => (b.obligationPesewas > a.obligationPesewas ? 1 : -1)),
  };
}
