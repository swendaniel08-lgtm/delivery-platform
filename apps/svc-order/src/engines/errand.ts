/**
 * Errand and market-shopping-list settlement. PDF §2 (Services 7–8), §6, §3E.
 *
 * The customer pays an ESTIMATE up front. The rider then spends real money in
 * a real market where prices move. Afterwards we reconcile:
 *
 *   spent < estimate            → refund the difference to the wallet
 *   spent ≤ estimate + 15%      → charge the overage automatically
 *   spent > estimate + 15%      → the rider must request a top-up and the
 *                                 customer must approve it
 *
 * Ghana context: market prices genuinely fluctuate day to day, so the
 * tolerance band is not laziness — it avoids an approval prompt on every
 * single order while still capping the customer's exposure.
 */

import { add, bps, toCedis, type Pesewas } from '../../../../libs/money/src/money.ts';
import { ValidationError, ConflictError } from '../../../../libs/platform/src/errors.ts';

/** PDF §6 — 15% auto-approved overspend. */
export const ERRAND_TOLERANCE_BPS = 1500;

export interface ErrandSettlementInput {
  orderId: string;
  /** What the customer was charged for goods (excludes fees). */
  estimatedItemCostPesewas: Pesewas;
  /** What the rider actually spent, from receipts. */
  actualSpentPesewas: Pesewas;
  /** Receipt photos — required before any overage is charged. */
  receiptUrls: string[];
  /** Whether the customer already approved a top-up for this amount. */
  approvedTopUpPesewas?: Pesewas;
}

export type SettlementAction =
  | 'refund_difference'
  | 'charge_overage'
  | 'requires_topup_approval'
  | 'exact';

export interface ErrandSettlement {
  action: SettlementAction;
  /** Ceiling that can be charged without asking. */
  autoApproveCeilingPesewas: Pesewas;
  /** Refunded to the customer's wallet (positive when money comes back). */
  refundPesewas: Pesewas;
  /** Charged in addition to what was already taken. */
  additionalChargePesewas: Pesewas;
  /** Amount the rider must request approval for. */
  topUpRequestPesewas: Pesewas;
  message: string;
}

export function settleErrand(input: ErrandSettlementInput): ErrandSettlement {
  if (input.actualSpentPesewas < 0n) {
    throw new ValidationError({ actualSpent: ['cannot be negative'] });
  }

  const estimate = input.estimatedItemCostPesewas;
  const spent = input.actualSpentPesewas;
  const ceiling = add(estimate, bps(estimate, ERRAND_TOLERANCE_BPS));

  const zero = { refundPesewas: 0n, additionalChargePesewas: 0n, topUpRequestPesewas: 0n };

  if (spent === estimate) {
    return {
      action: 'exact', autoApproveCeilingPesewas: ceiling, ...zero,
      message: 'Spent exactly the estimate.',
    };
  }

  if (spent < estimate) {
    return {
      action: 'refund_difference',
      autoApproveCeilingPesewas: ceiling,
      refundPesewas: estimate - spent,
      additionalChargePesewas: 0n,
      topUpRequestPesewas: 0n,
      message: `GHS ${toCedis(estimate - spent)} refunded to your Besonc wallet.`,
    };
  }

  // Overspend: receipts are mandatory before we take more money.
  if (input.receiptUrls.length === 0) {
    throw new ConflictError('receipt photos are required before charging an overage');
  }

  const overage = spent - estimate;

  if (spent <= ceiling) {
    return {
      action: 'charge_overage',
      autoApproveCeilingPesewas: ceiling,
      refundPesewas: 0n,
      additionalChargePesewas: overage,
      topUpRequestPesewas: 0n,
      message: `GHS ${toCedis(overage)} charged — within the 15% price tolerance.`,
    };
  }

  // Beyond tolerance: only an approved top-up unlocks the extra charge.
  const approved = input.approvedTopUpPesewas ?? 0n;
  if (approved >= overage) {
    return {
      action: 'charge_overage',
      autoApproveCeilingPesewas: ceiling,
      refundPesewas: 0n,
      additionalChargePesewas: overage,
      topUpRequestPesewas: 0n,
      message: `GHS ${toCedis(overage)} charged as approved.`,
    };
  }

  return {
    action: 'requires_topup_approval',
    autoApproveCeilingPesewas: ceiling,
    refundPesewas: 0n,
    additionalChargePesewas: 0n,
    topUpRequestPesewas: overage - approved,
    message: `Spending is GHS ${toCedis(overage)} over the estimate. Customer approval is required.`,
  };
}

/* ------------------------------------------------------------------ */
/* Top-up requests                                                     */
/* ------------------------------------------------------------------ */

export interface TopUpRequest {
  orderId: string;
  requestedPesewas: Pesewas;
  reason: string;
  evidenceUrls: string[];
}

export function validateTopUpRequest(req: TopUpRequest): void {
  if (req.requestedPesewas <= 0n) {
    throw new ValidationError({ amount: ['must be greater than zero'] });
  }
  if (!req.reason?.trim()) {
    throw new ValidationError({ reason: ['tell the customer why more money is needed'] });
  }
  if (req.evidenceUrls.length === 0) {
    throw new ValidationError({ evidence: ['a photo of the item or price is required'] });
  }
}

/* ------------------------------------------------------------------ */
/* Item unavailable mid-errand (PDF §3E)                               */
/* ------------------------------------------------------------------ */

export interface UnavailableItemInput {
  itemDescription: string;
  substituteDescription?: string;
  substitutePricePesewas?: Pesewas;
  originalAllocationPesewas: Pesewas;
}

export interface UnavailableResolution {
  options: Array<'accept_substitute' | 'remove_item'>;
  /** Refunded if the customer drops the item. */
  refundIfRemovedPesewas: Pesewas;
  /** Extra cost if the substitute is dearer; negative means cheaper. */
  substituteDeltaPesewas: Pesewas | null;
}

export function resolveUnavailableItem(input: UnavailableItemInput): UnavailableResolution {
  const hasSubstitute =
    !!input.substituteDescription && input.substitutePricePesewas !== undefined;

  return {
    options: hasSubstitute ? ['accept_substitute', 'remove_item'] : ['remove_item'],
    refundIfRemovedPesewas: input.originalAllocationPesewas,
    substituteDeltaPesewas: hasSubstitute
      ? input.substitutePricePesewas! - input.originalAllocationPesewas
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* Market shopping list (PDF §2, Service 4 option B)                   */
/* ------------------------------------------------------------------ */

export interface ShoppingListLine {
  description: string;
  quantityHint: string;   // "1 big bowl", "5 pieces"
  estimatedPesewas: Pesewas;
}

export interface ShoppingList {
  targetMarket: string;
  lines: ShoppingListLine[];
  specialInstructions?: string;
}

export class ShoppingListError extends ValidationError {}

export function validateShoppingList(list: ShoppingList): { estimatedTotalPesewas: Pesewas } {
  if (!list.targetMarket?.trim()) {
    throw new ShoppingListError({ targetMarket: ['choose a market'] });
  }
  if (list.lines.length === 0) {
    throw new ShoppingListError({ lines: ['add at least one item'] });
  }
  if (list.lines.length > 30) {
    throw new ShoppingListError({ lines: ['maximum 30 items per shopping list'] });
  }
  for (const line of list.lines) {
    if (!line.description?.trim()) {
      throw new ShoppingListError({ lines: ['every item needs a description'] });
    }
    if (line.estimatedPesewas <= 0n) {
      throw new ShoppingListError({ lines: [`${line.description}: estimate must be positive`] });
    }
  }
  return {
    estimatedTotalPesewas: add(...list.lines.map((l) => l.estimatedPesewas)),
  };
}
