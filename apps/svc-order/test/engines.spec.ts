/** engines.spec — pharmacy, errand/market-list and laundry engines. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reviewPrescription, PrescriptionError, type PrescriptionItem } from '../src/engines/prescription.ts';
import {
  settleErrand, validateTopUpRequest, resolveUnavailableItem,
  validateShoppingList, ERRAND_TOLERANCE_BPS, ShoppingListError,
} from '../src/engines/errand.ts';
import {
  quoteLaundry, checkLaundrySettlement, canStartReturnLeg, processingOverdue,
} from '../src/engines/laundry.ts';
import { fromCedis, toCedis } from '../../../libs/money/src/money.ts';
import { ValidationError, ConflictError } from '../../../libs/platform/src/errors.ts';

/* ================================================================== */
/* Pharmacy                                                            */
/* ================================================================== */

const rxItems: PrescriptionItem[] = [
  { itemId: 'i1', name: 'Amoxicillin 500mg', quantity: 2, unitPricePesewas: fromCedis('25'),
    requiresPrescription: true, substitutionAllowed: true },
  { itemId: 'i2', name: 'Paracetamol 500mg', quantity: 1, unitPricePesewas: fromCedis('12'),
    requiresPrescription: false, substitutionAllowed: true },
  { itemId: 'i3', name: 'Insulin', quantity: 1, unitPricePesewas: fromCedis('80'),
    requiresPrescription: true, substitutionAllowed: false },
];

const base = { orderId: 'o1', pharmacistId: 'ph1', items: rxItems };

describe('prescription review (PDF §2, machine B)', () => {
  test('approval keeps the total unchanged', () => {
    const r = reviewPrescription({ ...base, decision: 'approve', prescriptionUrl: 'https://cdn/rx.jpg' });
    assert.equal(r.event, 'prescription_approve');
    assert.equal(toCedis(r.originalTotalPesewas), '142.00'); // 50 + 12 + 80
    assert.equal(r.refundDuePesewas, 0n);
  });

  test('cannot approve prescription items with no document on file', () => {
    assert.throws(() => reviewPrescription({ ...base, decision: 'approve' }), PrescriptionError);
  });

  test('rejection refunds everything and requires a reason', () => {
    const r = reviewPrescription({
      ...base, decision: 'reject', rejectionReason: 'prescription is illegible',
    });
    assert.equal(r.event, 'prescription_reject');
    assert.equal(toCedis(r.refundDuePesewas), '142.00');
    assert.throws(() => reviewPrescription({ ...base, decision: 'reject' }), PrescriptionError);
  });

  test('removing an item refunds the difference', () => {
    const r = reviewPrescription({
      ...base, decision: 'modify',
      changes: [{ itemId: 'i1', action: 'remove', reason: 'not indicated on the prescription' }],
    });
    assert.equal(r.event, 'prescription_modify');
    assert.equal(toCedis(r.proposedTotalPesewas), '92.00');
    assert.equal(toCedis(r.refundDuePesewas), '50.00');
    assert.match(r.changeSummary[0]!, /Amoxicillin.*removed/);
  });

  test('a non-substitutable medicine cannot be swapped', () => {
    assert.throws(() => reviewPrescription({
      ...base, decision: 'modify',
      changes: [{
        itemId: 'i3', action: 'substitute', replacementItemId: 'x',
        replacementName: 'Generic insulin', replacementUnitPricePesewas: fromCedis('60'),
        reason: 'cheaper',
      }],
    }), ConflictError);
  });

  test('a pharmacist may reduce quantity but never increase it', () => {
    const ok = reviewPrescription({
      ...base, decision: 'modify',
      changes: [{ itemId: 'i1', action: 'reduce_quantity', newQuantity: 1, reason: 'only 1 in stock' }],
    });
    assert.equal(toCedis(ok.refundDuePesewas), '25.00');

    assert.throws(() => reviewPrescription({
      ...base, decision: 'modify',
      changes: [{ itemId: 'i1', action: 'reduce_quantity', newQuantity: 5, reason: 'more' }],
    }), PrescriptionError);
  });

  test('a review may never increase the customer\'s bill', () => {
    assert.throws(() => reviewPrescription({
      ...base, decision: 'modify',
      changes: [{
        itemId: 'i2', action: 'substitute', replacementItemId: 'x',
        replacementName: 'Branded paracetamol', replacementUnitPricePesewas: fromCedis('500'),
        reason: 'out of generic',
      }],
    }), ConflictError);
  });

  test('every change needs a reason the customer can read', () => {
    assert.throws(() => reviewPrescription({
      ...base, decision: 'modify',
      changes: [{ itemId: 'i1', action: 'remove', reason: '  ' }],
    }), PrescriptionError);
  });
});

/* ================================================================== */
/* Errand                                                              */
/* ================================================================== */

describe('errand settlement (PDF §6)', () => {
  const estimate = fromCedis('100');
  const receipts = ['https://cdn/receipt1.jpg'];

  test('spending exactly the estimate settles cleanly', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: estimate, receiptUrls: receipts,
    });
    assert.equal(s.action, 'exact');
  });

  test('underspend refunds to the wallet', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('82'), receiptUrls: receipts,
    });
    assert.equal(s.action, 'refund_difference');
    assert.equal(toCedis(s.refundPesewas), '18.00');
  });

  test('overspend within 15% is charged automatically', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('112'), receiptUrls: receipts,
    });
    assert.equal(s.action, 'charge_overage');
    assert.equal(toCedis(s.additionalChargePesewas), '12.00');
    assert.equal(toCedis(s.autoApproveCeilingPesewas), '115.00');
  });

  test('exactly at the 15% ceiling is still automatic', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('115'), receiptUrls: receipts,
    });
    assert.equal(s.action, 'charge_overage');
  });

  test('beyond 15% requires customer approval', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('140'), receiptUrls: receipts,
    });
    assert.equal(s.action, 'requires_topup_approval');
    assert.equal(toCedis(s.topUpRequestPesewas), '40.00');
    assert.equal(s.additionalChargePesewas, 0n, 'nothing may be taken without consent');
  });

  test('an approved top-up unlocks the charge', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('140'), receiptUrls: receipts,
      approvedTopUpPesewas: fromCedis('40'),
    });
    assert.equal(s.action, 'charge_overage');
    assert.equal(toCedis(s.additionalChargePesewas), '40.00');
  });

  test('no receipts means no overage may be charged', () => {
    assert.throws(() => settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('110'), receiptUrls: [],
    }), ConflictError);
  });

  test('a refund needs no receipts — money only flows back', () => {
    const s = settleErrand({
      orderId: 'o', estimatedItemCostPesewas: estimate,
      actualSpentPesewas: fromCedis('90'), receiptUrls: [],
    });
    assert.equal(s.action, 'refund_difference');
  });

  test('the documented tolerance is what we enforce', () => {
    assert.equal(ERRAND_TOLERANCE_BPS, 1500);
  });
});

describe('top-up requests and unavailable items', () => {
  test('a top-up needs an amount, a reason and photo evidence', () => {
    assert.throws(() => validateTopUpRequest({
      orderId: 'o', requestedPesewas: 0n, reason: 'x', evidenceUrls: ['u'],
    }), ValidationError);
    assert.throws(() => validateTopUpRequest({
      orderId: 'o', requestedPesewas: fromCedis('10'), reason: '', evidenceUrls: ['u'],
    }), ValidationError);
    assert.throws(() => validateTopUpRequest({
      orderId: 'o', requestedPesewas: fromCedis('10'), reason: 'price up', evidenceUrls: [],
    }), ValidationError);
    validateTopUpRequest({
      orderId: 'o', requestedPesewas: fromCedis('10'), reason: 'price up', evidenceUrls: ['u'],
    });
  });

  test('an unavailable item offers a substitute or a refund', () => {
    const r = resolveUnavailableItem({
      itemDescription: 'Fresh tilapia',
      substituteDescription: 'Frozen tilapia',
      substitutePricePesewas: fromCedis('25'),
      originalAllocationPesewas: fromCedis('30'),
    });
    assert.deepEqual(r.options, ['accept_substitute', 'remove_item']);
    assert.equal(toCedis(r.refundIfRemovedPesewas), '30.00');
    assert.equal(toCedis(r.substituteDeltaPesewas!), '-5.00');
  });

  test('with no substitute available, removal is the only option', () => {
    const r = resolveUnavailableItem({
      itemDescription: 'Kontomire', originalAllocationPesewas: fromCedis('15'),
    });
    assert.deepEqual(r.options, ['remove_item']);
    assert.equal(r.substituteDeltaPesewas, null);
  });
});

describe('market shopping list (PDF §2 Service 4B)', () => {
  test('totals the estimates', () => {
    const { estimatedTotalPesewas } = validateShoppingList({
      targetMarket: 'Makola Market',
      lines: [
        { description: 'Tomatoes', quantityHint: '1 big bowl', estimatedPesewas: fromCedis('30') },
        { description: 'Onions', quantityHint: '1 bag', estimatedPesewas: fromCedis('25') },
      ],
    });
    assert.equal(toCedis(estimatedTotalPesewas), '55.00');
  });

  test('rejects an empty or oversized list, or a missing market', () => {
    assert.throws(() => validateShoppingList({ targetMarket: '', lines: [] }), ShoppingListError);
    assert.throws(() => validateShoppingList({ targetMarket: 'Makola', lines: [] }), ShoppingListError);
    assert.throws(() => validateShoppingList({
      targetMarket: 'Makola',
      lines: Array.from({ length: 31 }, (_, i) => ({
        description: `item${i}`, quantityHint: '1', estimatedPesewas: fromCedis('5'),
      })),
    }), ShoppingListError);
  });
});

/* ================================================================== */
/* Laundry                                                             */
/* ================================================================== */

describe('laundry — two legs (PDF §2 Service 6)', () => {
  const perItem = {
    model: 'per_item' as const,
    items: [
      { itemId: 'i1', name: 'Shirt', quantity: 5, unitPricePesewas: fromCedis('8') },
      { itemId: 'i2', name: 'Trousers', quantity: 2, unitPricePesewas: fromCedis('12') },
    ],
    processingHours: 24,
    pickupFeePesewas: fromCedis('8'),
    returnFeePesewas: fromCedis('8'),
  };

  test('quotes the service plus BOTH delivery fees up front', () => {
    const q = quoteLaundry(perItem);
    assert.equal(toCedis(q.serviceCostPesewas), '64.00');   // 5×8 + 2×12
    assert.equal(toCedis(q.totalDeliveryPesewas), '16.00'); // both trips
    assert.equal(q.legs.length, 2);
    assert.equal(q.legs[0]!.legType, 'customer_to_vendor');
    assert.equal(q.legs[1]!.legType, 'vendor_to_customer_return');
  });

  test('per-bag pricing works too', () => {
    const q = quoteLaundry({
      model: 'per_bag',
      bags: [{ size: 'medium', pricePesewas: fromCedis('80'), quantity: 1 }],
      processingHours: 48, pickupFeePesewas: fromCedis('8'), returnFeePesewas: fromCedis('8'),
    });
    assert.equal(toCedis(q.serviceCostPesewas), '80.00');
  });

  test('estimates when the laundry will be ready', () => {
    const q = quoteLaundry(perItem);
    const from = new Date(Date.UTC(2026, 6, 25, 10, 0, 0));
    assert.equal(q.estimatedReadyAt(from).toISOString(), '2026-07-26T10:00:00.000Z');
  });

  test('rejects an empty order or an absurd turnaround', () => {
    assert.throws(() => quoteLaundry({ ...perItem, items: [] }), ValidationError);
    assert.throws(() => quoteLaundry({ ...perItem, processingHours: 0 }), ValidationError);
  });
});

describe('laundry settlement across two legs', () => {
  test('the trip-1 rider is paid even while the vendor is still processing', () => {
    const c = checkLaundrySettlement([
      { sequence: 1, state: 'completed', riderId: 'rider-a', feePesewas: fromCedis('8') },
      { sequence: 2, state: 'pending', riderId: null, feePesewas: fromCedis('8') },
    ]);
    assert.equal(c.canSettle, false, 'the vendor is not paid yet');
    assert.equal(c.riderPayouts.length, 1);
    assert.equal(c.riderPayouts[0]!.riderId, 'rider-a');
  });

  test('the vendor is paid once the return leg completes', () => {
    const c = checkLaundrySettlement([
      { sequence: 1, state: 'completed', riderId: 'rider-a', feePesewas: fromCedis('8') },
      { sequence: 2, state: 'completed', riderId: 'rider-b', feePesewas: fromCedis('8') },
    ]);
    assert.equal(c.canSettle, true);
    assert.equal(c.riderPayouts.length, 2);
    assert.notEqual(c.riderPayouts[0]!.riderId, c.riderPayouts[1]!.riderId,
      'different riders may do each leg');
  });

  test('a one-leg laundry order is rejected', () => {
    const c = checkLaundrySettlement([
      { sequence: 1, state: 'completed', riderId: 'a', feePesewas: fromCedis('8') },
    ]);
    assert.equal(c.canSettle, false);
    assert.match(c.reason!, /two legs/);
  });
});

describe('laundry processing window', () => {
  test('the return leg cannot start before the vendor is done', () => {
    assert.equal(canStartReturnLeg({ vendorDoneProcessing: false, pickupLegState: 'completed' }).allowed, false);
    assert.equal(canStartReturnLeg({ vendorDoneProcessing: true, pickupLegState: 'picked_up' }).allowed, false);
    assert.equal(canStartReturnLeg({ vendorDoneProcessing: true, pickupLegState: 'completed' }).allowed, true);
  });

  test('an overdue vendor is surfaced, not ignored', () => {
    const started = new Date(Date.UTC(2026, 6, 25, 10, 0, 0));
    const ontime = processingOverdue({
      processingStartedAt: started, processingHours: 24,
      now: new Date(Date.UTC(2026, 6, 26, 8, 0, 0)),
    });
    assert.equal(ontime.overdue, false);

    const late = processingOverdue({
      processingStartedAt: started, processingHours: 24,
      now: new Date(Date.UTC(2026, 6, 26, 16, 0, 0)),
    });
    assert.equal(late.overdue, true);
    assert.equal(late.hoursLate, 6);
  });
});
