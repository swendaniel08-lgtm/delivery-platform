/**
 * Postgres implementation of ChatStore.
 *
 * Chat transcripts are dispute evidence. "The rider says I told him to leave
 * it at the gate" is settled by the transcript or it is not settled at all,
 * and until now every message lived in a process-local array that a redeploy
 * erased. Losing a customer's argument because we shipped on a Tuesday is not
 * a defensible way to run a platform.
 *
 * Two design points worth stating:
 *
 *   • Threads are created lazily and idempotently. Two participants can open
 *     the same chat at the same instant — the customer tapping "message
 *     rider" while the rider taps "message customer" — and `UNIQUE
 *     (order_id, pair)` plus `ON CONFLICT` is what makes that a non-event
 *     rather than a 500.
 *   • The 30-minute close window (PDF §9) is STORED as `closes_at` rather
 *     than computed on read. If the policy constant ever changes, chats that
 *     were opened under the old rule keep the deadline their participants
 *     were told about.
 */

import type { Pool } from 'pg';

import type { ChatWindow } from './dispatcher.ts';
import { CHAT_GRACE_MINUTES } from './dispatcher.ts';
import type { ChatStore } from './http.ts';

type Pair = ChatWindow['pair'];

export class PgChatStore implements ChatStore {
  constructor(private readonly pool: Pool) {}

  /**
   * The chat window for an order, or null when no thread was ever opened.
   *
   * Null is meaningful and must not be conflated with "closed": a thread that
   * does not exist yet can still be opened, whereas a closed one cannot.
   */
  async window(orderId: string, pair: Pair): Promise<ChatWindow | null> {
    const { rows } = await this.pool.query<{
      order_id: string; pair: Pair; opened_at: Date; delivered_at: Date | null;
    }>(
      `SELECT order_id, pair, opened_at, delivered_at
         FROM chat_threads
        WHERE order_id = $1 AND pair = $2::chat_pair`,
      [orderId, pair],
    );

    const r = rows[0];
    if (!r) return null;
    return {
      orderId: r.order_id,
      pair: r.pair,
      openedAt: r.opened_at,
      deliveredAt: r.delivered_at,
    };
  }

  /**
   * Open a thread, or return the existing one.
   *
   * `ON CONFLICT ... DO UPDATE` rather than `DO NOTHING` because the latter
   * returns no row, and the caller needs the id either way. Updating a column
   * to itself is the standard idiom for "upsert and give me the row back".
   */
  async openThread(input: {
    orderId: string; pair: Pair; customerId: string; counterpartyId?: string;
  }): Promise<{ id: string; created: boolean }> {
    const { rows } = await this.pool.query<{ id: string; created: boolean }>(
      `INSERT INTO chat_threads (order_id, pair, customer_id, counterparty_id)
       VALUES ($1, $2::chat_pair, $3, $4)
       ON CONFLICT (order_id, pair) DO UPDATE
          SET counterparty_id = COALESCE(
                chat_threads.counterparty_id, EXCLUDED.counterparty_id)
       RETURNING id, (xmax = 0) AS created`,
      [input.orderId, input.pair, input.customerId, input.counterpartyId ?? null],
    );
    return { id: rows[0]!.id, created: rows[0]!.created };
  }

  /**
   * Mark the order delivered and start the closing clock.
   *
   * Idempotent on purpose: the outbox relay is at-least-once, so
   * `order.delivered` will arrive more than once. The `WHERE delivered_at IS
   * NULL` guard means a redelivery cannot push the deadline later and quietly
   * extend a chat that should have closed.
   */
  async markDelivered(
    orderId: string, deliveredAt: Date = new Date(),
  ): Promise<void> {
    await this.pool.query(
      // $2 is cast explicitly on BOTH uses. Postgres infers a parameter's
      // type from its first use, and reusing it in interval arithmetic left
      // it "inconsistent types deduced for parameter $2" (42P08).
      `UPDATE chat_threads
          SET delivered_at = $2::timestamptz,
              closes_at    = $2::timestamptz + make_interval(mins => $3::int)
        WHERE order_id = $1 AND delivered_at IS NULL`,
      [orderId, deliveredAt, CHAT_GRACE_MINUTES],
    );
  }

  /**
   * Append a message.
   *
   * The thread is created on demand: a message is the first thing that
   * happens in most chats, and requiring a separate open call would just be
   * one more round trip that can fail between the two.
   */
  async append(msg: {
    orderId: string; pair: string; from: string;
    body?: string; imageUrl?: string;
    customerId?: string; fromUserId?: string;
  }): Promise<{ id: string; sentAt: string }> {
    const thread = await this.openThread({
      orderId: msg.orderId,
      pair: msg.pair as Pair,
      // A thread always has a customer. When the caller did not name one we
      // fall back to the sender, which is correct for customer-initiated
      // chats and harmless for the rest — `customer_id` is descriptive here,
      // authorisation happens against order-svc.
      customerId: msg.customerId ?? msg.fromUserId ?? msg.from,
    });

    const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO chat_messages
         (thread_id, from_party, from_user_id, body, image_key)
       VALUES ($1, $2::chat_party, $3, $4, $5)
       RETURNING id, created_at`,
      [
        thread.id,
        msg.from,
        msg.fromUserId ?? msg.from,
        msg.body ?? null,
        msg.imageUrl ?? null,
      ],
    );

    return {
      id: String(rows[0]!.id),
      sentAt: rows[0]!.created_at.toISOString(),
    };
  }

  /**
   * Transcript, oldest first.
   *
   * Bounded by default. An unbounded history query is fine for a ten-message
   * food order and a problem for a laundry thread that ran for three days —
   * and it is the phone on a Ghanaian mobile connection that pays for the
   * difference.
   */
  async history(
    orderId: string, pair: string, limit = 200,
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await this.pool.query<{
      id: string; from_party: string; from_user_id: string;
      body: string | null; image_key: string | null;
      read_at: Date | null; created_at: Date;
    }>(
      `SELECT m.id, m.from_party, m.from_user_id, m.body, m.image_key,
              m.read_at, m.created_at
         FROM chat_messages m
         JOIN chat_threads t ON t.id = m.thread_id
        WHERE t.order_id = $1 AND t.pair = $2::chat_pair
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $3`,
      [orderId, pair, limit],
    );

    return rows.map((r) => ({
      id: String(r.id),
      orderId,
      pair,
      from: r.from_party,
      fromUserId: r.from_user_id,
      ...(r.body !== null ? { body: r.body } : {}),
      ...(r.image_key !== null ? { imageUrl: r.image_key } : {}),
      read: r.read_at !== null,
      sentAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Mark everything the other party sent as read.
   *
   * Scoped to messages NOT from the reader — otherwise opening your own chat
   * would mark your own unread messages read, and the unread badge on the
   * other side would be wrong.
   */
  async markRead(
    orderId: string, pair: string, readerParty: string,
  ): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE chat_messages m
          SET read_at = now()
         FROM chat_threads t
        WHERE m.thread_id = t.id
          AND t.order_id = $1 AND t.pair = $2::chat_pair
          AND m.from_party <> $3::chat_party
          AND m.read_at IS NULL`,
      [orderId, pair, readerParty],
    );
    return rowCount ?? 0;
  }

  /** Unread count for a badge. Uses the partial index on `read_at IS NULL`. */
  async unreadCount(
    orderId: string, pair: string, readerParty: string,
  ): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM chat_messages m
         JOIN chat_threads t ON t.id = m.thread_id
        WHERE t.order_id = $1 AND t.pair = $2::chat_pair
          AND m.from_party <> $3::chat_party
          AND m.read_at IS NULL`,
      [orderId, pair, readerParty],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Threads whose grace period has elapsed — the purge job reads this.
   * Returned rather than deleted here so the caller decides the policy.
   */
  async closedBefore(now: Date = new Date()): Promise<string[]> {
    const { rows } = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM chat_threads
        WHERE closes_at IS NOT NULL AND closes_at < $1`,
      [now],
    );
    return rows.map((r) => r.order_id);
  }
}
