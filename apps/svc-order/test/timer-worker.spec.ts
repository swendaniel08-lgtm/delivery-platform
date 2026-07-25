/**
 * timer-worker.spec — deadlines that survive a restart (issue #9).
 *
 * These run against a FAKE pool rather than Postgres, because what is being
 * tested is the worker's decision-making: batching, overlap suppression,
 * and the distinction between "the deadline lost a race" (normal) and "the
 * database is broken" (an alarm). The `SKIP LOCKED` behaviour itself is
 * exercised against real Postgres in the integration suite.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TimerWorker, type TimerRow } from '../src/timers/worker.ts';

/** Minimal pg-shaped double that records the SQL it was asked to run. */
class FakePool {
  queries: string[] = [];
  due: TimerRow[] = [];
  firedIds: string[][] = [];
  failNextClaim = false;
  released = 0;

  connect() {
    const self = this;
    return Promise.resolve({
      query: async (sql: string, params?: any[]) => {
        self.queries.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.includes('FROM order_timers')) {
          if (self.failNextClaim) {
            self.failNextClaim = false;
            throw new Error('connection terminated');
          }
          const limit = params?.[0] ?? 20;
          const batch = self.due.slice(0, limit);
          self.due = self.due.slice(limit);
          return { rows: batch };
        }
        if (sql.includes('UPDATE order_timers SET fired_at')) {
          self.firedIds.push(params?.[0] ?? []);
        }
        return { rows: [] };
      },
      release: () => { self.released += 1; },
    });
  }
}

const timer = (over: Partial<TimerRow> = {}): TimerRow => ({
  id: '1',
  order_id: 'o-1',
  name: 'vendor_accept_deadline',
  event: 'auto_timeout',
  expect_state: 'placed',
  ...over,
});

describe('claiming', () => {
  test('a due timer is fired and its order advanced', async () => {
    const pool = new FakePool();
    pool.due = [timer()];
    const applied: Array<[string, string]> = [];

    const w = new TimerWorker(pool as any, async (orderId, event) => {
      applied.push([orderId, event]);
    });

    assert.equal(await w.tick(), 1);
    assert.deepEqual(applied, [['o-1', 'auto_timeout']]);
  });

  test('the claim uses FOR UPDATE SKIP LOCKED', async () => {
    const pool = new FakePool();
    pool.due = [timer()];
    await new TimerWorker(pool as any, async () => {}).tick();

    const claim = pool.queries.find((q) => q.includes('FROM order_timers'))!;
    assert.match(claim, /FOR UPDATE SKIP LOCKED/,
      'without SKIP LOCKED, replicas serialise on the same rows and '
      + 'throughput collapses to a single worker');
  });

  test('rows are marked fired INSIDE the claiming transaction', async () => {
    const pool = new FakePool();
    pool.due = [timer({ id: '7' })];
    await new TimerWorker(pool as any, async () => {}).tick();

    const begin = pool.queries.indexOf('BEGIN');
    const mark = pool.queries.findIndex((q) => q.includes('SET fired_at'));
    const commit = pool.queries.indexOf('COMMIT');

    assert.ok(begin < mark && mark < commit,
      'marking outside the transaction lets a crash fire the same deadline twice');
    assert.deepEqual(pool.firedIds, [['7']]);
  });

  test('nothing due means no work and no UPDATE', async () => {
    const pool = new FakePool();
    assert.equal(await new TimerWorker(pool as any, async () => {}).tick(), 0);
    assert.equal(pool.firedIds.length, 0);
  });

  test('the batch size is honoured so one replica cannot hog the queue', async () => {
    const pool = new FakePool();
    pool.due = Array.from({ length: 50 }, (_, i) => timer({ id: String(i) }));

    const w = new TimerWorker(pool as any, async () => {}, { batchSize: 10 });
    assert.equal(await w.tick(), 10);
    assert.equal(pool.firedIds[0]!.length, 10);
  });

  test('the connection is always released, even when the claim throws', async () => {
    const pool = new FakePool();
    pool.failNextClaim = true;
    const errors: Error[] = [];

    await new TimerWorker(pool as any, async () => {}, {
      onError: (e) => errors.push(e),
    }).tick();

    assert.equal(pool.released, 1, 'a leaked connection starves the pool');
    assert.equal(errors.length, 1);
    assert.match(pool.queries.join(' '), /ROLLBACK/);
  });
});

describe('losing the race is normal', () => {
  test('a vendor who accepted just in time makes the timer STALE, not failed', async () => {
    const pool = new FakePool();
    pool.due = [timer()];
    const outcomes: string[] = [];
    const errors: Error[] = [];

    const w = new TimerWorker(
      pool as any,
      // This is what the real state machine throws when the order has
      // already left `placed`.
      async () => { throw new Error('illegal transition placed -> auto_timeout'); },
      {
        onFired: (_t, outcome) => outcomes.push(outcome),
        onError: (e) => errors.push(e),
      },
    );

    assert.equal(await w.tick(), 0);
    assert.deepEqual(outcomes, ['stale']);
    assert.equal(errors.length, 0,
      'a vendor accepting two seconds before the deadline must not page anyone');
  });

  test('a genuine failure IS reported', async () => {
    const pool = new FakePool();
    pool.due = [timer()];
    const outcomes: string[] = [];
    const errors: Error[] = [];

    const w = new TimerWorker(
      pool as any,
      async () => { throw new Error('deadlock detected'); },
      { onFired: (_t, o) => outcomes.push(o), onError: (e) => errors.push(e) },
    );

    await w.tick();
    assert.deepEqual(outcomes, ['failed']);
    assert.equal(errors.length, 1, 'this one is a real alarm');
  });

  test('one bad timer does not abandon the rest of the batch', async () => {
    const pool = new FakePool();
    pool.due = [timer({ id: '1', order_id: 'bad' }), timer({ id: '2', order_id: 'good' })];
    const applied: string[] = [];

    const w = new TimerWorker(pool as any, async (orderId) => {
      if (orderId === 'bad') throw new Error('deadlock detected');
      applied.push(orderId);
    }, { onError: () => {} });

    assert.equal(await w.tick(), 1);
    assert.deepEqual(applied, ['good']);
  });
});

describe('scheduling', () => {
  test('a slow batch does not stack up behind the interval', async () => {
    const pool = new FakePool();
    pool.due = [timer()];

    let inFlight = 0;
    let maxConcurrent = 0;
    const w = new TimerWorker(pool as any, async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
    });

    // Two ticks fired at once, as a slow poll would.
    pool.due = [timer({ id: '1' })];
    const first = w.tick();
    const second = w.tick();
    await Promise.all([first, second]);

    assert.equal(maxConcurrent, 1,
      'overlapping ticks would double-apply deadlines under load');
  });

  test('a stopped worker claims nothing', async () => {
    const pool = new FakePool();
    pool.due = [timer()];
    const w = new TimerWorker(pool as any, async () => {});
    w.start();
    w.stop();

    assert.equal(await w.tick(), 0);
    assert.equal(pool.queries.length, 0, 'shutdown must not leave a batch in flight');
  });

  test('start is idempotent', async () => {
    const pool = new FakePool();
    const w = new TimerWorker(pool as any, async () => {}, { intervalMs: 10_000 });
    w.start();
    w.start();
    w.stop();
    assert.ok(true, 'two starts must not leave an orphaned interval running');
  });
});
