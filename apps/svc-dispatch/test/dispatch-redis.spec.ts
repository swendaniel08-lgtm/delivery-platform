/**
 * dispatch-redis.spec — the race against REAL Redis.
 *
 * The in-memory test proves the logic; this proves the primitive. Multiple
 * API instances hitting one Redis is the actual production topology, and
 * SET NX is the only thing standing between us and a double assignment.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { DispatchService } from '../src/dispatch.ts';
import { RedisClaimStore } from '../src/redis-claim-store.ts';

const URL = process.env.DISPATCH_TEST_REDIS ?? 'redis://localhost:56379';
let redis: Redis | undefined;
let up = false;

before(async () => {
  try {
    redis = new Redis(URL, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.flushall();
    up = true;
  } catch { up = false; }
});
after(async () => { await redis?.quit(); });

describe('atomic claim against real Redis (closes issue #7)', () => {
  test('100 concurrent accepts across simulated instances → exactly 1 winner', async (t) => {
    if (!up) return t.skip('no redis');

    const N = 100;
    // each "instance" gets its own connection, like separate pods
    const conns = Array.from({ length: 10 }, () => new Redis(URL));
    try {
      const services = conns.map((c) => new DispatchService(new RedisClaimStore(c)));
      const riderIds = Array.from({ length: N }, (_, i) => `r${i}`);

      await redis!.set('assignment:legR:offer', JSON.stringify({
        legId: 'legR', orderId: 'oR', round: 1, riderIds, expiresAtMs: Date.now() + 30_000,
      }), 'PX', 30_000);

      const outcomes = await Promise.all(
        riderIds.map((id, i) => services[i % services.length]!.accept('legR', id)),
      );

      const winners = outcomes.filter((o) => o.won);
      assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);

      const stored = await redis!.get('assignment:legR:winner');
      assert.equal(stored, winners[0]!.winnerRiderId, 'redis must agree with the caller');

      for (const l of outcomes.filter((o) => !o.won)) {
        assert.equal(l.winnerRiderId, stored);
      }
    } finally {
      await Promise.all(conns.map((c) => c.quit()));
    }
  });

  test('repeated rounds never double-assign', async (t) => {
    if (!up) return t.skip('no redis');
    for (let trial = 0; trial < 25; trial++) {
      const leg = `legT${trial}`;
      const ids = ['a', 'b', 'c', 'd', 'e'];
      await redis!.set(`assignment:${leg}:offer`, JSON.stringify({
        legId: leg, orderId: 'o', round: 1, riderIds: ids, expiresAtMs: Date.now() + 30_000,
      }), 'PX', 30_000);
      const svc = new DispatchService(new RedisClaimStore(redis!));
      const res = await Promise.all(ids.map((id) => svc.accept(leg, id)));
      assert.equal(res.filter((r) => r.won).length, 1, `trial ${trial} double-assigned`);
    }
  });

  test('Redis GEO returns riders nearest-first', async (t) => {
    if (!up) return t.skip('no redis');
    const svc = new DispatchService(new RedisClaimStore(redis!));
    await svc.updatePosition('near', { lat: 5.5565, lng: -0.1825 });
    await svc.updatePosition('mid',  { lat: 5.5700, lng: -0.1800 });
    await svc.updatePosition('far',  { lat: 5.9000, lng: -0.5000 });
    const ids = await svc.nearbyRiderIds({ lat: 5.5560, lng: -0.1821 }, 3000);
    assert.deepEqual(ids, ['near', 'mid']);
  });

  test('claim TTL expires so a stuck leg is recoverable', async (t) => {
    if (!up) return t.skip('no redis');
    await redis!.set('assignment:legTTL:winner', 'r1', 'PX', 300, 'NX');
    assert.equal(await redis!.get('assignment:legTTL:winner'), 'r1');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await redis!.get('assignment:legTTL:winner'), null);
  });
});
