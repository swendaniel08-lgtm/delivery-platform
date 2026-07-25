/**
 * Pharmacy prescription review. PDF §2 (Service 5), state machine B.
 *
 * A pharmacist reviews the uploaded prescription and either approves,
 * rejects, or proposes changes. The customer must accept any change.
 *
 * Safety rule that drives the design: a substitution or quantity change is
 * only ever a PROPOSAL until the customer accepts it. We never silently
 * alter what someone is taking, and we never charge more than authorised.
 */

import { add, mul, pesewas, type Pesewas } from '../../../../libs/money/src/money.ts';
import { ValidationError, ConflictError } from '../../../../libs/platform/src/errors.ts';

export type ReviewDecision = 'approve' | 'reject' | 'modify';

export interface PrescriptionItem {
  itemId: string;
  name: string;
  quantity: number;
  unitPricePesewas: Pesewas;
  requiresPrescription: boolean;
  substitutionAllowed: boolean;
}

export interface ProposedChange {
  itemId: string;
  action: 'remove' | 'substitute' | 'reduce_quantity';
  /** For substitution. */
  replacementItemId?: string;
  replacementName?: string;
  replacementUnitPricePesewas?: Pesewas;
  /** For a quantity reduction. */
  newQuantity?: number;
  reason: string;
}

export interface ReviewInput {
  orderId: string;
  pharmacistId: string;
  decision: ReviewDecision;
  items: PrescriptionItem[];
  prescriptionUrl?: string;
  rejectionReason?: string;
  changes?: ProposedChange[];
}

export interface ReviewResult {
  decision: ReviewDecision;
  /** Event to feed the state machine. */
  event: 'prescription_approve' | 'prescription_reject' | 'prescription_modify';
  originalTotalPesewas: Pesewas;
  proposedTotalPesewas: Pesewas;
  /** Positive when the customer would pay less — refunded on acceptance. */
  refundDuePesewas: Pesewas;
  changeSummary: string[];
}

export class PrescriptionError extends ValidationError {}

function lineTotal(item: PrescriptionItem): Pesewas {
  return mul(item.unitPricePesewas, item.quantity);
}

function totalOf(items: PrescriptionItem[]): Pesewas {
  return items.length ? add(...items.map(lineTotal)) : 0n;
}

/**
 * Apply a pharmacist's review.
 *
 * Rejects the review itself (not the order) when it is internally invalid —
 * e.g. substituting an item the vendor marked non-substitutable, or a
 * modification that would somehow cost the customer MORE. A pharmacist may
 * not increase the bill; that would be a new order.
 */
export function reviewPrescription(input: ReviewInput): ReviewResult {
  const original = totalOf(input.items);

  if (input.decision === 'approve') {
    // Every prescription-only item must have had a prescription uploaded.
    const needsRx = input.items.some((i) => i.requiresPrescription);
    if (needsRx && !input.prescriptionUrl) {
      throw new PrescriptionError({
        prescription: ['cannot approve: no prescription document on file'],
      });
    }
    return {
      decision: 'approve',
      event: 'prescription_approve',
      originalTotalPesewas: original,
      proposedTotalPesewas: original,
      refundDuePesewas: 0n,
      changeSummary: [],
    };
  }

  if (input.decision === 'reject') {
    if (!input.rejectionReason?.trim()) {
      throw new PrescriptionError({ rejectionReason: ['is required when rejecting'] });
    }
    return {
      decision: 'reject',
      event: 'prescription_reject',
      originalTotalPesewas: original,
      proposedTotalPesewas: 0n,
      refundDuePesewas: original,   // full refund
      changeSummary: [input.rejectionReason.trim()],
    };
  }

  /* ---- modify ---- */
  const changes = input.changes ?? [];
  if (changes.length === 0) {
    throw new PrescriptionError({ changes: ['at least one change is required'] });
  }

  const byId = new Map(input.items.map((i) => [i.itemId, i]));
  const remaining: PrescriptionItem[] = input.items.map((i) => ({ ...i }));
  const summary: string[] = [];

  for (const change of changes) {
    const item = byId.get(change.itemId);
    if (!item) {
      throw new PrescriptionError({ changes: [`item ${change.itemId} is not in this order`] });
    }
    if (!change.reason?.trim()) {
      throw new PrescriptionError({ changes: [`a reason is required for ${item.name}`] });
    }
    const idx = remaining.findIndex((r) => r.itemId === change.itemId);

    switch (change.action) {
      case 'remove':
        remaining.splice(idx, 1);
        summary.push(`${item.name} removed — ${change.reason}`);
        break;

      case 'substitute': {
        if (!item.substitutionAllowed) {
          throw new ConflictError(`${item.name} may not be substituted without approval`);
        }
        if (!change.replacementItemId || change.replacementUnitPricePesewas === undefined) {
          throw new PrescriptionError({ changes: [`substitution for ${item.name} is incomplete`] });
        }
        remaining[idx] = {
          ...item,
          itemId: change.replacementItemId,
          name: change.replacementName ?? 'substitute',
          unitPricePesewas: change.replacementUnitPricePesewas,
        };
        summary.push(`${item.name} → ${change.replacementName ?? 'substitute'} — ${change.reason}`);
        break;
      }

      case 'reduce_quantity': {
        if (change.newQuantity === undefined || change.newQuantity < 1) {
          throw new PrescriptionError({ changes: [`invalid quantity for ${item.name}`] });
        }
        if (change.newQuantity >= item.quantity) {
          throw new PrescriptionError({
            changes: [`${item.name}: a pharmacist may only reduce quantity`],
          });
        }
        remaining[idx] = { ...item, quantity: change.newQuantity };
        summary.push(`${item.name} reduced to ${change.newQuantity} — ${change.reason}`);
        break;
      }
    }
  }

  const proposed = totalOf(remaining);
  if (proposed > original) {
    throw new ConflictError(
      'a prescription review may not increase the total; place a new order instead',
    );
  }

  return {
    decision: 'modify',
    event: 'prescription_modify',
    originalTotalPesewas: original,
    proposedTotalPesewas: proposed,
    refundDuePesewas: original - proposed,
    changeSummary: summary,
  };
}
