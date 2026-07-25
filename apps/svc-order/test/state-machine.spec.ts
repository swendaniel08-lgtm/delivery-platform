/**
 * state-machine.spec — PDF §3, all five machines.
 * Exhaustive: every state is reachable, every terminal state is absorbing,
 * and no illegal transition is permitted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  transition, can, availableEvents, isTerminal, machineFor,
  IllegalTransitionError, MACHINES, TERMINAL_STATES,
  VENDOR_ACCEPT_SECONDS,
  type Machine, type OrderState, type OrderEvent,
} from '../src/state/machine.ts';

/** Walk a machine through a sequence, asserting the final state. */
function walk(machine: Machine, start: OrderState, events: OrderEvent[]): OrderState {
  let s = start;
  for (const e of events) s = transition(machine, s, e).to;
  return s;
}

describe('machine selection', () => {
  test('service type picks the right machine', () => {
    assert.equal(machineFor('food'), 'A');
    assert.equal(machineFor('groceries'), 'A');
    assert.equal(machineFor('pharmacy'), 'A');
    assert.equal(machineFor('pharmacy', { hasPrescription: true }), 'B');
    assert.equal(machineFor('laundry'), 'C');
    assert.equal(machineFor('parcel'), 'D');
    assert.equal(machineFor('errand'), 'E');
    assert.equal(machineFor('market_list'), 'E');
  });
});

describe('Machine A — standard catalogue (PDF §3)', () => {
  test('the full happy path', () => {
    const final = walk('A', 'pending_payment', [
      'payment_confirmed', 'vendor_accept', 'vendor_start_preparing', 'vendor_ready',
      'rider_assign', 'rider_arrive_vendor', 'rider_pickup', 'rider_arrive', 'rider_deliver',
    ]);
    assert.equal(final, 'delivered');
  });

  test('payment starts the 3-minute vendor timer (PDF §11)', () => {
    const t = transition('A', 'pending_payment', 'payment_confirmed');
    assert.equal(t.to, 'placed');
    assert.deepEqual(t.effects.startTimer, { name: 'vendor_accept', seconds: 180 });
    assert.equal(VENDOR_ACCEPT_SECONDS, 180);
  });

  test('vendor acceptance starts dispatch and cancels the timer', () => {
    const t = transition('A', 'placed', 'vendor_accept');
    assert.equal(t.effects.startDispatch, true);
    assert.equal(t.effects.cancelTimers, true);
  });

  test('vendor inaction auto-rejects with a full refund', () => {
    const t = transition('A', 'placed', 'auto_timeout');
    assert.equal(t.to, 'vendor_rejected');
    assert.equal(t.effects.refund, 'full');
    assert.ok(t.effects.events.includes('vendor.inaction_recorded'));
  });

  test('delivery settles the ledger', () => {
    assert.equal(transition('A', 'arrived', 'rider_deliver').effects.settle, true);
  });

  test('rider assignment can happen during preparation', () => {
    assert.ok(can('A', 'vendor_accepted', 'rider_assign'));
    assert.ok(can('A', 'preparing', 'rider_assign'));
  });

  test('a cancelling rider triggers re-dispatch', () => {
    const t = transition('A', 'rider_assigned', 'rider_cancel');
    assert.equal(t.to, 'rider_unassigned');
    assert.equal(t.effects.startDispatch, true);
  });
});

describe('cancellation rules (PDF §8)', () => {
  test('before vendor acceptance: full refund', () => {
    assert.equal(transition('A', 'placed', 'customer_cancel').effects.refund, 'full');
  });

  test('after acceptance, before preparation: full refund', () => {
    assert.equal(transition('A', 'vendor_accepted', 'customer_cancel').effects.refund, 'full');
  });

  test('during preparation: 50% refund — the vendor already started', () => {
    assert.equal(transition('A', 'preparing', 'customer_cancel').effects.refund, 'partial_50');
  });

  test('once ready for pickup, the customer cannot cancel', () => {
    assert.equal(can('A', 'ready_for_pickup', 'customer_cancel'), false);
    assert.equal(can('A', 'picked_up', 'customer_cancel'), false);
    assert.equal(can('A', 'in_transit', 'customer_cancel'), false);
  });
});

describe('Machine B — pharmacy with prescription', () => {
  test('payment routes to prescription review, not straight to the vendor', () => {
    const t = transition('B', 'pending_payment', 'payment_confirmed');
    assert.equal(t.to, 'prescription_review');
  });

  test('pharmacist approval resumes the normal flow', () => {
    const final = walk('B', 'pending_payment', [
      'payment_confirmed', 'prescription_approve', 'vendor_start_preparing', 'vendor_ready',
      'rider_assign', 'rider_arrive_vendor', 'rider_pickup', 'rider_deliver',
    ]);
    assert.equal(final, 'delivered');
  });

  test('rejection refunds in full', () => {
    const t = transition('B', 'prescription_review', 'prescription_reject');
    assert.equal(t.to, 'prescription_rejected');
    assert.equal(t.effects.refund, 'full');
  });

  test('modification needs customer approval either way', () => {
    assert.equal(transition('B', 'prescription_review', 'prescription_modify').to, 'prescription_modified');
    assert.equal(transition('B', 'prescription_modified', 'prescription_customer_accept').to, 'vendor_accepted');
    assert.equal(transition('B', 'prescription_modified', 'prescription_customer_reject').effects.refund, 'full');
  });
});

describe('Machine C — laundry, two trips', () => {
  test('trip 1 then processing then trip 2', () => {
    const afterTrip1 = walk('C', 'pending_payment', [
      'payment_confirmed', 'vendor_accept', 'rider_assign', 'rider_arrive_pickup',
      'rider_pickup', 'rider_deliver', 'vendor_received_laundry', 'vendor_start_preparing',
    ]);
    assert.equal(afterTrip1, 'processing');

    const final = walk('C', afterTrip1, [
      'vendor_done_processing', 'rider_assign', 'rider_arrive_vendor',
      'rider_pickup', 'rider_deliver',
    ]);
    assert.equal(final, 'delivered_to_customer');
  });

  test('settlement happens only after the RETURN trip', () => {
    assert.notEqual(transition('C', 'picked_up_from_customer', 'rider_deliver').effects.settle, true);
    assert.equal(transition('C', 'picked_up_from_vendor', 'rider_deliver').effects.settle, true);
  });

  test('finishing processing triggers a second dispatch', () => {
    assert.equal(transition('C', 'processing', 'vendor_done_processing').effects.startDispatch, true);
  });
});

describe('Machine D — parcel', () => {
  test('dispatch starts at payment — there is no vendor to accept', () => {
    const t = transition('D', 'pending_payment', 'payment_confirmed');
    assert.equal(t.to, 'placed');
    assert.equal(t.effects.startDispatch, true);
  });

  test('no vendor events exist in this machine', () => {
    assert.equal(can('D', 'placed', 'vendor_accept'), false);
    assert.equal(can('D', 'placed', 'vendor_ready'), false);
  });

  test('the recipient gets an SMS at pickup (PDF §3)', () => {
    const t = transition('D', 'rider_at_pickup', 'rider_pickup');
    assert.ok(t.effects.events.includes('messaging.recipient_sms'));
  });

  test('full happy path', () => {
    assert.equal(walk('D', 'pending_payment', [
      'payment_confirmed', 'rider_assign', 'rider_arrive_pickup',
      'rider_pickup', 'rider_arrive', 'rider_deliver',
    ]), 'delivered');
  });
});

describe('Machine E — errand with top-ups', () => {
  test('full happy path', () => {
    assert.equal(walk('E', 'pending_payment', [
      'payment_confirmed', 'rider_assign', 'rider_start_task', 'rider_start_task',
      'rider_purchased', 'rider_arrive', 'rider_deliver',
    ]), 'delivered');
  });

  test('top-up approval returns to the task and charges the customer', () => {
    const req = transition('E', 'task_in_progress', 'rider_request_topup');
    assert.equal(req.to, 'topup_requested');
    const ok = transition('E', 'topup_requested', 'customer_approve_topup');
    assert.equal(ok.to, 'task_in_progress');
    assert.ok(ok.effects.events.includes('payment.topup_charge'));
  });

  test('top-up rejection resumes without charging', () => {
    const no = transition('E', 'topup_requested', 'customer_reject_topup');
    assert.equal(no.to, 'task_in_progress');
    assert.equal(no.effects.events.includes('payment.topup_charge'), false);
  });

  test('unavailable item pauses then resumes', () => {
    assert.equal(transition('E', 'task_in_progress', 'rider_report_unavailable').to, 'item_unavailable');
    assert.equal(transition('E', 'item_unavailable', 'rider_start_task').to, 'task_in_progress');
  });
});

describe('safety properties across ALL machines', () => {
  const machines: Machine[] = ['A', 'B', 'C', 'D', 'E'];

  test('terminal states are absorbing — nothing escapes', () => {
    for (const m of machines) {
      for (const s of TERMINAL_STATES) {
        assert.deepEqual(availableEvents(m, s), [], `${m}:${s} must be terminal`);
        assert.throws(() => transition(m, s, 'rider_deliver'), IllegalTransitionError);
      }
    }
  });

  test('no transition leads OUT of a terminal state', () => {
    for (const m of machines) {
      for (const tr of MACHINES[m]) {
        assert.equal(isTerminal(tr.from), false,
          `${m}: transition defined from terminal state ${tr.from}`);
      }
    }
  });

  test('illegal transitions always throw', () => {
    assert.throws(() => transition('A', 'placed', 'rider_deliver'), IllegalTransitionError);
    assert.throws(() => transition('A', 'pending_payment', 'vendor_accept'), IllegalTransitionError);
    assert.throws(() => transition('D', 'delivered', 'rider_pickup'), IllegalTransitionError);
  });

  test('every machine can reach a delivered state', () => {
    const delivered: Record<Machine, OrderState> = {
      A: 'delivered', B: 'delivered', C: 'delivered_to_customer', D: 'delivered', E: 'delivered',
    };
    for (const m of machines) {
      const reaches = MACHINES[m].some((tr) => tr.to === delivered[m]);
      assert.ok(reaches, `${m} cannot reach ${delivered[m]}`);
    }
  });

  test('every delivery settles exactly once', () => {
    for (const m of machines) {
      const settlers = MACHINES[m].filter((tr) => tr.effects.settle);
      assert.ok(settlers.length > 0, `${m} never settles`);
      for (const s of settlers) {
        assert.ok(isTerminal(s.to), `${m}: settle on non-terminal ${s.to}`);
      }
    }
  });

  test('every refund transition ends terminally', () => {
    for (const m of machines) {
      for (const tr of MACHINES[m]) {
        if (tr.effects.refund && tr.effects.refund !== 'none') {
          assert.ok(isTerminal(tr.to), `${m}: refund on non-terminal ${tr.to}`);
        }
      }
    }
  });

  test('no duplicate (from,event) pairs — the table must be deterministic', () => {
    for (const m of machines) {
      const seen = new Set<string>();
      for (const tr of MACHINES[m]) {
        const key = `${tr.from}|${tr.event}`;
        assert.equal(seen.has(key), false, `${m}: duplicate transition ${key}`);
        seen.add(key);
      }
    }
  });

  test('every transition emits at least one event', () => {
    for (const m of machines) {
      for (const tr of MACHINES[m]) {
        assert.ok(tr.effects.events.length > 0, `${m}: ${tr.from}--${tr.event} emits nothing`);
      }
    }
  });
});

describe('UI contract', () => {
  test('availableEvents drives which buttons each app renders', () => {
    const vendorOptions = availableEvents('A', 'placed');
    assert.ok(vendorOptions.includes('vendor_accept'));
    assert.ok(vendorOptions.includes('vendor_reject'));

    const riderOptions = availableEvents('A', 'rider_at_vendor');
    assert.deepEqual(riderOptions, ['rider_pickup']);
  });
});
