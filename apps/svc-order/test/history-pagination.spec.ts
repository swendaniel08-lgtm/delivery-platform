/**
 * Order history pagination, against real Postgres.
 *
 * The single behaviour worth this whole file: **a customer placing an order
 * while scrolling their history must not see a duplicate.**
 *
 * The list is newest-first. With `OFFSET 20`, a new order arriving between
 * page 1 and page 2 shifts every row down by one, so page 2 opens with the
 * last item of page 1 — the customer sees the same order twice and reasonably
 * concludes they were charged twice. A keyset cursor anchored to the row they
 * last saw cannot do that, and the test below forces exactly that race.
 *
 * Skips (exit 0) when no Postgres is reachable.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import {
  OrderQueries, encodeCursor, decodeCursor,
} from '../src/http/queries.ts';

const ROOT = join(import.meta.dirname, '../../..');
const HOST = process.env.PG_TEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.ORDER_TEST_PORT ?? 55433);
const DSN = `postgresql://postgres:pw@${HOST}:${PORT}/history_spec`;

/** Synchronous top-level probe — `{ skip }` is evaluated before any hook. */
function probe(): boolean {
  try {
    execFileSync(process.execPath, ['-e', `
      const net = require('net');
      const s = net.connect({ host: ${JSON.stringify(HOST)}, port: ${PORT} });
      s.setTimeout(2000);
      s.on('connect', () => { s.destroy(); process.exit(0); });
      s.on('timeout', () => { s.destroy(); process.exit(1); });
      s.on('error', () => process.exit(1));
    `], { timeout: 4000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const live = probe();
if (!live) console.log(`# SKIP no Postgres at ${HOST}:${PORT}`);
const skip = () => (live ? false : 'no Postgres');

const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

let pool: pg.Pool;
let q: OrderQueries;

before(async () => {
  if (!live) return;
  const admin = new pg.Pool({
    connectionString: `postgresql://postgres:pw@${HOST}:${PORT}/postgres`,
    connectionTimeoutMillis: 15_000,
  });
  await admin.query('DROP DATABASE IF EXISTS history_spec');
  await admin.query('CREATE DATABASE history_spec');
  await admin.end();

  pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 15_000 });
  await pool.query(
    readFileSync(join(ROOT, 'apps/svc-order/migrations/001_orders.sql'), 'utf8'),
  );
  q = new OrderQueries(pool);
});

after(async () => { if (live && pool) await pool.end(); });

let seq = 0;

/** Insert one order. `minutesAgo` places it in the timeline. */
async function placeOrder(opts: {
  customerId?: string;
  minutesAgo?: number;
  state?: string;
  totalPesewas?: number;
  createdAt?: Date;
} = {}): Promise<{ id: string; createdAt: Date }> {
  seq += 1;
  const createdAt = opts.createdAt
    ?? new Date(Date.now() - (opts.minutesAgo ?? seq) * 60_000);

  // The schema enforces two invariants that a naive fixture violates, and
  // both are worth respecting rather than working around:
  //   orders_total_consistent — total = items + delivery + service fee
  //   orders_split_balances   — once delivered, vendor+rider+platform = total
  // These are the canonical GHS 81.50 figures from MASTER_PLAN §20.
  const total = opts.totalPesewas ?? 8150;
  const delivery = 800;
  const serviceFee = 350;
  const items = total - delivery - serviceFee;

  // Food commission is 15%, so the vendor keeps 85% of the item total.
  const vendor = Math.round(items * 0.85);
  const rider = delivery;
  const platform = total - vendor - rider;

  const r = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO orders
       (human_ref, customer_id, service, engine, machine, state,
        item_total_pesewas, delivery_fee_pesewas, service_fee_pesewas,
        total_pesewas,
        vendor_amount_pesewas, rider_amount_pesewas, platform_amount_pesewas,
        payment_intent, created_at)
     VALUES ($1, $2, 'food', 'catalogue', 'A', $3,
             $4, $5, $6, $7, $8, $9, $10, 'prepaid', $11)
     RETURNING id, created_at`,
    [
      `#${1000 + seq}`,
      opts.customerId ?? CUSTOMER,
      opts.state ?? 'delivered',
      items, delivery, serviceFee, total,
      vendor, rider, platform,
      createdAt,
    ],
  );
  return { id: r.rows[0]!.id, createdAt: r.rows[0]!.created_at };
}

async function clean() {
  await pool.query('DELETE FROM orders');
  seq = 0;
}

/* ------------------------------------------------------------------ */

describe('cursors', () => {
  test('round-trip through encode and decode', () => {
    const at = '2026-07-26T12:00:00.000Z';
    const id = '11111111-1111-4111-8111-111111111111';
    assert.deepEqual(decodeCursor(encodeCursor(at, id)), { createdAt: at, id });
  });

  test('accepts a Date as well as an ISO string', () => {
    const d = new Date('2026-07-26T12:00:00.000Z');
    assert.equal(decodeCursor(encodeCursor(d, 'x'))?.createdAt, d.toISOString());
  });

  test('a malformed cursor is null, NOT a crash', () => {
    // A cursor arrives from a client. Garbage must degrade to "start at the
    // beginning", never to a 500 on a customer's history screen.
    assert.equal(decodeCursor('not-base64!!'), null);
    assert.equal(decodeCursor(''), null);
    assert.equal(decodeCursor(Buffer.from('missing-pipe').toString('base64url')), null);
    assert.equal(
      decodeCursor(Buffer.from('not-a-date|some-id').toString('base64url')),
      null,
    );
  });

  test('the cursor is opaque', () => {
    // Base64 so clients cannot pattern-match on its shape and freeze this
    // pagination scheme in place forever.
    const c = encodeCursor('2026-07-26T12:00:00.000Z', 'abc');
    assert.ok(!c.includes('2026'));
    assert.ok(!c.includes('abc'));
  });
});

/* ------------------------------------------------------------------ */

describe('paging through history', () => {
  test('newest first', { skip: skip() }, async () => {
    await clean();
    await placeOrder({ minutesAgo: 30 });
    const newest = await placeOrder({ minutesAgo: 1 });

    const page = await q.forCustomer(CUSTOMER);
    assert.equal(page.orders[0]!.id, newest.id);
  });

  test('a short history has no next cursor', { skip: skip() }, async () => {
    await clean();
    await placeOrder();
    await placeOrder();

    const page = await q.forCustomer(CUSTOMER, { limit: 20 });
    assert.equal(page.orders.length, 2);
    assert.equal(page.nextCursor, null, 'nothing more to fetch');
  });

  test('a full page offers a cursor', { skip: skip() }, async () => {
    await clean();
    for (let i = 0; i < 5; i++) await placeOrder();

    const page = await q.forCustomer(CUSTOMER, { limit: 3 });
    assert.equal(page.orders.length, 3);
    assert.ok(page.nextCursor, 'there are more orders');
  });

  test('exactly one page does NOT offer a cursor', { skip: skip() }, async () => {
    // The fencepost. Fetching limit+1 is what makes this answerable without
    // a second COUNT over the customer's whole history.
    await clean();
    for (let i = 0; i < 3; i++) await placeOrder();

    const page = await q.forCustomer(CUSTOMER, { limit: 3 });
    assert.equal(page.orders.length, 3);
    assert.equal(page.nextCursor, null,
      'a full page with nothing after it must not promise more');
  });

  test('paging visits every order exactly once', { skip: skip() }, async () => {
    await clean();
    for (let i = 0; i < 11; i++) await placeOrder();

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const page: Awaited<ReturnType<typeof q.forCustomer>> =
        await q.forCustomer(CUSTOMER, {
          limit: 4,
          ...(cursor ? { before: decodeCursor(cursor)! } : {}),
        });
      seen.push(...page.orders.map((o) => o.id));
      cursor = page.nextCursor;
    } while (cursor && ++guard < 20);

    assert.equal(seen.length, 11);
    assert.equal(new Set(seen).size, 11, 'no order appeared twice');
  });

  test('THE RACE: a new order mid-scroll does not duplicate a row',
    { skip: skip() }, async () => {
      // This is the reason for keyset pagination.
      //
      // Ten orders, page size five. Read page 1, then the customer places a
      // new order — which lands at the TOP of a newest-first list. With
      // OFFSET 5 the window slides and page 2 re-serves the last row of
      // page 1: the same order twice, which reads as a double charge.
      await clean();
      for (let i = 0; i < 10; i++) await placeOrder({ minutesAgo: 100 - i });

      const first = await q.forCustomer(CUSTOMER, { limit: 5 });
      assert.equal(first.orders.length, 5);
      assert.ok(first.nextCursor);

      // The interleaving order.
      await placeOrder({ minutesAgo: 0 });

      const second = await q.forCustomer(CUSTOMER, {
        limit: 5,
        before: decodeCursor(first.nextCursor!)!,
      });

      const overlap = second.orders
        .map((o) => o.id)
        .filter((id) => first.orders.some((f) => f.id === id));

      assert.deepEqual(overlap, [],
        'page 2 repeated a row from page 1 — the customer sees a duplicate order');
    });

  test('orders sharing a timestamp are not dropped', { skip: skip() }, async () => {
    // `created_at` alone is not unique. Two orders in the same millisecond
    // make the boundary ambiguous, and one silently vanishes from history.
    // The cursor is (created_at, id) for exactly this.
    await clean();
    const sameInstant = new Date('2026-07-26T12:00:00.000Z');
    for (let i = 0; i < 6; i++) await placeOrder({ createdAt: sameInstant });

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const page: Awaited<ReturnType<typeof q.forCustomer>> =
        await q.forCustomer(CUSTOMER, {
          limit: 2,
          ...(cursor ? { before: decodeCursor(cursor)! } : {}),
        });
      seen.push(...page.orders.map((o) => o.id));
      cursor = page.nextCursor;
    } while (cursor && ++guard < 20);

    assert.equal(seen.length, 6, 'an order was lost at a timestamp tie');
    assert.equal(new Set(seen).size, 6);
  });
});

/* ------------------------------------------------------------------ */

describe('limits and scoping', () => {
  test('the page size is capped no matter what is asked for',
    { skip: skip() }, async () => {
      // An app requesting 10,000 rows would otherwise be served them, over a
      // Ghanaian mobile connection the customer is paying for.
      await clean();
      for (let i = 0; i < 60; i++) await placeOrder();

      const page = await q.forCustomer(CUSTOMER, { limit: 10_000 });
      assert.ok(page.orders.length <= 50, `got ${page.orders.length} rows`);
    });

  test('a nonsense limit does not produce an empty or broken page',
    { skip: skip() }, async () => {
      await clean();
      await placeOrder();
      for (const limit of [0, -5, Number.NaN]) {
        const page = await q.forCustomer(CUSTOMER, { limit });
        assert.ok(page.orders.length >= 1, `limit ${limit} returned nothing`);
      }
    });

  test('one customer never sees another customer\'s orders',
    { skip: skip() }, async () => {
      await clean();
      await placeOrder({ customerId: CUSTOMER });
      await placeOrder({ customerId: OTHER });

      const mine = await q.forCustomer(CUSTOMER);
      assert.equal(mine.orders.length, 1);
      assert.equal(mine.orders[0]!.customerId, CUSTOMER);
    });

  test('the scoping holds ACROSS pages', { skip: skip() }, async () => {
    // A cursor is client-supplied. It must move the window, never widen it
    // to somebody else's history.
    await clean();
    for (let i = 0; i < 6; i++) await placeOrder({ customerId: CUSTOMER });
    for (let i = 0; i < 6; i++) await placeOrder({ customerId: OTHER });

    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: Awaited<ReturnType<typeof q.forCustomer>> =
        await q.forCustomer(CUSTOMER, {
          limit: 2,
          ...(cursor ? { before: decodeCursor(cursor)! } : {}),
        });
      for (const o of page.orders) {
        assert.equal(o.customerId, CUSTOMER, 'leaked another customer\'s order');
      }
      cursor = page.nextCursor;
    } while (cursor && ++guard < 20);
  });

  test('active=true returns only orders still in flight',
    { skip: skip() }, async () => {
      await clean();
      await placeOrder({ state: 'delivered' });
      await placeOrder({ state: 'in_transit' });

      const active = await q.forCustomer(CUSTOMER, { active: true });
      assert.equal(active.orders.length, 1);
      assert.equal(active.orders[0]!.state, 'in_transit');

      const all = await q.forCustomer(CUSTOMER);
      assert.equal(all.orders.length, 2);
    });

  test('a customer with no orders gets an empty page, not an error',
    { skip: skip() }, async () => {
      await clean();
      const page = await q.forCustomer(CUSTOMER);
      assert.deepEqual(page.orders, []);
      assert.equal(page.nextCursor, null);
    });

  test('money stays a string all the way out', { skip: skip() }, async () => {
    // BIGINT via Number() silently loses precision above 2^53. The whole
    // ledger is integer pesewas, so this must never become a float.
    await clean();
    await placeOrder({ totalPesewas: 8150 });
    const page = await q.forCustomer(CUSTOMER);
    assert.equal(typeof page.orders[0]!.totalPesewas, 'string');
    assert.equal(page.orders[0]!.totalPesewas, '8150');
  });
});
