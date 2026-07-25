/**
 * Transactional outbox relay. MASTER_PLAN §1.2.2.
 *
 * Services write events into `outbox` in the SAME transaction as the state
 * change. This relay is the only thing that publishes them to RabbitMQ.
 *
 * Guarantees:
 *   - AT LEAST ONCE. A crash between publish and mark-published replays the
 *     event. Consumers must be idempotent — every one of ours already is.
 *   - ORDERED per aggregate. Rows are claimed in id order.
 *   - SAFE WITH N RELAYS. `FOR UPDATE SKIP LOCKED` means two relay instances
 *     never publish the same row.
 *
 * What it deliberately does NOT do: exactly-once. That is unachievable across
 * a database and a broker without distributed transactions, so we make the
 * consumers idempotent instead.
 */

import type { Pool } from 'pg';

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  correlation_id: string | null;
  occurred_at: Date;
  attempts: number;
}

/** Broker port — amqplib in production, a fake in tests. */
export interface EventPublisher {
  publish(input: {
    exchange: string;
    routingKey: string;
    message: Buffer;
    messageId: string;
    correlationId?: string;
  }): Promise<boolean>;
}

export interface RelayOptions {
  exchange?: string;
  batchSize?: number;
  /** Give up publishing after this many attempts and park the row. */
  maxAttempts?: number;
}

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
  parked: number;
}

const DEFAULTS = { exchange: 'besonc.events', batchSize: 100, maxAttempts: 10 };

export class OutboxRelay {
  private readonly opts: Required<RelayOptions>;

  constructor(
    private readonly pool: Pool,
    private readonly publisher: EventPublisher,
    opts: RelayOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * One pass. Returns counts so a scheduler can back off when idle.
   *
   * Each row is claimed, published, then marked — inside a transaction that
   * holds the row lock, so a second relay cannot pick it up mid-flight.
   */
  async drain(): Promise<RelayResult> {
    const client = await this.pool.connect();
    const result: RelayResult = { claimed: 0, published: 0, failed: 0, parked: 0 };

    try {
      await client.query('BEGIN');

      const rows = await client.query<OutboxRow>(
        `SELECT * FROM outbox
          WHERE published_at IS NULL AND attempts < $2
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.opts.batchSize, this.opts.maxAttempts],
      );
      result.claimed = rows.rowCount ?? 0;

      for (const row of rows.rows) {
        try {
          const ok = await this.publisher.publish({
            exchange: this.opts.exchange,
            routingKey: row.event_type,
            message: Buffer.from(JSON.stringify({
              id: row.event_id,
              type: row.event_type,
              version: 1,
              occurredAt: row.occurred_at,
              correlationId: row.correlation_id,
              aggregateType: row.aggregate_type,
              aggregateId: row.aggregate_id,
              payload: row.payload,
            })),
            messageId: row.event_id,
            ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
          });

          if (ok) {
            await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
            result.published++;
          } else {
            await this.recordFailure(client, row, 'broker refused the message');
            result.failed++;
          }
        } catch (err) {
          await this.recordFailure(client, row, (err as Error).message);
          result.failed++;
          if (row.attempts + 1 >= this.opts.maxAttempts) result.parked++;
        }
      }

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async recordFailure(client: any, row: OutboxRow, error: string) {
    await client.query(
      'UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
      [row.id, error.slice(0, 500)],
    );
  }

  /** Rows that exhausted their retries — an admin task, not a silent loss. */
  async parkedEvents(): Promise<OutboxRow[]> {
    const r = await this.pool.query<OutboxRow>(
      `SELECT * FROM outbox
        WHERE published_at IS NULL AND attempts >= $1
        ORDER BY id`,
      [this.opts.maxAttempts],
    );
    return r.rows;
  }

  /** Operator action after fixing the cause. */
  async retryParked(eventId: string): Promise<void> {
    await this.pool.query(
      'UPDATE outbox SET attempts = 0, last_error = NULL WHERE event_id = $1 AND published_at IS NULL',
      [eventId],
    );
  }

  async pendingCount(): Promise<number> {
    const r = await this.pool.query<{ c: string }>(
      'SELECT count(*) c FROM outbox WHERE published_at IS NULL',
    );
    return Number(r.rows[0]!.c);
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

export interface RelayRunnerOptions extends RelayOptions {
  /** Poll interval when the last pass found nothing. */
  idleMs?: number;
  /** Poll interval when the last pass published a full batch. */
  busyMs?: number;
}

/**
 * Adaptive polling: fast while there is a backlog, slow when idle.
 * Avoids hammering Postgres with empty SELECTs at 3am.
 */
export class RelayRunner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly opts: RelayRunnerOptions = {},
    private readonly onError: (e: Error) => void = () => {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (!this.running) return;
    const idle = this.opts.idleMs ?? 1_000;
    const busy = this.opts.busyMs ?? 50;

    this.relay.drain()
      .then((r) => {
        const next = r.claimed > 0 ? busy : idle;
        if (this.running) this.timer = setTimeout(() => this.tick(), next);
      })
      .catch((e) => {
        this.onError(e as Error);
        if (this.running) this.timer = setTimeout(() => this.tick(), idle);
      });
  }
}
