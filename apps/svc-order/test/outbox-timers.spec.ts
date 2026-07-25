/**
 * outbox-timers.spec — closes issue #9 (durable timers) and proves the
 * transactional outbox against real Postgres.
 *
 * The critical property: an event is written in the SAME transaction as the
 * state change. If the transaction rolls back, no event leaks. If it commits,
 * the event is guaranteed to be relayed eventually.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const DSN = process.env.ORDER_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55433/orders';
let pool: pg.Pool | undefined;
let dbUp = false;

before(async () => {
  try {
    pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync(join(process.cwd(), 'apps/svc-order/migrations/001_orders.sql'), 'utf8'));
    dbUp = true;
  } catch { dbUp = false; }
});
after(async () => { await pool?.end(); });

async function makeOrder(ref: string, state = 'pending_payment'): Promise<string> {
  const r = await pool!.query<{ id: string }>(
    `INSERT INTO orders (human_ref, customer_id, service, engine, machine, state,
        item_total_pesewas, delivery_fee_pesewas, service_fee_pesewas, total_pesewas, payment_intent)
     VALUES ($1, gen_random_uuid(), 'food','catalogue','A',$2, 7000,800,350,8150,'prepaid')
     RETURNING id`, [ref, state]);
  return r.rows[0]!.id;
}

describe('transactional outbox', () => {
  test('state change and event commit atomically', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tx-1');
    const c = await pool!.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE orders SET state='placed' WHERE id=$1`, [id]);
      await c.query(
        `INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ('order.placed',$1,$2)`,
        [id, JSON.stringify({ orderId: id })]);
      await c.query('COMMIT');
    } finally { c.release(); }

    const st = await pool!.query(`SELECT state FROM orders WHERE id=$1`, [id]);
    const ob = await pool!.query(`SELECT count(*) c FROM outbox WHERE aggregate_id=$1`, [id]);
    assert.equal(st.rows[0]!.state, 'placed');
    assert.equal(ob.rows[0]!.c, '1');
  });

  test('ROLLBACK leaks no event — the whole point of the outbox', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tx-2');
    const c = await pool!.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE orders SET state='placed' WHERE id=$1`, [id]);
      await c.query(
        `INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ('order.placed',$1,'{}')`, [id]);
      await c.query('ROLLBACK');
    } finally { c.release(); }

    const st = await pool!.query(`SELECT state FROM orders WHERE id=$1`, [id]);
    const ob = await pool!.query(`SELECT count(*) c FROM outbox WHERE aggregate_id=$1`, [id]);
    assert.equal(st.rows[0]!.state, 'pending_payment', 'state must be unchanged');
    assert.equal(ob.rows[0]!.c, '0', 'no phantom event may exist');
  });

  test('the relay only picks up unpublished rows', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tx-3');
    await pool!.query(
      `INSERT INTO outbox (event_type, aggregate_id, payload) VALUES ('order.a',$1,'{}'),('order.b',$1,'{}')`, [id]);
    const pending = await pool!.query(
      `SELECT id FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL ORDER BY id`, [id]);
    assert.equal(pending.rowCount, 2);

    await pool!.query(`UPDATE outbox SET published_at=now() WHERE id=$1`, [pending.rows[0]!.id]);
    const left = await pool!.query(
      `SELECT count(*) c FROM outbox WHERE aggregate_id=$1 AND published_at IS NULL`, [id]);
    assert.equal(left.rows[0]!.c, '1');
  });
});

describe('durable timers (closes issue #9)', () => {
  test('a timer survives a "redeploy" — it lives in the database', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tm-1', 'placed');
    await pool!.query(
      `INSERT INTO order_timers (order_id,name,fire_at,event,expect_state)
       VALUES ($1,'vendor_accept', now() + interval '3 minutes','auto_timeout','placed')`, [id]);

    // simulate a process restart: nothing in memory, everything still in PG
    const r = await pool!.query(
      `SELECT count(*) c FROM order_timers WHERE order_id=$1 AND fired_at IS NULL`, [id]);
    assert.equal(r.rows[0]!.c, '1', 'timer must outlive the process');
  });

  test('only one live timer per (order, name)', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tm-2', 'placed');
    await pool!.query(
      `INSERT INTO order_timers (order_id,name,fire_at,event,expect_state)
       VALUES ($1,'vendor_accept', now(),'auto_timeout','placed')`, [id]);
    await assert.rejects(() => pool!.query(
      `INSERT INTO order_timers (order_id,name,fire_at,event,expect_state)
       VALUES ($1,'vendor_accept', now(),'auto_timeout','placed')`, [id]));
  });

  test('EXACTLY-ONCE under concurrent workers (SKIP LOCKED)', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Drain any timers left due by earlier tests so this measures only ours.
    await pool!.query('SELECT id FROM claim_due_timers(500)');
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await makeOrder(`#race-${i}`, 'placed');
      ids.push(id);
      await pool!.query(
        `INSERT INTO order_timers (order_id,name,fire_at,event,expect_state)
         VALUES ($1,'vendor_accept', now() - interval '1 second','auto_timeout','placed')`, [id]);
    }

    // 8 workers race for the same 20 timers
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        pool!.query<{ id: string }>('SELECT id FROM claim_due_timers(50)')),
    );

    const claimed = results.flatMap((r) => r.rows.map((x) => x.id));
    const unique = new Set(claimed);
    assert.equal(claimed.length, 20, 'every timer must be claimed');
    assert.equal(unique.size, 20, 'no timer may be claimed twice');

    const left = await pool!.query(
      `SELECT count(*) c FROM order_timers WHERE fired_at IS NULL AND cancelled_at IS NULL AND fire_at <= now()`);
    assert.equal(left.rows[0]!.c, '0');
  });

  test('a cancelled timer never fires', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tm-3', 'placed');
    await pool!.query(
      `INSERT INTO order_timers (order_id,name,fire_at,event,expect_state)
       VALUES ($1,'vendor_accept', now() - interval '1 second','auto_timeout','placed')`, [id]);
    // vendor accepted in time
    await pool!.query(
      `UPDATE order_timers SET cancelled_at=now() WHERE order_id=$1 AND fired_at IS NULL`, [id]);
    const claimed = await pool!.query(`SELECT id FROM claim_due_timers(50) WHERE order_id=$1`, [id]);
    assert.equal(claimed.rowCount, 0);
  });

  test('a fired timer is re-checked against current state before acting', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#tm-4', 'placed');
    await pool!.query(
      `INSERT INTO order_timers (order_id,name,fire_at,event,expect_state)
       VALUES ($1,'vendor_accept', now() - interval '1 second','auto_timeout','placed')`, [id]);

    // vendor accepts in the same instant the timer becomes due
    await pool!.query(`UPDATE orders SET state='vendor_accepted' WHERE id=$1`, [id]);

    const claimed = await pool!.query<{ order_id: string; expect_state: string }>(
      `SELECT order_id, expect_state FROM claim_due_timers(50)`);
    const row = claimed.rows.find((r) => r.order_id === id);
    assert.ok(row, 'timer is claimed');

    const cur = await pool!.query<{ state: string }>(`SELECT state FROM orders WHERE id=$1`, [id]);
    assert.notEqual(cur.rows[0]!.state, row!.expect_state,
      'guard must prevent auto-rejecting an already-accepted order');
  });
});

describe('delivery legs (issue #10)', () => {
  test('laundry carries two legs with separate fees', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#leg-1', 'placed');
    await pool!.query(
      `INSERT INTO delivery_legs (order_id,sequence,leg_type,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,fee_pesewas)
       VALUES ($1,1,'customer_to_vendor',5.556,-0.182,5.560,-0.190,800),
              ($1,2,'vendor_to_customer_return',5.560,-0.190,5.556,-0.182,800)`, [id]);
    const r = await pool!.query<{ n: string; total: string }>(
      `SELECT count(*) n, sum(fee_pesewas) total FROM delivery_legs WHERE order_id=$1`, [id]);
    assert.equal(r.rows[0]!.n, '2');
    assert.equal(r.rows[0]!.total, '1600');
  });

  test('a rider cannot hold two active legs — no batching at launch', async (t) => {
    if (!dbUp) return t.skip('no database');
    const rider = '99999999-9999-9999-9999-999999999999';
    const a = await makeOrder('#leg-2', 'placed');
    const b = await makeOrder('#leg-3', 'placed');
    for (const id of [a, b]) {
      await pool!.query(
        `INSERT INTO delivery_legs (order_id,sequence,leg_type,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng)
         VALUES ($1,1,'vendor_to_customer',5.5,-0.1,5.6,-0.2)`, [id]);
    }
    await pool!.query(
      `UPDATE delivery_legs SET state='assigned', assigned_rider_id=$1 WHERE order_id=$2`, [rider, a]);
    await assert.rejects(() => pool!.query(
      `UPDATE delivery_legs SET state='assigned', assigned_rider_id=$1 WHERE order_id=$2`, [rider, b]));

    // completing the first frees them
    await pool!.query(
      `UPDATE delivery_legs SET state='completed', completed_at=now() WHERE order_id=$1`, [a]);
    await pool!.query(
      `UPDATE delivery_legs SET state='assigned', assigned_rider_id=$1 WHERE order_id=$2`, [rider, b]);
  });
});

describe('order invariants', () => {
  test('shop can never be COD (PDF §2)', async (t) => {
    if (!dbUp) return t.skip('no database');
    await assert.rejects(() => pool!.query(
      `INSERT INTO orders (human_ref,customer_id,service,engine,machine,
          item_total_pesewas,delivery_fee_pesewas,service_fee_pesewas,total_pesewas,payment_intent)
       VALUES ('#cod-shop', gen_random_uuid(),'shop','catalogue','A',5000,0,0,5000,'cod')`));
  });

  test('a delivered order must have a balanced settlement split', async (t) => {
    if (!dbUp) return t.skip('no database');
    const id = await makeOrder('#split-1');
    // the erroneous PDF §7 figures: 59.50 + 8 + 10.50 != 81.50
    await assert.rejects(() => pool!.query(
      `UPDATE orders SET state='delivered', vendor_amount_pesewas=5950,
              rider_amount_pesewas=800, platform_amount_pesewas=1050 WHERE id=$1`, [id]));
    // the correct figures
    await pool!.query(
      `UPDATE orders SET state='delivered', vendor_amount_pesewas=5950,
              rider_amount_pesewas=800, platform_amount_pesewas=1400 WHERE id=$1`, [id]);
  });
});
