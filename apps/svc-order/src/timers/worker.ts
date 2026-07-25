/**
 * Durable timer worker (closes issue #9).
 *
 * Order deadlines — a vendor has 3 minutes to accept, a dispatch round
 * lasts 30 seconds — cannot live in `setTimeout`. An in-process timer dies
 * with the process, so a deploy at the wrong moment leaves an order stuck
 * "placed" forever with a customer's money held and nobody looking at it.
 *
 * Instead every deadline is a row in `order_timers`, and this worker claims
 * due rows with `FOR UPDATE SKIP LOCKED`. That lets N replicas poll the same
 * table concurrently: each row is handed to exactly one worker, and no
 * worker ever waits on another's lock.
 */

import type { Pool } from 'pg';

export interface TimerRow {
  id: string;
  order_id: string;
  name: string;
  event: string;
  expect_state: string;
}

export interface TimerWorkerOptions {
  /** How often to look for due timers. */
  intervalMs?: number;
  /** Rows claimed per tick. Bounded so one replica cannot hog the queue. */
  batchSize?: number;
  onError?: (err: Error) => void;
  onFired?: (timer: TimerRow, outcome: 'applied' | 'stale' | 'failed') => void;
}

export type ApplyFn = (
  orderId: string,
  event: string,
  actor: { type: string; id?: string },
) => Promise<unknown>;

export class TimerWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly apply: ApplyFn,
    private readonly opts: TimerWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.opts.intervalMs ?? 1_000;
    this.timer = setInterval(() => void this.tick(), interval);
    // Do not block the event loop at shutdown for a poll.
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Claim and fire one batch. Returns how many timers actually applied. */
  async tick(): Promise<number> {
    // Overlap guard: a slow batch must not stack up behind the interval.
    if (this.running || this.stopped) return 0;
    this.running = true;

    try {
      const claimed = await this.claim();
      let applied = 0;

      for (const t of claimed) {
        try {
          // The expected-state check happens inside `apply` via the state
          // machine: if the vendor accepted two seconds before the timer
          // fired, the transition is illegal and throws. That is the
          // correct outcome, not an error — the deadline simply lost the
          // race, which is why this is caught and recorded as 'stale'.
          await this.apply(t.order_id, t.event, { type: 'system', id: 'timer' });
          applied += 1;
          this.opts.onFired?.(t, 'applied');
        } catch (err) {
          const message = (err as Error).message;
          const stale = /illegal|cannot|not allowed|transition/i.test(message);
          this.opts.onFired?.(t, stale ? 'stale' : 'failed');
          if (!stale) this.opts.onError?.(err as Error);
        }
      }
      return applied;
    } catch (err) {
      this.opts.onError?.(err as Error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Claim due timers.
   *
   * `SKIP LOCKED` is the whole trick: without it, two replicas polling at
   * the same instant serialise on the same rows and throughput collapses to
   * one worker. With it, each simply takes what the other has not.
   *
   * Rows are marked fired INSIDE the claiming transaction, so a crash
   * mid-batch cannot fire the same deadline twice.
   */
  private async claim(): Promise<TimerRow[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query<TimerRow>(
        `SELECT id, order_id, name, event, expect_state
           FROM order_timers
          WHERE fired_at IS NULL
            AND cancelled_at IS NULL
            AND fire_at <= now()
          ORDER BY fire_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [this.opts.batchSize ?? 20],
      );

      if (r.rows.length > 0) {
        await c.query(
          'UPDATE order_timers SET fired_at = now() WHERE id = ANY($1)',
          [r.rows.map((t) => t.id)],
        );
      }
      await c.query('COMMIT');
      return r.rows;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}
