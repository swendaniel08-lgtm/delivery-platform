/**
 * outbox-relay.e2e.spec — real Postgres + real RabbitMQ.
 *
 * This is the test that turns eleven isolated services into a system: an
 * event written by order-svc is actually received by another service.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { OutboxRelay, RelayRunner, type EventPublisher } from '../../../libs/platform/src/outbox/relay.ts';
import {
  AmqpPublisher, AmqpConsumer, InMemoryConsumerDedupe, idempotent,
  type DomainEvent,
} from '../../../libs/platform/src/outbox/amqp.ts';

const PG_DSN = process.env.ORDER_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55433/orders';
const AMQP_URL = process.env.AMQP_TEST_URL ?? 'amqp://guest:guest@localhost:5673';

let pool: pg.Pool | undefined;
let publisher: AmqpPublisher | undefined;
let up = false;

before(async () => {
  try {
    pool = new pg.Pool({ connectionString: PG_DSN, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync(join(process.cwd(), 'apps/svc-order/migrations/001_orders.sql'), 'utf8'));

    publisher = new AmqpPublisher({ url: AMQP_URL });
    await publisher.connect();
    up = true;
  } catch (e) {
    console.error('relay e2e skipped:', (e as Error).message);
    up = false;
  }
});

after(async () => {
  await publisher?.close();
  await pool?.end();
});

async function makeOrder(ref: string): Promise<string> {
  const r = await pool!.query<{ id: string }>(
    `INSERT INTO orders (human_ref, customer_id, service, engine, machine,
        item_total_pesewas, delivery_fee_pesewas, service_fee_pesewas, total_pesewas, payment_intent)
     VALUES ($1, gen_random_uuid(), 'food','catalogue','A', 7000,800,350,8150,'prepaid')
     RETURNING id`, [ref]);
  return r.rows[0]!.id;
}

async function enqueue(orderId: string, type: string, payload: unknown = {}) {
  await pool!.query(
    `INSERT INTO outbox (event_type, aggregate_id, payload, correlation_id)
     VALUES ($1,$2,$3,'relay-test')`,
    [type, orderId, JSON.stringify(payload)],
  );
}

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe('outbox → RabbitMQ → consumer', () => {
  test('an event written by a service is RECEIVED by another service', async (t) => {
    if (!up) return t.skip('no infra');

    const received: DomainEvent[] = [];
    const consumer = new AmqpConsumer({
      url: AMQP_URL, queue: 'test.notifications', patterns: ['order.*'],
    });
    await consumer.start(async (evt) => { received.push(evt); });

    const orderId = await makeOrder('#relay-1');
    await enqueue(orderId, 'order.placed', { humanRef: '#relay-1', totalPesewas: '8150' });

    const relay = new OutboxRelay(pool!, publisher!);
    const result = await relay.drain();
    assert.equal(result.published, 1);

    const got = await waitFor(() => received.length > 0);
    assert.ok(got, 'consumer never received the event');

    const evt = received[0]!;
    assert.equal(evt.type, 'order.placed');
    assert.equal(evt.aggregateId, orderId);
    assert.equal(evt.correlationId, 'relay-test');
    assert.equal((evt.payload as any).humanRef, '#relay-1');

    await consumer.close();
  });

  test('published rows are marked and never re-sent', async (t) => {
    if (!up) return t.skip('no infra');
    const orderId = await makeOrder('#relay-2');
    await enqueue(orderId, 'order.delivered');

    const relay = new OutboxRelay(pool!, publisher!);
    assert.equal((await relay.drain()).published, 1);
    assert.equal((await relay.drain()).claimed, 0, 'must not republish');

    const r = await pool!.query<{ c: string }>(
      `SELECT count(*) c FROM outbox WHERE aggregate_id=$1 AND published_at IS NOT NULL`, [orderId]);
    assert.equal(r.rows[0]!.c, '1');
  });

  test('routing patterns work — a consumer only gets what it subscribed to', async (t) => {
    if (!up) return t.skip('no infra');

    const payments: DomainEvent[] = [];
    const consumer = new AmqpConsumer({
      url: AMQP_URL, queue: 'test.payments', patterns: ['payment.*'],
    });
    await consumer.start(async (e) => { payments.push(e); });

    const orderId = await makeOrder('#relay-3');
    await enqueue(orderId, 'order.placed');       // should NOT arrive
    await enqueue(orderId, 'payment.settled');    // should arrive

    await new OutboxRelay(pool!, publisher!).drain();
    await waitFor(() => payments.length > 0);
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(payments.length, 1, 'only the payment event belongs here');
    assert.equal(payments[0]!.type, 'payment.settled');
    await consumer.close();
  });

  test('events are published in order per aggregate', async (t) => {
    if (!up) return t.skip('no infra');

    const seen: string[] = [];
    const consumer = new AmqpConsumer({
      url: AMQP_URL, queue: 'test.ordering', patterns: ['seq.*'], prefetch: 1,
    });
    await consumer.start(async (e) => { seen.push(e.type); });

    const orderId = await makeOrder('#relay-4');
    for (const t of ['seq.one', 'seq.two', 'seq.three', 'seq.four']) await enqueue(orderId, t);

    await new OutboxRelay(pool!, publisher!).drain();
    await waitFor(() => seen.length === 4);

    assert.deepEqual(seen, ['seq.one', 'seq.two', 'seq.three', 'seq.four']);
    await consumer.close();
  });
});

describe('failure handling', () => {
  test('a broker failure retries rather than losing the event', async (t) => {
    if (!up) return t.skip('no infra');
    const orderId = await makeOrder('#relay-5');
    await enqueue(orderId, 'order.placed');

    const broken: EventPublisher = { async publish() { throw new Error('broker unreachable'); } };
    const relay = new OutboxRelay(pool!, broken);
    const r = await relay.drain();
    assert.equal(r.failed, 1);
    assert.equal(r.published, 0);

    const row = await pool!.query<{ attempts: number; last_error: string; published_at: Date | null }>(
      `SELECT attempts, last_error, published_at FROM outbox WHERE aggregate_id=$1`, [orderId]);
    assert.equal(row.rows[0]!.attempts, 1);
    assert.equal(row.rows[0]!.published_at, null, 'the event must survive to retry');
    assert.match(row.rows[0]!.last_error, /unreachable/);

    // once the broker recovers, the same event publishes
    assert.equal((await new OutboxRelay(pool!, publisher!).drain()).published, 1);
  });

  test('an event that keeps failing is PARKED, not retried forever', async (t) => {
    if (!up) return t.skip('no infra');
    const orderId = await makeOrder('#relay-6');
    await enqueue(orderId, 'order.placed');

    const broken: EventPublisher = { async publish() { throw new Error('permanently bad'); } };
    const relay = new OutboxRelay(pool!, broken, { maxAttempts: 3 });
    for (let i = 0; i < 5; i++) await relay.drain();

    const parked = await relay.parkedEvents();
    assert.ok(parked.some((p) => p.aggregate_id === orderId), 'should be parked for an operator');

    // an operator fixes the cause and retries
    await relay.retryParked(parked.find((p) => p.aggregate_id === orderId)!.event_id);
    assert.equal((await new OutboxRelay(pool!, publisher!).drain()).published, 1);
  });

  test('two relays never publish the same row twice', async (t) => {
    if (!up) return t.skip('no infra');
    const orderId = await makeOrder('#relay-7');
    for (let i = 0; i < 20; i++) await enqueue(orderId, `race.${i}`);

    const a = new OutboxRelay(pool!, publisher!, { batchSize: 20 });
    const b = new OutboxRelay(pool!, publisher!, { batchSize: 20 });
    const [ra, rb] = await Promise.all([a.drain(), b.drain()]);

    assert.equal(ra.published + rb.published, 20, 'every event published exactly once');
    assert.equal(await a.pendingCount(), 0);
  });
});

describe('consumer idempotency', () => {
  test('a redelivered event is handled once per consumer group', async () => {
    const dedupe = new InMemoryConsumerDedupe();
    let calls = 0;
    const handler = idempotent('notifications', dedupe, async () => { calls++; });

    const evt: DomainEvent = {
      id: 'evt-1', type: 'order.delivered', version: 1, occurredAt: '', correlationId: null,
      aggregateType: 'order', aggregateId: 'o1', payload: {},
    };
    await handler(evt); await handler(evt); await handler(evt);
    assert.equal(calls, 1);

    // a DIFFERENT consumer group must still process it
    let otherCalls = 0;
    const other = idempotent('analytics', dedupe, async () => { otherCalls++; });
    await other(evt);
    assert.equal(otherCalls, 1);
  });
});

describe('relay runner', () => {
  test('polls continuously and drains a backlog', async (t) => {
    if (!up) return t.skip('no infra');
    const orderId = await makeOrder('#relay-8');
    for (let i = 0; i < 5; i++) await enqueue(orderId, `runner.${i}`);

    const relay = new OutboxRelay(pool!, publisher!);
    const runner = new RelayRunner(relay, { idleMs: 50, busyMs: 10 });
    runner.start();

    let pending = await relay.pendingCount();
    const start = Date.now();
    while (pending > 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      pending = await relay.pendingCount();
    }
    runner.stop();
    assert.equal(pending, 0, 'the runner should have drained everything');
  });
});
