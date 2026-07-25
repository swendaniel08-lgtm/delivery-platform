/**
 * order-flow.e2e.spec — the first genuinely END-TO-END test.
 *
 * A real NestJS app over real HTTP, against a real Postgres, driving a real
 * order from checkout to settlement, with the ledger posting alongside.
 *
 * This is what turns a pile of tested libraries into a system: it exercises
 * the HTTP layer, the state machine, the outbox, delivery legs and the
 * double-entry ledger in one flow, the way production will.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { OrderModule } from '../../svc-order/src/http/order.module.ts';
import { ProblemDetailsFilter } from '../../../libs/platform/src/http/problem-filter.ts';
import { LedgerService } from '../../svc-payment/src/ledger.ts';
import { PgLedgerRepository } from '../../svc-payment/src/pg-ledger-repository.ts';
import { quote } from '../../svc-pricing/src/pricing.ts';
import { fromCedis, toCedis } from '../../../libs/money/src/money.ts';

const ORDER_DSN = process.env.ORDER_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55433/orders';
const PAY_DSN = process.env.LEDGER_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55432/payment';
const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}`;

let app: NestFastifyApplication | undefined;
let orderPool: pg.Pool | undefined;
let payPool: pg.Pool | undefined;
let ledger: LedgerService;
let up = false;

const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const VENDOR = '22222222-2222-2222-2222-222222222222';
const RIDER = '33333333-3333-3333-3333-333333333333';

before(async () => {
  try {
    orderPool = new pg.Pool({ connectionString: ORDER_DSN, connectionTimeoutMillis: 3000 });
    payPool = new pg.Pool({ connectionString: PAY_DSN, connectionTimeoutMillis: 3000 });
    await orderPool.query('SELECT 1');
    await payPool.query('SELECT 1');

    await orderPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await orderPool.query(readFileSync(join(process.cwd(), 'apps/svc-order/migrations/001_orders.sql'), 'utf8'));
    await payPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await payPool.query(readFileSync(join(process.cwd(), 'apps/svc-payment/migrations/001_ledger.sql'), 'utf8'));

    ledger = new LedgerService(new PgLedgerRepository(payPool));

    app = await NestFactory.create<NestFastifyApplication>(
      OrderModule.forRoot(orderPool), new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(PORT, '127.0.0.1');
    up = true;
  } catch (e) {
    console.error('e2e setup skipped:', (e as Error).message);
    up = false;
  }
});

after(async () => {
  await app?.close();
  await orderPool?.end();
  await payPool?.end();
});

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'e2e-test' },
    body: JSON.stringify(body),
  });
const get = (path: string) => fetch(`${BASE}${path}`);

describe('service health', () => {
  test('liveness and readiness respond', async (t) => {
    if (!up) return t.skip('no infra');
    assert.equal((await get('/health')).status, 200);
    const ready = await get('/health/ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as any).status, 'ready');
  });
});

describe('FULL ORDER FLOW: checkout → payment → dispatch → delivery → settlement', () => {
  test('the PDF §20 walkthrough, end to end over HTTP', async (t) => {
    if (!up) return t.skip('no infra');

    /* 1. price the order with the real pricing engine ------------------ */
    const q = quote({ service: 'food', itemTotal: fromCedis('70'), distanceMetres: 2_000 });
    assert.equal(toCedis(q.total), '81.50');

    /* 2. create the order over HTTP ------------------------------------ */
    const created = await post('/orders', {
      customerId: CUSTOMER, storeId: VENDOR, service: 'food',
      itemTotalPesewas: q.itemTotal.toString(),
      deliveryFeePesewas: q.deliveryFee.toString(),
      serviceFeePesewas: q.serviceFee.toString(),
      paymentIntent: 'prepaid',
      legs: [{
        sequence: 1, legType: 'vendor_to_customer',
        pickup: { lat: 5.5560, lng: -0.1821 }, dropoff: { lat: 5.5800, lng: -0.1750 },
        feePesewas: q.deliveryFee.toString(),
      }],
    });
    assert.equal(created.status, 201);
    const order = await created.json() as any;
    assert.equal(order.state, 'pending_payment');
    assert.equal(order.machine, 'A');
    assert.equal(order.totalPesewas, '8150');

    /* 3. payment confirmed → ledger capture + state transition --------- */
    await ledger.capture(order.id, fromCedis('81.50'));
    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_HOLDING' })), '81.50');

    const paid = await post(`/orders/${order.id}/events`, { event: 'payment_confirmed', actorType: 'system' });
    assert.equal(paid.status, 201);
    const paidBody = await paid.json() as any;
    assert.equal(paidBody.to, 'placed');
    assert.ok(paidBody.emitted.includes('order.placed'));

    /* the 3-minute vendor timer must now exist ------------------------- */
    const timers = await orderPool!.query(
      `SELECT name FROM order_timers WHERE order_id=$1 AND fired_at IS NULL AND cancelled_at IS NULL`,
      [order.id]);
    assert.equal(timers.rowCount, 1);
    assert.equal(timers.rows[0]!.name, 'vendor_accept');

    /* 4. vendor accepts → timer cancelled, dispatch requested ---------- */
    const accepted = await post(`/orders/${order.id}/events`, { event: 'vendor_accept', actorType: 'vendor', actorId: VENDOR });
    assert.equal((await accepted.json() as any).to, 'vendor_accepted');

    const liveTimers = await orderPool!.query(
      `SELECT count(*) c FROM order_timers WHERE order_id=$1 AND fired_at IS NULL AND cancelled_at IS NULL`,
      [order.id]);
    assert.equal(liveTimers.rows[0]!.c, '0', 'accepting must cancel the auto-reject timer');

    /* 5. prepare → ready → assign → pickup → deliver ------------------- */
    for (const event of ['vendor_start_preparing', 'vendor_ready', 'rider_assign',
                         'rider_arrive_vendor', 'rider_pickup', 'rider_arrive']) {
      const r = await post(`/orders/${order.id}/events`, { event, actorType: 'rider', actorId: RIDER });
      assert.equal(r.status, 201, `${event} failed`);
    }

    const delivered = await post(`/orders/${order.id}/events`, { event: 'rider_deliver', actorType: 'rider', actorId: RIDER });
    const deliveredBody = await delivered.json() as any;
    assert.equal(deliveredBody.to, 'delivered');

    /* 6. settle in the ledger ------------------------------------------ */
    await ledger.settlePrepaid({
      orderId: order.id, vendorId: VENDOR, riderId: RIDER,
      total: q.total, vendorAmount: q.vendorReceives,
      riderAmount: q.riderReceives, platformAmount: q.platformReceives,
    });

    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_HOLDING' })), '0.00');
    assert.equal(toCedis(await ledger.balance({ type: 'VENDOR_WALLET', ownerId: VENDOR })), '59.50');
    assert.equal(toCedis(await ledger.balance({ type: 'RIDER_WALLET', ownerId: RIDER })), '8.00');
    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_REVENUE' })), '14.00');

    /* 7. the ledger must still balance globally ------------------------ */
    const drift = await payPool!.query<{ drift: string }>('SELECT drift FROM ledger_global_check');
    assert.equal(drift.rows[0]!.drift, '0');

    /* 8. full audit trail exists --------------------------------------- */
    const history = await (await get(`/orders/${order.id}/history`)).json() as any[];
    // 9 transitions: placed, accepted, preparing, ready, assigned,
    // at_vendor, picked_up, arrived, delivered
    assert.equal(history.length, 9);
    assert.equal(history[0]!.to_state, 'placed');
    assert.equal(history.at(-1)!.to_state, 'delivered');

    /* 9. outbox captured every effect ---------------------------------- */
    const outbox = await orderPool!.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE aggregate_id=$1 ORDER BY id`, [order.id]);
    const types = outbox.rows.map((r) => r.event_type);
    assert.ok(types.includes('order.placed'));
    assert.ok(types.includes('order.vendor_accepted'));
    assert.ok(types.includes('order.delivered'));
    assert.ok(outbox.rowCount! >= 8);
  });
});

describe('HTTP error contract', () => {
  test('an illegal transition returns RFC-7807, not a 500', async (t) => {
    if (!up) return t.skip('no infra');
    const created = await post('/orders', {
      customerId: CUSTOMER, storeId: VENDOR, service: 'food',
      itemTotalPesewas: '7000', deliveryFeePesewas: '800', serviceFeePesewas: '350',
      paymentIntent: 'prepaid',
      legs: [{ sequence: 1, legType: 'vendor_to_customer',
        pickup: { lat: 5.55, lng: -0.18 }, dropoff: { lat: 5.58, lng: -0.17 }, feePesewas: '800' }],
    });
    const order = await created.json() as any;

    // cannot deliver an order that has not even been paid for
    const bad = await post(`/orders/${order.id}/events`, { event: 'rider_deliver' });
    assert.equal(bad.status, 409);
    assert.match(bad.headers.get('content-type') ?? '', /application\/problem\+json/);
    const problem = await bad.json() as any;
    assert.equal(problem.status, 409);
    assert.match(problem.type, /errors\.besonc\.app/);
    assert.match(problem.detail ?? problem.title, /cannot rider_deliver/);
    assert.equal(problem.correlationId, 'e2e-test', 'correlation id must round-trip');
  });

  test('a missing order returns 404 as a problem document', async (t) => {
    if (!up) return t.skip('no infra');
    const res = await get('/orders/99999999-9999-9999-9999-999999999999');
    assert.equal(res.status, 404);
    const problem = await res.json() as any;
    assert.equal(problem.title, 'Not Found');
  });

  test('validation failures return 422 with field detail', async (t) => {
    if (!up) return t.skip('no infra');
    const res = await post('/orders', { service: 'food' });
    assert.equal(res.status, 422);
    const problem = await res.json() as any;
    assert.ok(problem.errors.customerId);
  });

  test('the API tells each client which actions are available', async (t) => {
    if (!up) return t.skip('no infra');
    const created = await post('/orders', {
      customerId: CUSTOMER, storeId: VENDOR, service: 'food',
      itemTotalPesewas: '5000', deliveryFeePesewas: '500', serviceFeePesewas: '250',
      paymentIntent: 'prepaid',
      legs: [{ sequence: 1, legType: 'vendor_to_customer',
        pickup: { lat: 5.55, lng: -0.18 }, dropoff: { lat: 5.58, lng: -0.17 }, feePesewas: '500' }],
    });
    const order = await created.json() as any;
    await post(`/orders/${order.id}/events`, { event: 'payment_confirmed' });

    const fetched = await (await get(`/orders/${order.id}`)).json() as any;
    assert.equal(fetched.state, 'placed');
    assert.ok(fetched.availableEvents.includes('vendor_accept'));
    assert.ok(fetched.availableEvents.includes('vendor_reject'));
    assert.equal(fetched.terminal, false);
  });
});

describe('concurrency', () => {
  test('two vendors accepting the same order simultaneously — one wins', async (t) => {
    if (!up) return t.skip('no infra');
    const created = await post('/orders', {
      customerId: CUSTOMER, storeId: VENDOR, service: 'food',
      itemTotalPesewas: '5000', deliveryFeePesewas: '500', serviceFeePesewas: '250',
      paymentIntent: 'prepaid',
      legs: [{ sequence: 1, legType: 'vendor_to_customer',
        pickup: { lat: 5.55, lng: -0.18 }, dropoff: { lat: 5.58, lng: -0.17 }, feePesewas: '500' }],
    });
    const order = await created.json() as any;
    await post(`/orders/${order.id}/events`, { event: 'payment_confirmed' });

    // double-tap on a flaky connection
    const results = await Promise.all([
      post(`/orders/${order.id}/events`, { event: 'vendor_accept' }),
      post(`/orders/${order.id}/events`, { event: 'vendor_accept' }),
    ]);
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409], 'exactly one accept may succeed');
  });
});
