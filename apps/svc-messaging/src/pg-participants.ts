/**
 * Who is on an order — the ownership check behind chat authorisation.
 *
 * Reads a local projection rather than calling order-svc. This runs on every
 * chat read and every send, and a synchronous cross-service hop on that path
 * is both a latency cost and a second thing that can be down while somebody
 * is standing at a gate trying to reach their rider.
 *
 * The projection is written from `order.*` domain events. It is allowed to be
 * momentarily stale — a rider assigned one second ago simply cannot open the
 * chat yet — but it must never be WRONG in the permissive direction, which is
 * why an unknown order denies rather than allows.
 */

import type { Pool } from 'pg';
import type { OrderParticipantLookup } from './http.ts';

export class PgParticipants implements OrderParticipantLookup {
  constructor(private readonly pool: Pool) {}

  async participants(orderId: string): Promise<{
    customerId: string; riderId: string | null; vendorId: string | null;
  } | null> {
    // A malformed id must not 500 — order ids arrive straight from a URL.
    if (!/^[0-9a-f-]{8,40}$/i.test(orderId)) return null;

    const { rows } = await this.pool.query<{
      customer_id: string; rider_id: string | null; vendor_id: string | null;
    }>(
      `SELECT customer_id, rider_id, vendor_id
         FROM order_participants
        WHERE order_id = $1`,
      [orderId],
    );

    const r = rows[0];
    if (!r) return null;
    return {
      customerId: r.customer_id,
      riderId: r.rider_id,
      vendorId: r.vendor_id,
    };
  }
}
