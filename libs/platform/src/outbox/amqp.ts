/**
 * RabbitMQ transport for the outbox relay and consumers.
 *
 * Topology (MASTER_PLAN §3.8):
 *   topic exchange `besonc.events`, durable
 *   one durable quorum queue per consumer group, bound by routing pattern
 *   a dead-letter queue per consumer so a poison message never blocks the rest
 *
 * Publishes are confirmed — `publish()` resolves only once the broker has
 * accepted the message, otherwise the relay would mark rows published that
 * were silently dropped.
 */

import amqp from 'amqplib';
import type { EventPublisher } from './relay.ts';

export const EVENTS_EXCHANGE = 'besonc.events';

export interface AmqpOptions {
  url: string;
  exchange?: string;
}

export class AmqpPublisher implements EventPublisher {
  private conn: amqp.ChannelModel | undefined;
  private ch: amqp.ConfirmChannel | undefined;
  private readonly exchange: string;

  constructor(private readonly opts: AmqpOptions) {
    this.exchange = opts.exchange ?? EVENTS_EXCHANGE;
  }

  async connect(): Promise<void> {
    this.conn = await amqp.connect(this.opts.url);
    this.ch = await this.conn.createConfirmChannel();
    await this.ch.assertExchange(this.exchange, 'topic', { durable: true });
  }

  async publish(input: {
    exchange: string; routingKey: string; message: Buffer;
    messageId: string; correlationId?: string;
  }): Promise<boolean> {
    if (!this.ch) throw new Error('AmqpPublisher is not connected');

    return new Promise<boolean>((resolve, reject) => {
      this.ch!.publish(
        input.exchange, input.routingKey, input.message,
        {
          persistent: true,               // survive a broker restart
          messageId: input.messageId,     // consumers dedupe on this
          contentType: 'application/json',
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        },
        (err) => (err ? reject(err) : resolve(true)),   // publisher confirm
      );
    });
  }

  async close(): Promise<void> {
    await this.ch?.close().catch(() => {});
    await this.conn?.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Consumer                                                            */
/* ------------------------------------------------------------------ */

export interface DomainEvent {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId: string | null;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface ConsumerOptions {
  url: string;
  exchange?: string;
  /** Durable queue name — the consumer group identity. */
  queue: string;
  /** Routing patterns, e.g. ['order.*', 'payment.settled']. */
  patterns: string[];
  prefetch?: number;
}

/**
 * A consumer with a dead-letter queue.
 *
 * A handler that throws nacks the message WITHOUT requeue, so it goes to the
 * DLQ rather than spinning forever at the head of the queue. Poison messages
 * are an operator problem, not an availability problem.
 */
export class AmqpConsumer {
  private conn: amqp.ChannelModel | undefined;
  private ch: amqp.Channel | undefined;
  private readonly exchange: string;

  constructor(private readonly opts: ConsumerOptions) {
    this.exchange = opts.exchange ?? EVENTS_EXCHANGE;
  }

  async start(handler: (evt: DomainEvent) => Promise<void>): Promise<void> {
    this.conn = await amqp.connect(this.opts.url);
    this.ch = await this.conn.createChannel();
    await this.ch.prefetch(this.opts.prefetch ?? 10);

    await this.ch.assertExchange(this.exchange, 'topic', { durable: true });

    const dlx = `${this.exchange}.dlx`;
    const dlq = `${this.opts.queue}.dlq`;
    await this.ch.assertExchange(dlx, 'topic', { durable: true });
    await this.ch.assertQueue(dlq, { durable: true });
    await this.ch.bindQueue(dlq, dlx, '#');

    await this.ch.assertQueue(this.opts.queue, {
      durable: true,
      deadLetterExchange: dlx,
    });
    for (const p of this.opts.patterns) {
      await this.ch.bindQueue(this.opts.queue, this.exchange, p);
    }

    await this.ch.consume(this.opts.queue, async (msg) => {
      if (!msg) return;
      try {
        const evt = JSON.parse(msg.content.toString()) as DomainEvent;
        await handler(evt);
        this.ch!.ack(msg);
      } catch {
        this.ch!.nack(msg, false, false);   // straight to the DLQ
      }
    });
  }

  async close(): Promise<void> {
    await this.ch?.close().catch(() => {});
    await this.conn?.close().catch(() => {});
  }
}

/**
 * Consumer-side dedupe.
 *
 * The relay is at-least-once, so every handler needs this. Keyed on
 * (consumerGroup, eventId) so two different services both process an event
 * but neither processes it twice.
 */
export interface ConsumerDedupe {
  claim(consumerGroup: string, eventId: string): Promise<boolean>;
}

export class InMemoryConsumerDedupe implements ConsumerDedupe {
  private seen = new Set<string>();
  async claim(group: string, eventId: string) {
    const key = `${group}:${eventId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export function idempotent(
  group: string, dedupe: ConsumerDedupe, handler: (evt: DomainEvent) => Promise<void>,
): (evt: DomainEvent) => Promise<void> {
  return async (evt) => {
    const fresh = await dedupe.claim(group, evt.id);
    if (!fresh) return;
    await handler(evt);
  };
}
