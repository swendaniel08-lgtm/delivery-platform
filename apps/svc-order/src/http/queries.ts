/**
 * order-svc read model.
 *
 * The write path (`order.module.ts`) is about correctness under
 * concurrency. This file is about answering the three questions the apps
 * actually ask, in one round trip each:
 *
 *   • customer: "what have I got in flight?"
 *   • vendor:   "what is in my kitchen queue?"
 *   • rider:    "what am I delivering right now?"
 *
 * Each returns the shape the BFF forwards to the app, assembled with JSON
 * aggregation rather than the N+1 a naive mapping would produce — the
 * vendor queue is polled every 10 seconds by every open store.
 */

import type { Pool } from 'pg';
import { NotFoundError } from '../../../../libs/platform/src/errors.ts';

/** States an order can be in while it still needs someone's attention. */
export const ACTIVE_ORDER_STATES = [
  'pending_payment', 'placed', 'prescription_review', 'vendor_accepted',
  'preparing', 'ready_for_pickup', 'rider_assigned', 'rider_at_vendor',
  'picked_up', 'in_transit', 'arrived',
  'vendor_received', 'processing', 'vendor_done',
];

/** Leg states where a rider is still holding the job. */
export const ACTIVE_LEG_STATES = [
  'assigned', 'rider_at_pickup', 'picked_up', 'in_transit', 'arrived',
];

/**
 * Line items, aggregated as JSON.
 *
 * `addon_names` and `variant_names` are denormalised onto the order at
 * checkout on purpose: a vendor editing their menu tomorrow must not change
 * what last night's kitchen ticket said.
 */
const LINES_JSON = `
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'name', oi.name,
      'quantity', oi.quantity,
      'addonNames', oi.addon_names,
      'variantNames', oi.variant_names,
      'note', oi.note
    ) ORDER BY oi.id)
    FROM order_items oi WHERE oi.order_id = o.id
  ), '[]'::jsonb) AS lines`;

export interface OrderListRow {
  id: string;
  humanRef: string;
  state: string;
  service: string;
  storeId: string | null;
  customerId: string;
  itemTotalPesewas: string;
  deliveryFeePesewas: string;
  serviceFeePesewas: string;
  totalPesewas: string;
  vendorAmountPesewas: string;
  paymentIntent: string;
  isCod: boolean;
  requiresPrescription: boolean;
  placedAt: string | null;
  createdAt: string;
  lines: Array<Record<string, unknown>>;
  riderName?: string | null;
}

function toListRow(r: any): OrderListRow {
  return {
    id: r.id,
    humanRef: r.human_ref,
    state: r.state,
    service: r.service,
    storeId: r.store_id,
    customerId: r.customer_id,
    // BIGINT arrives as a string from pg and must STAY a string: JSON has
    // no bigint and Number() silently loses precision above 2^53.
    itemTotalPesewas: String(r.item_total_pesewas),
    deliveryFeePesewas: String(r.delivery_fee_pesewas),
    serviceFeePesewas: String(r.service_fee_pesewas),
    totalPesewas: String(r.total_pesewas),
    vendorAmountPesewas: String(r.vendor_amount_pesewas ?? '0'),
    paymentIntent: r.payment_intent,
    isCod: r.payment_intent === 'cod',
    requiresPrescription: r.requires_prescription ?? false,
    // ISO-8601 so the apps can compute their own countdowns. The vendor
    // accept timer is derived from placedAt on the device, which is why
    // this must never be a preformatted string.
    placedAt: r.placed_at ? new Date(r.placed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    lines: r.lines ?? [],
  };
}

/**
 * Cursors are opaque base64. Not for secrecy — anyone can decode it — but so
 * that clients cannot construct one by hand and depend on its shape, which
 * would freeze this pagination scheme forever.
 */
export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return Buffer.from(`${iso}|${id}`).toString('base64url');
}

export function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url')
      .toString('utf8').split('|');
    if (!createdAt || !id) return null;
    // A malformed cursor must not become a 500. Treat it as "start from the
    // beginning" — the worst case is the customer sees page one again.
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export class OrderQueries {
  constructor(private readonly pool: Pool) {}

  /**
   * A customer's orders. `active` filters to the ones still in flight.
   *
   * KEYSET pagination, not OFFSET. Two reasons, and the second is the one
   * that matters:
   *
   *   1. `OFFSET 200` makes Postgres walk and discard 200 rows every time.
   *   2. More importantly, OFFSET is WRONG here. This list is ordered by
   *      `created_at DESC`, and a customer placing a new order while
   *      scrolling their history shifts every row down by one — so page 2
   *      repeats the last item of page 1. A cursor anchored to the row you
   *      last saw cannot do that.
   *
   * The cursor is `(created_at, id)`. `created_at` alone is not unique:
   * two orders placed in the same millisecond would make the boundary
   * ambiguous and silently drop one.
   */
  async forCustomer(
    customerId: string,
    opts: {
      active?: boolean;
      limit?: number;
      /** Return orders strictly older than this. */
      before?: { createdAt: string; id: string };
    } = {},
  ): Promise<{ orders: OrderListRow[]; nextCursor: string | null }> {
    // Bounded regardless of what the caller asks for: an app that requests
    // 10,000 rows would be served them, on a Ghanaian mobile connection.
    //
    // The Number.isFinite guard is not defensive padding. `?limit=abc` gives
    // NaN, and clamp(NaN) is still NaN — which reaches Postgres as the string
    // "NaN" and 500s on a customer's history screen. Found by testing it.
    const asked = Number(opts.limit);
    const limit = Number.isFinite(asked)
      ? Math.min(Math.max(Math.trunc(asked), 1), 50)
      : 20;

    const r = await this.pool.query(
      `SELECT o.*, ${LINES_JSON},
              (SELECT dl.assigned_rider_id FROM delivery_legs dl
                WHERE dl.order_id = o.id AND dl.assigned_rider_id IS NOT NULL
                ORDER BY dl.sequence LIMIT 1) AS rider_id
         FROM orders o
        WHERE o.customer_id = $1
          AND ($2::boolean IS NOT TRUE OR o.state = ANY($3))
          AND ($4::timestamptz IS NULL
               OR (o.created_at, o.id) < ($4::timestamptz, $5::uuid))
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $6`,
      [
        customerId,
        opts.active ?? false,
        ACTIVE_ORDER_STATES,
        opts.before?.createdAt ?? null,
        opts.before?.id ?? null,
        // One extra row tells us whether another page exists without a
        // second COUNT query over the whole history.
        limit + 1,
      ],
    );

    const hasMore = r.rows.length > limit;
    const page = hasMore ? r.rows.slice(0, limit) : r.rows;
    const last = page[page.length - 1];

    return {
      orders: page.map(toListRow),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /**
   * A store's queue.
   *
   * `states` is required rather than optional: a vendor screen that
   * accidentally fetched every order ever placed would get slower every
   * week until it timed out.
   */
  async forStore(
    storeId: string, states: string[], opts: { limit?: number } = {},
  ): Promise<OrderListRow[]> {
    const r = await this.pool.query(
      `SELECT o.*, ${LINES_JSON}
         FROM orders o
        WHERE o.store_id = $1 AND o.state = ANY($2)
        ORDER BY o.placed_at NULLS LAST, o.created_at
        LIMIT $3`,
      [storeId, states, opts.limit ?? 100],
    );
    return r.rows.map(toListRow);
  }

  async byId(orderId: string): Promise<OrderListRow> {
    const r = await this.pool.query(
      `SELECT o.*, ${LINES_JSON} FROM orders o WHERE o.id = $1`, [orderId],
    );
    if (!r.rows[0]) throw new NotFoundError('Order');
    return toListRow(r.rows[0]);
  }

  /**
   * The rider's current job.
   *
   * A unique partial index guarantees at most one active leg per rider (no
   * batching at launch, PDF §12), so `LIMIT 1` is exact rather than a guess.
   */
  async activeLegForRider(riderId: string): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query(
      `SELECT dl.*, o.human_ref, o.service, o.payment_intent, o.total_pesewas,
              o.customer_id
         FROM delivery_legs dl
         JOIN orders o ON o.id = dl.order_id
        WHERE dl.assigned_rider_id = $1 AND dl.state = ANY($2)
        ORDER BY dl.sequence
        LIMIT 1`,
      [riderId, ACTIVE_LEG_STATES],
    );
    const l = r.rows[0];
    if (!l) return null;

    return {
      legId: l.id,
      orderId: l.order_id,
      humanRef: l.human_ref,
      state: l.state,
      service: l.service,
      sequence: l.sequence,
      legType: l.leg_type,
      pickup: {
        lat: Number(l.pickup_lat),
        lng: Number(l.pickup_lng),
        label: l.pickup_label ?? '',
      },
      dropoff: {
        lat: Number(l.dropoff_lat),
        lng: Number(l.dropoff_lng),
        label: l.dropoff_label ?? '',
      },
      feePesewas: String(l.fee_pesewas),
      isCod: l.payment_intent === 'cod',
      // Only a COD leg carries an amount to collect. Sending it otherwise
      // would prompt a rider to ask a prepaid customer for cash.
      ...(l.payment_intent === 'cod'
        ? { codAmountPesewas: String(l.total_pesewas) } : {}),
      assignedRiderId: l.assigned_rider_id,
    };
  }

  async legById(legId: string): Promise<Record<string, unknown>> {
    const r = await this.pool.query(
      `SELECT dl.*, o.human_ref, o.service, o.payment_intent
         FROM delivery_legs dl JOIN orders o ON o.id = dl.order_id
        WHERE dl.id = $1`, [legId],
    );
    if (!r.rows[0]) throw new NotFoundError('Assignment');
    return r.rows[0];
  }
}

/* ------------------------------------------------------------------ */
/* Leg transitions                                                     */
/* ------------------------------------------------------------------ */

/**
 * The rider's leg state machine.
 *
 * Separate from the ORDER machine because one order can have many legs
 * (laundry: collect → clean → return). The order advances when its legs do,
 * but they are not the same thing.
 */
export const LEG_TRANSITIONS: Record<string, { event: string; to: string }[]> = {
  assigned: [{ event: 'rider_arrive_pickup', to: 'rider_at_pickup' }],
  rider_at_pickup: [{ event: 'rider_pickup', to: 'picked_up' }],
  picked_up: [{ event: 'rider_arrive', to: 'arrived' }],
  in_transit: [{ event: 'rider_arrive', to: 'arrived' }],
  arrived: [{ event: 'rider_deliver', to: 'completed' }],
};

/**
 * Which ORDER event a leg transition raises.
 *
 * Mostly one-to-one with the leg event, because the order machine and the
 * leg machine share a vocabulary. The exception is arriving at the pickup:
 * for a catalogue order (machine A) that pickup is a VENDOR, and the order
 * machine calls it `rider_arrive_vendor`. Machines C/D/E collect from the
 * customer instead and keep `rider_arrive_pickup`.
 *
 * Getting this wrong is silent: the leg advances, the order does not, and
 * the customer's tracking screen freezes while the food is already moving.
 */
export function orderEventFor(legEvent: string, machine: string): string | null {
  if (legEvent === 'rider_arrive_pickup') {
    return machine === 'A' || machine === 'B' ? 'rider_arrive_vendor' : 'rider_arrive_pickup';
  }
  // rider_pickup, rider_arrive and rider_deliver are named identically in
  // both machines.
  return ['rider_pickup', 'rider_arrive', 'rider_deliver'].includes(legEvent)
    ? legEvent
    : null;
}

export function nextLegState(from: string, event: string): string | null {
  return LEG_TRANSITIONS[from]?.find((t) => t.event === event)?.to ?? null;
}
