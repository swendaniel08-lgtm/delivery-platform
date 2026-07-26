/**
 * dedupe-redis.spec — shared notification dedupe, against a real Redis.
 *
 * This exists because of a bug that no unit test can see. The outbox relay is
 * at-least-once by design, so the same event arrives more than once. With the
 * in-memory store each replica keeps its own `Set`, so TWO replicas each treat
 * the same event as new: the customer gets two "your rider has arrived" texts
 * and Hubtel bills us for both.
 *
 * A single-process test passes happily in that world. Only two dispatchers
 * sharing one Redis can tell the difference, which is what this file sets up.
 *
 * Skips (exit 0) when no Redis is reachable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { RedisDedupeStore } from '../src/redis-dedupe-store.ts';
import { NotificationDispatcher, type DedupeStore } from '../src/dispatcher.ts';
import { InMemoryPushProvider } from '../src/dispatcher.ts';
import { InMemorySmsProvider } from '../../svc-identity/src/sms/provider.ts';

const HOST = process.env.REDIS_TEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_TEST_PORT ?? 56379);

/**
 * Probed synchronously at TOP LEVEL: node:test evaluates `{ skip }` while the
 * describe body registers, before any hook runs. Deciding liveness in a hook
 * makes every test skip unconditionally — a green light that cannot go red.
 */
function probe(): boolean {
  // A raw RESP PING over a socket, NOT `redis-cli`. The first version of this
  // shelled out to redis-cli, which is not installed here — so the probe
  // reported "no Redis" against a perfectly healthy server and every test
  // skipped. A skip that cannot be distinguished from a pass is exactly the
  // kind of green light this suite is supposed to prevent.
  try {
    const out = execFileSync(process.execPath, ['-e', `
      const net = require('net');
      const s = net.connect({ host: ${JSON.stringify(HOST)}, port: ${PORT} });
      s.setTimeout(2000);
      s.on('connect', () => s.write('PING\\r\\n'));
      s.on('data', (d) => { process.stdout.write(d.toString()); s.destroy(); });
      s.on('timeout', () => { s.destroy(); process.exit(1); });
      s.on('error', () => process.exit(1));
    `], { encoding: 'utf8', timeout: 4000 });
    return out.includes('PONG');
  } catch { return false; }
}

const live = probe();
if (!live) console.log(`# SKIP no Redis at ${HOST}:${PORT}`);
const skip = () => (live ? false : 'no Redis');

async function store(): Promise<{ s: DedupeStore; close: () => Promise<void> }> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis({ host: HOST, port: PORT, maxRetriesPerRequest: 3 });
  return {
    s: new RedisDedupeStore(redis as any),
    close: async () => { await redis.quit(); },
  };
}

const ctx = { humanRef: '#1234', vendorName: "Auntie Adwoa's", riderName: 'Kwame' };
const target = async () => ({ userId: 'u1', pushTokens: ['tok-1'], phone: '+233551234987' });

/* ------------------------------------------------------------------ */

describe('RedisDedupeStore', () => {
  test('the first claim wins and the second loses', { skip: skip() }, async () => {
    const { s, close } = await store();
    try {
      const key = `notify:test:${Date.now()}:${Math.random()}`;
      assert.equal(await s.claim(key, 60), true);
      assert.equal(await s.claim(key, 60), false);
    } finally { await close(); }
  });

  test('a concurrent burst produces EXACTLY one winner', { skip: skip() }, async () => {
    // SET NX is atomic; this is the property the whole design rests on.
    const { s, close } = await store();
    try {
      const key = `notify:burst:${Date.now()}:${Math.random()}`;
      const results = await Promise.all(
        Array.from({ length: 20 }, () => s.claim(key, 60)),
      );
      assert.equal(results.filter(Boolean).length, 1,
        'twenty simultaneous claims must yield one winner, not twenty');
    } finally { await close(); }
  });

  test('the claim expires so a key cannot be poisoned forever', { skip: skip() }, async () => {
    const { s, close } = await store();
    try {
      const key = `notify:ttl:${Date.now()}:${Math.random()}`;
      assert.equal(await s.claim(key, 1), true);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(await s.claim(key, 60), true, 'the TTL must release the key');
    } finally { await close(); }
  });

  test('different events do not collide', { skip: skip() }, async () => {
    const { s, close } = await store();
    try {
      const n = Date.now();
      assert.equal(await s.claim(`notify:a:${n}`, 60), true);
      assert.equal(await s.claim(`notify:b:${n}`, 60), true);
    } finally { await close(); }
  });
});

/* ------------------------------------------------------------------ */

describe('two replicas, one Redis', () => {
  /**
   * The actual bug. Two dispatchers — as two pods would be — handed the same
   * outbox event. Exactly one message must go out.
   */
  test('a redelivered event notifies ONCE across two replicas', { skip: skip() }, async () => {
    const a = await store();
    const b = await store();
    try {
      const pushA = new InMemoryPushProvider();
      const pushB = new InMemoryPushProvider();
      const smsA = new InMemorySmsProvider();
      const smsB = new InMemorySmsProvider();

      const replicaA = new NotificationDispatcher(pushA, smsA, a.s);
      const replicaB = new NotificationDispatcher(pushB, smsB, b.s);

      const event = {
        eventId: `evt-${Date.now()}-${Math.random()}`,
        eventType: 'order.arrived',
        context: ctx,
        resolve: target,
      };

      const [outA, outB] = await Promise.all([
        replicaA.handle(event),
        replicaB.handle(event),
      ]);

      const duplicates = [outA, outB].filter((o) => o.duplicate).length;
      assert.equal(duplicates, 1, 'exactly one replica must recognise the duplicate');

      const totalPushes = pushA.sent.length + pushB.sent.length;
      assert.equal(totalPushes, 1,
        `the customer must receive ONE arrival push, not ${totalPushes}`);
    } finally { await a.close(); await b.close(); }
  });

  test('a SECOND, different event still gets through', { skip: skip() }, async () => {
    // Dedupe must not degrade into a mute button.
    const a = await store();
    const b = await store();
    try {
      const pushA = new InMemoryPushProvider();
      const pushB = new InMemoryPushProvider();
      const replicaA = new NotificationDispatcher(pushA, new InMemorySmsProvider(), a.s);
      const replicaB = new NotificationDispatcher(pushB, new InMemorySmsProvider(), b.s);

      const n = Date.now();
      await replicaA.handle({
        eventId: `evt-x-${n}`, eventType: 'order.arrived', context: ctx, resolve: target,
      });
      await replicaB.handle({
        eventId: `evt-y-${n}`, eventType: 'order.picked_up', context: ctx, resolve: target,
      });

      assert.equal(pushA.sent.length, 1);
      assert.equal(pushB.sent.length, 1);
    } finally { await a.close(); await b.close(); }
  });
});

/* ------------------------------------------------------------------ */

describe('when Redis itself is down', () => {
  test('fails OPEN by default — a missed arrival is worse than a duplicate', async () => {
    // Deliberately asymmetric. A duplicate text costs a few pesewas; a
    // customer never hearing that their rider is outside costs cold food and
    // a support call. Point at a closed port to simulate the outage.
    const { default: Redis } = await import('ioredis');
    const redis = new Redis({
      host: '127.0.0.1', port: 1, maxRetriesPerRequest: 1,
      retryStrategy: () => null, lazyConnect: true,
      enableOfflineQueue: false,
    });
    redis.on('error', () => { /* expected */ });

    const s = new RedisDedupeStore(redis as any, true);
    assert.equal(await s.claim('notify:down', 60), true, 'must still send');
    redis.disconnect();
  });

  test('can be configured to fail CLOSED where duplicates are unacceptable', async () => {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis({
      host: '127.0.0.1', port: 1, maxRetriesPerRequest: 1,
      retryStrategy: () => null, lazyConnect: true,
      enableOfflineQueue: false,
    });
    redis.on('error', () => { /* expected */ });

    const s = new RedisDedupeStore(redis as any, false);
    assert.equal(await s.claim('notify:down', 60), false);
    redis.disconnect();
  });
});
