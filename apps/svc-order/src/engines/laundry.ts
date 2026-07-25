/**
 * Laundry — the only service with TWO delivery legs. PDF §2 (Service 6),
 * state machine C.
 *
 *   Trip 1: rider collects from customer → delivers to vendor
 *   ...vendor processes (hours or days)...
 *   Trip 2: (possibly a DIFFERENT rider) collects from vendor → returns
 *
 * Both delivery fees are quoted and charged up front so the customer sees
 * the full cost at checkout, but the vendor is only paid after the return
 * leg completes — otherwise we would settle for a service that has not been
 * rendered yet.
 */

import { add, mul, pesewas, type Pesewas } from '../../../../libs/money/src/money.ts';
import { ValidationError, ConflictError } from '../../../../libs/platform/src/errors.ts';

export type LaundryPricingModel = 'per_item' | 'per_bag';

export interface LaundryItemLine {
  itemId: string;
  name: string;          // "Shirt", "Trousers"
  quantity: number;
  unitPricePesewas: Pesewas;
}

export interface LaundryBagLine {
  size: 'small' | 'medium' | 'large';
  pricePesewas: Pesewas;
  quantity: number;
}

export interface LaundryOrderInput {
  model: LaundryPricingModel;
  items?: LaundryItemLine[];
  bags?: LaundryBagLine[];
  /** Vendor's stated turnaround, e.g. 24 or 48 hours. */
  processingHours: number;
  pickupFeePesewas: Pesewas;
  returnFeePesewas: Pesewas;
}

export interface LaundryQuote {
  serviceCostPesewas: Pesewas;
  pickupFeePesewas: Pesewas;
  returnFeePesewas: Pesewas;
  totalDeliveryPesewas: Pesewas;
  /** Both trips are visible at checkout — no surprise second fee. */
  legs: Array<{ sequence: 1 | 2; legType: string; feePesewas: Pesewas }>;
  estimatedReadyAt: (from: Date) => Date;
}

export function quoteLaundry(input: LaundryOrderInput): LaundryQuote {
  if (input.processingHours < 1 || input.processingHours > 24 * 14) {
    throw new ValidationError({ processingHours: ['must be between 1 hour and 14 days'] });
  }

  let serviceCost: Pesewas;
  if (input.model === 'per_item') {
    if (!input.items?.length) {
      throw new ValidationError({ items: ['add at least one garment'] });
    }
    for (const i of input.items) {
      if (!Number.isInteger(i.quantity) || i.quantity < 1) {
        throw new ValidationError({ items: [`${i.name}: quantity must be a positive integer`] });
      }
    }
    serviceCost = add(...input.items.map((i) => mul(i.unitPricePesewas, i.quantity)));
  } else {
    if (!input.bags?.length) {
      throw new ValidationError({ bags: ['choose at least one bag'] });
    }
    serviceCost = add(...input.bags.map((b) => mul(b.pricePesewas, b.quantity)));
  }

  return {
    serviceCostPesewas: serviceCost,
    pickupFeePesewas: input.pickupFeePesewas,
    returnFeePesewas: input.returnFeePesewas,
    totalDeliveryPesewas: add(input.pickupFeePesewas, input.returnFeePesewas),
    legs: [
      { sequence: 1, legType: 'customer_to_vendor', feePesewas: input.pickupFeePesewas },
      { sequence: 2, legType: 'vendor_to_customer_return', feePesewas: input.returnFeePesewas },
    ],
    estimatedReadyAt: (from: Date) =>
      new Date(from.getTime() + input.processingHours * 3_600_000),
  };
}

/* ------------------------------------------------------------------ */
/* Settlement across two legs                                          */
/* ------------------------------------------------------------------ */

export interface LaundryLegState {
  sequence: 1 | 2;
  state: string;
  riderId: string | null;
  feePesewas: Pesewas;
}

export interface LaundrySettlementCheck {
  canSettle: boolean;
  reason?: string;
  /** Rider fees are paid per leg, to whoever actually did that leg. */
  riderPayouts: Array<{ riderId: string; amountPesewas: Pesewas }>;
}

/**
 * The vendor is paid only once BOTH legs are complete.
 *
 * Riders, though, are paid per leg — trip 1 and trip 2 may be different
 * people, and the trip-1 rider must not wait days for the vendor to finish
 * processing before being paid for work already done.
 */
export function checkLaundrySettlement(legs: LaundryLegState[]): LaundrySettlementCheck {
  const byNumber = new Map(legs.map((l) => [l.sequence, l]));
  const pickup = byNumber.get(1);
  const ret = byNumber.get(2);

  if (!pickup || !ret) {
    return { canSettle: false, reason: 'a laundry order must have two legs', riderPayouts: [] };
  }

  const payouts: Array<{ riderId: string; amountPesewas: Pesewas }> = [];
  for (const leg of [pickup, ret]) {
    if (leg.state === 'completed' && leg.riderId) {
      payouts.push({ riderId: leg.riderId, amountPesewas: leg.feePesewas });
    }
  }

  if (ret.state !== 'completed') {
    return {
      canSettle: false,
      reason: 'the vendor is paid after the clean laundry is returned',
      riderPayouts: payouts,   // trip-1 rider is still paid
    };
  }

  return { canSettle: true, riderPayouts: payouts };
}

/** A rider may not collect from the vendor before processing is finished. */
export function canStartReturnLeg(input: {
  vendorDoneProcessing: boolean;
  pickupLegState: string;
}): { allowed: boolean; reason?: string } {
  if (input.pickupLegState !== 'completed') {
    return { allowed: false, reason: 'the laundry has not reached the vendor yet' };
  }
  if (!input.vendorDoneProcessing) {
    return { allowed: false, reason: 'the vendor has not finished processing' };
  }
  return { allowed: true };
}

/** Processing overrun — surfaces in the admin queue rather than silently. */
export function processingOverdue(input: {
  processingStartedAt: Date;
  processingHours: number;
  now?: Date;
}): { overdue: boolean; hoursLate: number } {
  const now = input.now ?? new Date();
  const due = input.processingStartedAt.getTime() + input.processingHours * 3_600_000;
  const lateMs = now.getTime() - due;
  return {
    overdue: lateMs > 0,
    hoursLate: lateMs > 0 ? lateMs / 3_600_000 : 0,
  };
}
