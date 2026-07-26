/**
 * pg-chat-store.spec — chat transcripts against real Postgres.
 *
 * A chat transcript is dispute evidence. "The rider says I told him to leave
 * it at the gate" is settled by the transcript or it is not settled at all.
 * Until now those messages lived in a process-local array that every redeploy
 * erased, so the cases below are less about CRUD and more about:
 *
 *   • surviving a restart at all
 *   • two people opening the same thread at the same instant
 *   • the 30-minute close window (PDF §9) not drifting when an at-least-once
 *     event is redelivered
 *   • unread counts that do not mark your own messages read
 *
 * Skips (exit 0) when no Postgres is reachable.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { PgChatStore } from '../src/pg-chat-store.ts';
import { canChat, CHAT_GRACE_MINUTES } from '../src/dispatcher.ts';

const ROOT = join(import.meta.dirname, '../../..');
const HOST = process.env.PG_TEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PG_TEST_PORT ?? 55440);
const DSN = `postgresql://postgres:pw@${HOST}:${PORT}/chat_spec`;

/** Synchronous, at top level — see the note in pg-tracking-store.spec. */
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

const ORDER = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const RIDER = '11111111-1111-4111-8111-111111111111';

let pool: pg.Pool;
let store: PgChatStore;

before(async () => {
  if (!live) return;
  const admin = new pg.Pool({
    connectionString: `postgresql://postgres:pw@${HOST}:${PORT}/postgres`,
    connectionTimeoutMillis: 15_000,
  });
  await admin.query('DROP DATABASE IF EXISTS chat_spec');
  await admin.query('CREATE DATABASE chat_spec');
  await admin.end();

  pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 15_000 });
  await pool.query(
    readFileSync(join(ROOT, 'apps/svc-messaging/migrations/001_messaging.sql'), 'utf8'),
  );
  store = new PgChatStore(pool);
});

after(async () => { if (live && pool) await pool.end(); });

async function clean() {
  await pool.query('DELETE FROM chat_messages');
  await pool.query('DELETE FROM chat_threads');
}

/* ------------------------------------------------------------------ */

describe('threads', () => {
  test('a thread is created on first open', { skip: skip() }, async () => {
    await clean();
    const r = await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER, counterpartyId: RIDER,
    });
    assert.equal(r.created, true);
    assert.ok(r.id);
  });

  test('opening twice returns the SAME thread', { skip: skip() }, async () => {
    await clean();
    const a = await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    const b = await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    assert.equal(a.id, b.id);
    assert.equal(b.created, false, 'the second open is not a creation');
  });

  test('two participants opening at the SAME INSTANT do not collide',
    { skip: skip() }, async () => {
      // The customer taps "message rider" while the rider taps "message
      // customer". A check-then-insert would let both through and violate
      // UNIQUE (order_id, pair); ON CONFLICT makes it a non-event.
      await clean();
      const open = () => store.openThread({
        orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
      });
      const results = await Promise.all([open(), open(), open(), open()]);
      const ids = new Set(results.map((r) => r.id));
      assert.equal(ids.size, 1, 'all four must land on one thread');
      assert.equal(results.filter((r) => r.created).length, 1,
        'exactly one of them created it');
    });

  test('the two pairs are separate conversations', { skip: skip() }, async () => {
    // customer↔rider and customer↔vendor must never bleed into each other:
    // the customer's complaint about the restaurant is not for the rider.
    await clean();
    const a = await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    const b = await store.openThread({
      orderId: ORDER, pair: 'customer_vendor', customerId: CUSTOMER,
    });
    assert.notEqual(a.id, b.id);
  });

  test('a counterparty learned later is filled in, not overwritten with null',
    { skip: skip() }, async () => {
      // The thread may open before a rider is assigned.
      await clean();
      await store.openThread({
        orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
      });
      await store.openThread({
        orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
        counterpartyId: RIDER,
      });
      const { rows } = await pool.query(
        'SELECT counterparty_id FROM chat_threads WHERE order_id = $1', [ORDER],
      );
      assert.equal(rows[0]!.counterparty_id, RIDER);

      // And a later call without one must not erase it.
      await store.openThread({
        orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
      });
      const after = await pool.query(
        'SELECT counterparty_id FROM chat_threads WHERE order_id = $1', [ORDER],
      );
      assert.equal(after.rows[0]!.counterparty_id, RIDER);
    });

  test('an unopened thread is null, not an empty window', { skip: skip() }, async () => {
    // Null means "can still be opened"; a closed window cannot. Conflating
    // them would either block a legitimate chat or reopen a closed one.
    await clean();
    assert.equal(await store.window(ORDER, 'customer_rider'), null);
  });
});

/* ------------------------------------------------------------------ */

describe('messages', () => {
  test('a message survives a "restart"', { skip: skip() }, async () => {
    await clean();
    await store.append({
      orderId: ORDER, pair: 'customer_rider', from: 'customer',
      fromUserId: CUSTOMER, body: 'Please leave it at the gate',
    });

    // A brand-new store object on the same database — the whole point.
    const afterRestart = new PgChatStore(pool);
    const history = await afterRestart.history(ORDER, 'customer_rider');
    assert.equal(history.length, 1);
    assert.equal(history[0]!.body, 'Please leave it at the gate');
  });

  test('the transcript is ordered oldest first', { skip: skip() }, async () => {
    await clean();
    for (const body of ['first', 'second', 'third']) {
      await store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'customer',
        fromUserId: CUSTOMER, body,
      });
    }
    const h = await store.history(ORDER, 'customer_rider');
    assert.deepEqual(h.map((m) => m.body), ['first', 'second', 'third']);
  });

  test('appending creates the thread on demand', { skip: skip() }, async () => {
    // Requiring a separate open call is one more round trip that can fail
    // between the two.
    await clean();
    const r = await store.append({
      orderId: ORDER, pair: 'customer_vendor', from: 'customer',
      fromUserId: CUSTOMER, body: 'No pepper please',
    });
    assert.ok(r.id);
    assert.ok(await store.window(ORDER, 'customer_vendor'));
  });

  test('an image-only message is allowed', { skip: skip() }, async () => {
    await clean();
    await store.append({
      orderId: ORDER, pair: 'customer_rider', from: 'rider',
      fromUserId: RIDER, imageUrl: 'chat_image/ord-1/a.jpg',
    });
    const [m] = await store.history(ORDER, 'customer_rider');
    assert.equal(m!.imageUrl, 'chat_image/ord-1/a.jpg');
    assert.equal(m!.body, undefined);
  });

  test('an EMPTY message is refused by the database', { skip: skip() }, async () => {
    // A message with neither text nor image is meaningless, and the CHECK
    // constraint is what guarantees the transcript has no blank rows in it.
    await clean();
    await assert.rejects(
      () => store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'customer',
        fromUserId: CUSTOMER,
      }),
      /chat_message_has_content/,
    );
  });

  test('a whitespace-only message is refused too', { skip: skip() }, async () => {
    await clean();
    await assert.rejects(
      () => store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'customer',
        fromUserId: CUSTOMER, body: '     ',
      }),
      /chat_message_has_content/,
    );
  });

  test('an over-long message is refused', { skip: skip() }, async () => {
    await clean();
    await assert.rejects(
      () => store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'customer',
        fromUserId: CUSTOMER, body: 'x'.repeat(1001),
      }),
      /chat_message_length/,
    );
  });

  test('history is bounded', { skip: skip() }, async () => {
    // A three-day laundry thread must not be shipped whole to a phone on a
    // Ghanaian mobile connection.
    await clean();
    for (let i = 0; i < 30; i++) {
      await store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'customer',
        fromUserId: CUSTOMER, body: `msg ${i}`,
      });
    }
    assert.equal((await store.history(ORDER, 'customer_rider', 10)).length, 10);
  });

  test('the two pairs keep separate transcripts', { skip: skip() }, async () => {
    await clean();
    await store.append({
      orderId: ORDER, pair: 'customer_rider', from: 'customer',
      fromUserId: CUSTOMER, body: 'to the rider',
    });
    await store.append({
      orderId: ORDER, pair: 'customer_vendor', from: 'customer',
      fromUserId: CUSTOMER, body: 'to the vendor',
    });
    const toRider = await store.history(ORDER, 'customer_rider');
    assert.equal(toRider.length, 1);
    assert.equal(toRider[0]!.body, 'to the rider');
  });
});

/* ------------------------------------------------------------------ */

describe('read state', () => {
  test('reading marks the OTHER party\'s messages, not your own',
    { skip: skip() }, async () => {
      // Marking your own messages read would make the other side's unread
      // badge wrong.
      await clean();
      await store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'customer',
        fromUserId: CUSTOMER, body: 'mine',
      });
      await store.append({
        orderId: ORDER, pair: 'customer_rider', from: 'rider',
        fromUserId: RIDER, body: 'theirs',
      });

      const marked = await store.markRead(ORDER, 'customer_rider', 'customer');
      assert.equal(marked, 1, 'only the rider\'s message');

      const h = await store.history(ORDER, 'customer_rider');
      assert.equal(h.find((m) => m.body === 'theirs')!.read, true);
      assert.equal(h.find((m) => m.body === 'mine')!.read, false);
    });

  test('the unread count is per reader', { skip: skip() }, async () => {
    await clean();
    await store.append({
      orderId: ORDER, pair: 'customer_rider', from: 'rider',
      fromUserId: RIDER, body: 'on my way',
    });
    await store.append({
      orderId: ORDER, pair: 'customer_rider', from: 'rider',
      fromUserId: RIDER, body: 'outside now',
    });
    assert.equal(await store.unreadCount(ORDER, 'customer_rider', 'customer'), 2);
    assert.equal(await store.unreadCount(ORDER, 'customer_rider', 'rider'), 0);
  });

  test('marking read twice is idempotent', { skip: skip() }, async () => {
    await clean();
    await store.append({
      orderId: ORDER, pair: 'customer_rider', from: 'rider',
      fromUserId: RIDER, body: 'hello',
    });
    assert.equal(await store.markRead(ORDER, 'customer_rider', 'customer'), 1);
    assert.equal(await store.markRead(ORDER, 'customer_rider', 'customer'), 0);
  });
});

/* ------------------------------------------------------------------ */

describe('the 30-minute close window (PDF §9)', () => {
  test('delivery starts the clock', { skip: skip() }, async () => {
    await clean();
    await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    const at = new Date();
    await store.markDelivered(ORDER, at);

    const w = await store.window(ORDER, 'customer_rider');
    assert.ok(w!.deliveredAt);
    assert.ok(Math.abs(w!.deliveredAt!.getTime() - at.getTime()) < 1000);
  });

  test('a REDELIVERED delivery event cannot extend the window',
    { skip: skip() }, async () => {
      // The outbox relay is at-least-once, so order.delivered WILL arrive
      // twice. Without the `delivered_at IS NULL` guard the second one would
      // push the deadline later and quietly reopen a chat that should be
      // shut.
      await clean();
      await store.openThread({
        orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
      });
      const first = new Date(Date.now() - 20 * 60_000);
      await store.markDelivered(ORDER, first);
      await store.markDelivered(ORDER, new Date());

      const w = await store.window(ORDER, 'customer_rider');
      assert.ok(Math.abs(w!.deliveredAt!.getTime() - first.getTime()) < 1000,
        'the original delivery time must stand');
    });

  test('the stored deadline matches the policy', { skip: skip() }, async () => {
    await clean();
    await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    const at = new Date();
    await store.markDelivered(ORDER, at);

    const { rows } = await pool.query<{ closes_at: Date }>(
      'SELECT closes_at FROM chat_threads WHERE order_id = $1', [ORDER],
    );
    const minutes = (rows[0]!.closes_at.getTime() - at.getTime()) / 60_000;
    assert.ok(Math.abs(minutes - CHAT_GRACE_MINUTES) < 0.1,
      `expected ${CHAT_GRACE_MINUTES} minutes, got ${minutes}`);
  });

  test('the domain rule agrees with the stored window', { skip: skip() }, async () => {
    // The persistence layer and canChat() must not disagree about whether a
    // chat is open — that is how a customer gets a "send" button that 403s.
    await clean();
    await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    await store.markDelivered(ORDER, new Date(Date.now() - 45 * 60_000));

    const w = await store.window(ORDER, 'customer_rider');
    assert.equal(canChat(w!, 'customer', new Date()).allowed, false,
      '45 minutes after delivery the chat is shut');
  });

  test('a chat still open before the grace period expires',
    { skip: skip() }, async () => {
      await clean();
      await store.openThread({
        orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
      });
      await store.markDelivered(ORDER, new Date(Date.now() - 10 * 60_000));
      const w = await store.window(ORDER, 'customer_rider');
      assert.equal(canChat(w!, 'customer', new Date()).allowed, true);
    });

  test('the purge job can find elapsed threads', { skip: skip() }, async () => {
    await clean();
    await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    await store.markDelivered(ORDER, new Date(Date.now() - 60 * 60_000));
    assert.deepEqual(await store.closedBefore(new Date()), [ORDER]);
  });

  test('an undelivered thread is never purged', { skip: skip() }, async () => {
    // closes_at is null until delivery; an in-flight order must not be swept.
    await clean();
    await store.openThread({
      orderId: ORDER, pair: 'customer_rider', customerId: CUSTOMER,
    });
    assert.deepEqual(await store.closedBefore(new Date()), []);
  });
});
