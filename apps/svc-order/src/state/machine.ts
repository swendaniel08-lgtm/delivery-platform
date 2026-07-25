/**
 * Order state machines. PDF §3 — the single source of truth for every order
 * lifecycle. Every notification, screen update and payment action is triggered
 * by a transition here.
 *
 * Implemented as an EXPLICIT transition table rather than booleans or
 * scattered if-statements: `(from, event, guard) → (to, effects)`.
 * Illegal transitions throw. The table is exhaustively tested and is the
 * contract all three Flutter apps render against.
 *
 * Machines: A standard catalogue · B pharmacy+prescription · C laundry (2 legs)
 *           D parcel · E errand
 */

import { ConflictError } from '../../../../libs/platform/src/errors.ts';

export type OrderState =
  // shared
  | 'pending_payment' | 'placed' | 'cancelled' | 'failed'
  // A: standard catalogue
  | 'vendor_accepted' | 'preparing' | 'ready_for_pickup'
  | 'rider_assigned' | 'rider_at_vendor' | 'picked_up' | 'in_transit'
  | 'arrived' | 'delivered'
  | 'vendor_rejected' | 'rider_unassigned'
  // B: pharmacy
  | 'prescription_review' | 'prescription_rejected' | 'prescription_modified'
  // C: laundry
  | 'rider_assigned_pickup' | 'rider_at_customer_pickup' | 'picked_up_from_customer'
  | 'delivered_to_vendor' | 'vendor_received' | 'processing' | 'vendor_done'
  | 'rider_assigned_return' | 'rider_at_vendor_return' | 'picked_up_from_vendor'
  | 'return_in_transit' | 'delivered_to_customer'
  // D: parcel
  | 'rider_at_pickup' | 'arrived_at_dropoff'
  // E: errand
  | 'rider_en_route_to_task' | 'task_in_progress' | 'items_purchased'
  | 'arrived_at_customer'
  | 'topup_requested' | 'topup_approved' | 'topup_rejected' | 'item_unavailable';

export type OrderEvent =
  | 'payment_confirmed' | 'payment_failed'
  | 'prescription_approve' | 'prescription_reject' | 'prescription_modify'
  | 'prescription_customer_accept' | 'prescription_customer_reject'
  | 'vendor_accept' | 'vendor_reject' | 'vendor_cancel'
  | 'vendor_start_preparing' | 'vendor_ready' | 'vendor_received_laundry'
  | 'vendor_done_processing'
  | 'rider_assign' | 'rider_arrive_vendor' | 'rider_pickup' | 'rider_arrive'
  | 'rider_deliver' | 'rider_cancel' | 'dispatch_failed'
  | 'rider_arrive_pickup' | 'rider_start_task' | 'rider_purchased'
  | 'rider_request_topup' | 'customer_approve_topup' | 'customer_reject_topup'
  | 'rider_report_unavailable'
  | 'customer_cancel' | 'admin_fail' | 'auto_timeout';

export type Machine = 'A' | 'B' | 'C' | 'D' | 'E';

/** Side effects a transition demands. Executed via the outbox, never inline. */
export interface Effects {
  events: string[];
  /** Dispatch should start looking for a rider. */
  startDispatch?: boolean;
  /** Settle the order in the ledger. */
  settle?: boolean;
  /** Refund; 'full' or a percentage of the item total. */
  refund?: 'full' | 'partial_50' | 'none';
  /** Start a durable timer, e.g. vendor accept window. */
  startTimer?: { name: string; seconds: number };
  cancelTimers?: boolean;
}

export interface Transition {
  from: OrderState;
  event: OrderEvent;
  to: OrderState;
  effects: Effects;
  /** Optional predicate, e.g. only for prescription orders. */
  guard?: string;
}

/** Vendor has 3 minutes to accept (PDF §11). */
export const VENDOR_ACCEPT_SECONDS = 180;

const t = (
  from: OrderState, event: OrderEvent, to: OrderState,
  effects: Effects, guard?: string,
): Transition => ({ from, event, to, effects, ...(guard ? { guard } : {}) });

/* ---------------- shared entry: payment ---------------- */

const PAYMENT: Transition[] = [
  t('pending_payment', 'payment_confirmed', 'placed', {
    events: ['order.placed'],
    startTimer: { name: 'vendor_accept', seconds: VENDOR_ACCEPT_SECONDS },
  }),
  t('pending_payment', 'payment_failed', 'failed', { events: ['order.payment_failed'] }),
  t('pending_payment', 'customer_cancel', 'cancelled', {
    events: ['order.cancelled'], refund: 'none',
  }),
];

/* ---------------- Machine A: standard catalogue ---------------- */

export const MACHINE_A: Transition[] = [
  ...PAYMENT,
  t('placed', 'vendor_accept', 'vendor_accepted', {
    events: ['order.vendor_accepted'], startDispatch: true, cancelTimers: true,
  }),
  t('placed', 'vendor_reject', 'vendor_rejected', {
    events: ['order.vendor_rejected'], refund: 'full', cancelTimers: true,
  }),
  // PDF §11: no response in 3 minutes = auto-reject, customer refunded
  t('placed', 'auto_timeout', 'vendor_rejected', {
    events: ['order.vendor_rejected', 'vendor.inaction_recorded'], refund: 'full',
  }),
  t('placed', 'customer_cancel', 'cancelled', {
    events: ['order.cancelled'], refund: 'full', cancelTimers: true,
  }),

  t('vendor_accepted', 'vendor_start_preparing', 'preparing', { events: ['order.preparing'] }),
  t('vendor_accepted', 'vendor_ready', 'ready_for_pickup', { events: ['order.ready_for_pickup'] }),
  t('vendor_accepted', 'vendor_cancel', 'cancelled', { events: ['order.cancelled'], refund: 'full' }),
  t('vendor_accepted', 'customer_cancel', 'cancelled', { events: ['order.cancelled'], refund: 'full' }),
  t('vendor_accepted', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),

  t('preparing', 'vendor_ready', 'ready_for_pickup', { events: ['order.ready_for_pickup'] }),
  t('preparing', 'vendor_cancel', 'cancelled', { events: ['order.cancelled'], refund: 'full' }),
  // PDF §8: cancelling during preparation costs the customer 50%
  t('preparing', 'customer_cancel', 'cancelled', { events: ['order.cancelled'], refund: 'partial_50' }),
  t('preparing', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),

  t('ready_for_pickup', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),
  t('ready_for_pickup', 'dispatch_failed', 'rider_unassigned', {
    events: ['dispatch.assignment.failed'], startDispatch: true,
  }),

  t('rider_assigned', 'rider_arrive_vendor', 'rider_at_vendor', { events: ['order.rider_at_vendor'] }),
  t('rider_assigned', 'rider_cancel', 'rider_unassigned', {
    events: ['dispatch.rider.cancelled'], startDispatch: true,
  }),
  t('rider_unassigned', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),
  t('rider_unassigned', 'dispatch_failed', 'failed', { events: ['order.failed'], refund: 'full' }),

  t('rider_at_vendor', 'rider_pickup', 'picked_up', {
    events: ['order.picked_up', 'tracking.start'],
  }),
  t('picked_up', 'rider_arrive', 'arrived', { events: ['order.arrived'] }),
  // in_transit is automatic after pickup; modelled so the UI can show it
  t('picked_up', 'rider_deliver', 'delivered', { events: ['order.delivered'], settle: true }),
  t('arrived', 'rider_deliver', 'delivered', { events: ['order.delivered'], settle: true }),

  t('placed', 'admin_fail', 'failed', { events: ['order.failed'], refund: 'full' }),
  t('vendor_accepted', 'admin_fail', 'failed', { events: ['order.failed'], refund: 'full' }),
];

/* ---------------- Machine B: pharmacy with prescription ---------------- */

export const MACHINE_B: Transition[] = [
  t('pending_payment', 'payment_confirmed', 'prescription_review', {
    events: ['order.placed', 'order.prescription.review_required'],
  }),
  t('pending_payment', 'payment_failed', 'failed', { events: ['order.payment_failed'] }),

  t('prescription_review', 'prescription_approve', 'vendor_accepted', {
    events: ['order.prescription.reviewed', 'order.vendor_accepted'], startDispatch: true,
  }),
  t('prescription_review', 'prescription_reject', 'prescription_rejected', {
    events: ['order.prescription.reviewed', 'order.cancelled'], refund: 'full',
  }),
  t('prescription_review', 'prescription_modify', 'prescription_modified', {
    events: ['order.prescription.modified'],
  }),
  t('prescription_modified', 'prescription_customer_accept', 'vendor_accepted', {
    events: ['order.vendor_accepted'], startDispatch: true,
  }),
  t('prescription_modified', 'prescription_customer_reject', 'cancelled', {
    events: ['order.cancelled'], refund: 'full',
  }),
  // from vendor_accepted onward, identical to machine A
  ...MACHINE_A.filter((x) =>
    !['pending_payment', 'placed'].includes(x.from) && x.from !== 'prescription_review'),
];

/* ---------------- Machine C: laundry, two legs ---------------- */

export const MACHINE_C: Transition[] = [
  ...PAYMENT,
  t('placed', 'vendor_accept', 'vendor_accepted', {
    events: ['order.vendor_accepted'], startDispatch: true, cancelTimers: true,
  }),
  t('placed', 'vendor_reject', 'vendor_rejected', { events: ['order.vendor_rejected'], refund: 'full' }),
  t('placed', 'auto_timeout', 'vendor_rejected', { events: ['order.vendor_rejected'], refund: 'full' }),

  // TRIP 1 — collect from customer, deliver to vendor
  t('vendor_accepted', 'rider_assign', 'rider_assigned_pickup', { events: ['order.leg.assigned'] }),
  t('rider_assigned_pickup', 'rider_arrive_pickup', 'rider_at_customer_pickup', {
    events: ['order.rider_at_customer'],
  }),
  t('rider_at_customer_pickup', 'rider_pickup', 'picked_up_from_customer', {
    events: ['order.picked_up', 'tracking.start'],
  }),
  t('picked_up_from_customer', 'rider_deliver', 'delivered_to_vendor', {
    events: ['order.leg.completed'],
  }),
  t('delivered_to_vendor', 'vendor_received_laundry', 'vendor_received', {
    events: ['order.vendor_received'],
  }),
  t('vendor_received', 'vendor_start_preparing', 'processing', { events: ['order.processing'] }),

  // TRIP 2 — return to customer (hours or days later)
  t('processing', 'vendor_done_processing', 'vendor_done', {
    events: ['order.vendor_done'], startDispatch: true,
  }),
  t('vendor_done', 'rider_assign', 'rider_assigned_return', { events: ['order.leg.assigned'] }),
  t('rider_assigned_return', 'rider_arrive_vendor', 'rider_at_vendor_return', {
    events: ['order.rider_at_vendor'],
  }),
  t('rider_at_vendor_return', 'rider_pickup', 'picked_up_from_vendor', {
    events: ['order.picked_up', 'tracking.start'],
  }),
  t('picked_up_from_vendor', 'rider_arrive', 'return_in_transit', { events: ['order.in_transit'] }),
  t('picked_up_from_vendor', 'rider_deliver', 'delivered_to_customer', {
    events: ['order.delivered', 'order.leg.completed'], settle: true,
  }),
  t('return_in_transit', 'rider_deliver', 'delivered_to_customer', {
    events: ['order.delivered', 'order.leg.completed'], settle: true,
  }),
];

/* ---------------- Machine D: parcel ---------------- */

export const MACHINE_D: Transition[] = [
  // No vendor — dispatch starts the moment payment clears
  t('pending_payment', 'payment_confirmed', 'placed', {
    events: ['order.placed'], startDispatch: true,
  }),
  t('pending_payment', 'payment_failed', 'failed', { events: ['order.payment_failed'] }),
  t('placed', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),
  t('placed', 'customer_cancel', 'cancelled', { events: ['order.cancelled'], refund: 'full' }),
  t('placed', 'dispatch_failed', 'rider_unassigned', {
    events: ['dispatch.assignment.failed'], startDispatch: true,
  }),
  t('rider_unassigned', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),
  t('rider_unassigned', 'dispatch_failed', 'failed', { events: ['order.failed'], refund: 'full' }),
  t('rider_assigned', 'rider_arrive_pickup', 'rider_at_pickup', { events: ['order.rider_at_pickup'] }),
  t('rider_assigned', 'rider_cancel', 'rider_unassigned', {
    events: ['dispatch.rider.cancelled'], startDispatch: true,
  }),
  t('rider_at_pickup', 'rider_pickup', 'picked_up', {
    events: ['order.picked_up', 'tracking.start', 'messaging.recipient_sms'],
  }),
  t('picked_up', 'rider_arrive', 'arrived_at_dropoff', { events: ['order.arrived'] }),
  t('arrived_at_dropoff', 'rider_deliver', 'delivered', { events: ['order.delivered'], settle: true }),
  t('picked_up', 'rider_deliver', 'delivered', { events: ['order.delivered'], settle: true }),
];

/* ---------------- Machine E: errand ---------------- */

export const MACHINE_E: Transition[] = [
  t('pending_payment', 'payment_confirmed', 'placed', {
    events: ['order.placed'], startDispatch: true,
  }),
  t('pending_payment', 'payment_failed', 'failed', { events: ['order.payment_failed'] }),
  t('placed', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),
  t('placed', 'customer_cancel', 'cancelled', { events: ['order.cancelled'], refund: 'full' }),
  t('rider_assigned', 'rider_start_task', 'rider_en_route_to_task', {
    events: ['order.rider_en_route'],
  }),
  t('rider_assigned', 'rider_cancel', 'rider_unassigned', {
    events: ['dispatch.rider.cancelled'], startDispatch: true,
  }),
  t('rider_unassigned', 'rider_assign', 'rider_assigned', { events: ['order.rider_assigned'] }),
  t('rider_en_route_to_task', 'rider_start_task', 'task_in_progress', {
    events: ['order.task_in_progress'],
  }),

  // top-up loop — actual cost exceeded the estimate by >15%
  t('task_in_progress', 'rider_request_topup', 'topup_requested', {
    events: ['order.topup_requested'],
  }),
  t('topup_requested', 'customer_approve_topup', 'task_in_progress', {
    events: ['order.topup_approved', 'payment.topup_charge'],
  }),
  t('topup_requested', 'customer_reject_topup', 'task_in_progress', {
    events: ['order.topup_rejected'],
  }),
  t('task_in_progress', 'rider_report_unavailable', 'item_unavailable', {
    events: ['order.item_unavailable'],
  }),
  t('item_unavailable', 'rider_start_task', 'task_in_progress', { events: ['order.task_resumed'] }),

  t('task_in_progress', 'rider_purchased', 'items_purchased', {
    events: ['order.items_purchased', 'tracking.start'],
  }),
  t('items_purchased', 'rider_arrive', 'arrived_at_customer', { events: ['order.arrived'] }),
  t('arrived_at_customer', 'rider_deliver', 'delivered', {
    events: ['order.delivered'], settle: true,
  }),
  t('items_purchased', 'rider_deliver', 'delivered', { events: ['order.delivered'], settle: true }),
];

export const MACHINES: Record<Machine, Transition[]> = {
  A: MACHINE_A, B: MACHINE_B, C: MACHINE_C, D: MACHINE_D, E: MACHINE_E,
};

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  'delivered', 'delivered_to_customer', 'cancelled', 'failed',
  'vendor_rejected', 'prescription_rejected',
]);

export function isTerminal(s: OrderState): boolean {
  return TERMINAL_STATES.has(s);
}

export class IllegalTransitionError extends ConflictError {
  constructor(machine: Machine, from: OrderState, event: OrderEvent) {
    super(`cannot ${event} from ${from} (machine ${machine})`);
  }
}

/** Look up a transition. Throws on anything not in the table. */
export function transition(machine: Machine, from: OrderState, event: OrderEvent): Transition {
  if (isTerminal(from)) {
    throw new IllegalTransitionError(machine, from, event);
  }
  const found = MACHINES[machine].find((x) => x.from === from && x.event === event);
  if (!found) throw new IllegalTransitionError(machine, from, event);
  return found;
}

export function can(machine: Machine, from: OrderState, event: OrderEvent): boolean {
  try { transition(machine, from, event); return true; } catch { return false; }
}

/** Events available from a state — drives which buttons each app renders. */
export function availableEvents(machine: Machine, from: OrderState): OrderEvent[] {
  if (isTerminal(from)) return [];
  return [...new Set(MACHINES[machine].filter((x) => x.from === from).map((x) => x.event))];
}

/** Machine selection for a service type. */
export function machineFor(
  service: string,
  opts: { hasPrescription?: boolean } = {},
): Machine {
  switch (service) {
    case 'parcel': return 'D';
    case 'errand': case 'market_list': return 'E';
    case 'laundry': return 'C';
    case 'pharmacy': return opts.hasPrescription ? 'B' : 'A';
    default: return 'A';
  }
}
