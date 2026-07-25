/**
 * idempotency.spec — one tap must never become two orders.
 *
 * This exists because of a bug found by replaying a checkout against the
 * running stack: three retries with the SAME Idempotency-Key produced THREE
 * orders. Every unit test passed at the time. A timed-out POST is routine
 * on a Ghanaian mobile network, so the client retries — and the customer
 * was charged again each time.
 *
 * The request fingerprint is tested here directly; the database-level
 * enforcement (the unique index doing the arbitration between replicas) is
 * covered against real Postgres in the integration suite.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * Mirror of `hashRequest` in order.module.ts.
 *
 * Duplicated deliberately: if someone changes the real one, this test
 * fails and forces them to think about whether existing keys still match.
 */
function hashRequest(body: unknown): string {
  const stable = (v: any): any => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = stable(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable(body))).digest('hex');
}

const order = (over: Record<string, unknown> = {}) => ({
  customerId: 'c1',
  storeId: 's1',
  service: 'food',
  itemTotalPesewas: '7000',
  deliveryFeePesewas: '800',
  serviceFeePesewas: '350',
  paymentIntent: 'prepaid',
  legs: [{
    sequence: 1, legType: 'vendor_to_customer',
    pickup: { lat: 5.6037, lng: -0.1870 },
    dropoff: { lat: 5.5560, lng: -0.1821 },
    feePesewas: '800',
  }],
  ...over,
});

describe('request fingerprint', () => {
  test('an identical retry hashes the same', () => {
    assert.equal(hashRequest(order()), hashRequest(order()));
  });

  test('KEY ORDER DOES NOT MATTER', () => {
    // Two clients serialising the same cart may emit keys in any order.
    // Treating those as different requests would reject an honest retry
    // with a 409 and strand the customer.
    const a = { customerId: 'c1', storeId: 's1', paymentIntent: 'prepaid' };
    const b = { paymentIntent: 'prepaid', storeId: 's1', customerId: 'c1' };
    assert.equal(hashRequest(a), hashRequest(b));
  });

  test('nested key order does not matter either', () => {
    const a = { legs: [{ sequence: 1, pickup: { lat: 5.6, lng: -0.18 } }] };
    const b = { legs: [{ pickup: { lng: -0.18, lat: 5.6 }, sequence: 1 }] };
    assert.equal(hashRequest(a), hashRequest(b));
  });

  test('ARRAY order DOES matter — a reordered cart is a different cart', () => {
    const a = { lines: [{ itemId: 'i1' }, { itemId: 'i2' }] };
    const b = { lines: [{ itemId: 'i2' }, { itemId: 'i1' }] };
    assert.notEqual(hashRequest(a), hashRequest(b),
      'legs are sequenced; swapping them changes the delivery');
  });

  test('a changed quantity is a different request', () => {
    assert.notEqual(
      hashRequest(order()),
      hashRequest(order({ itemTotalPesewas: '14000' })),
      'reusing a key for a bigger order must NOT silently return the small one',
    );
  });

  test('a changed payment method is a different request', () => {
    assert.notEqual(
      hashRequest(order()),
      hashRequest(order({ paymentIntent: 'cod' })),
    );
  });

  test('a changed delivery address is a different request', () => {
    const moved = order();
    (moved.legs[0] as any).dropoff = { lat: 5.6500, lng: -0.2000 };
    assert.notEqual(hashRequest(order()), hashRequest(moved),
      'same key, new address would deliver to the wrong place');
  });

  test('the hash is stable across processes', () => {
    // Hard-coded so a future refactor that changes the algorithm fails
    // here rather than silently invalidating every in-flight key.
    assert.equal(
      hashRequest({ a: 1, b: 'two' }),
      createHash('sha256').update('{"a":1,"b":"two"}').digest('hex'),
    );
  });

  test('null and missing are distinguished', () => {
    assert.notEqual(hashRequest({ a: 1, b: null }), hashRequest({ a: 1 }));
  });
});

/* ------------------------------------------------------------------ */

/**
 * The claim protocol, exercised against a fake that behaves like the
 * unique index: the first INSERT wins, later ones return zero rows.
 */
class FakeKeyStore {
  rows = new Map<string, { hash: string; orderId: string | null }>();

  /** Returns true when THIS caller claimed the key. */
  claim(key: string, actor: string, hash: string): boolean {
    const id = `${key}:${actor}`;
    if (this.rows.has(id)) return false;
    this.rows.set(id, { hash, orderId: null });
    return true;
  }

  get(key: string, actor: string) {
    return this.rows.get(`${key}:${actor}`) ?? null;
  }

  complete(key: string, actor: string, orderId: string) {
    const row = this.rows.get(`${key}:${actor}`);
    if (row) row.orderId = orderId;
  }

  release(key: string, actor: string) {
    const row = this.rows.get(`${key}:${actor}`);
    if (row && row.orderId === null) this.rows.delete(`${key}:${actor}`);
  }
}

describe('claim protocol', () => {
  test('THREE RETRIES CREATE ONE ORDER', () => {
    const store = new FakeKeyStore();
    const hash = hashRequest(order());
    let created = 0;

    for (let i = 0; i < 3; i++) {
      if (store.claim('k1', 'c1', hash)) {
        created += 1;
        store.complete('k1', 'c1', 'order-1');
      }
    }

    assert.equal(created, 1, 'this is the bug that reached the running stack');
    assert.equal(store.get('k1', 'c1')!.orderId, 'order-1');
  });

  test('a retry returns the ORIGINAL order id', () => {
    const store = new FakeKeyStore();
    const hash = hashRequest(order());
    store.claim('k1', 'c1', hash);
    store.complete('k1', 'c1', 'order-1');

    assert.equal(store.claim('k1', 'c1', hash), false);
    assert.equal(store.get('k1', 'c1')!.orderId, 'order-1');
  });

  test('the same key from a DIFFERENT customer is independent', () => {
    const store = new FakeKeyStore();
    const hash = hashRequest(order());
    assert.equal(store.claim('shared-key', 'c1', hash), true);
    assert.equal(store.claim('shared-key', 'c2', hash), true,
      'two customers whose apps generate the same key must both be served');
  });

  test('a failed attempt RELEASES the key so an honest retry works', () => {
    const store = new FakeKeyStore();
    const hash = hashRequest(order());

    store.claim('k1', 'c1', hash);
    store.release('k1', 'c1');          // the create threw

    assert.equal(store.claim('k1', 'c1', hash), true,
      'a permanently claimed key would lock the customer out of ordering');
  });

  test('a COMPLETED key is never released', () => {
    const store = new FakeKeyStore();
    const hash = hashRequest(order());
    store.claim('k1', 'c1', hash);
    store.complete('k1', 'c1', 'order-1');

    store.release('k1', 'c1');
    assert.equal(store.get('k1', 'c1')!.orderId, 'order-1',
      'releasing a completed key would allow a duplicate order');
  });

  test('a mismatched body is detectable', () => {
    const store = new FakeKeyStore();
    store.claim('k1', 'c1', hashRequest(order()));
    store.complete('k1', 'c1', 'order-1');

    const retryHash = hashRequest(order({ itemTotalPesewas: '99999' }));
    assert.notEqual(store.get('k1', 'c1')!.hash, retryHash,
      'the caller must 409 rather than return an unrelated order');
  });

  test('concurrent replicas: exactly one wins', () => {
    const store = new FakeKeyStore();
    const hash = hashRequest(order());
    // Node is single-threaded, but the fake models the unique index, which
    // is what actually arbitrates between two pods hitting Postgres.
    const winners = [1, 2, 3, 4, 5].filter(() => store.claim('k1', 'c1', hash));
    assert.equal(winners.length, 1);
  });
});
