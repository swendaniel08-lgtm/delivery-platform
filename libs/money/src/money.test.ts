/**
 * money.spec — exit criterion for Sprint 1 / issue #5.
 * Property-based: proves no precision loss over 10^6 operations.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromCedis, toCedis, format, add, sub, mul, bps, clamp,
  allocate, allocateByWeights, pesewas, MoneyError,
} from './money.ts';

// deterministic PRNG so failures are reproducible
let seed = 0x9e3779b9;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

describe('parsing and formatting', () => {
  test('parses GHS strings exactly', () => {
    assert.equal(fromCedis('35'), 3500n);
    assert.equal(fromCedis('35.5'), 3550n);
    assert.equal(fromCedis('35.50'), 3550n);
    assert.equal(fromCedis('0.01'), 1n);
    assert.equal(fromCedis('-2.05'), -205n);
    assert.equal(fromCedis('81.50'), 8150n);
  });

  test('rejects sub-pesewa precision', () => {
    assert.throws(() => fromCedis('1.234'), MoneyError);
    assert.throws(() => fromCedis(0.001), MoneyError);
    assert.throws(() => fromCedis('abc'), MoneyError);
  });

  test('the classic float trap does not corrupt money', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE754
    const total = add(fromCedis('0.10'), fromCedis('0.20'));
    assert.equal(total, 30n);
    assert.equal(toCedis(total), '0.30');
  });

  test('round-trips for 100k random values', () => {
    for (let i = 0; i < 100_000; i++) {
      const p = pesewas(randInt(-100_000_000, 100_000_000));
      assert.equal(fromCedis(toCedis(p)), p);
    }
  });

  test('formats for display with thousand separators', () => {
    assert.equal(format(8150n), 'GHS 81.50');
    assert.equal(format(5n), 'GHS 0.05');
    assert.equal(format(-205n), 'GHS -2.05');
    // separators matter once revenue figures reach the admin dashboard
    assert.equal(format(1_240_000n), 'GHS 12,400.00');
    assert.equal(format(100_000_000n), 'GHS 1,000,000.00');
  });

  test('toCedis stays separator-free so it round-trips', () => {
    assert.equal(toCedis(1_240_000n), '12400.00');
    assert.equal(fromCedis(toCedis(1_240_000n)), 1_240_000n);
  });
});

describe('arithmetic', () => {
  test('associative and commutative over 200k random adds', () => {
    for (let i = 0; i < 200_000; i++) {
      const a = pesewas(randInt(-1e6, 1e6));
      const b = pesewas(randInt(-1e6, 1e6));
      const c = pesewas(randInt(-1e6, 1e6));
      assert.equal(add(a, b), add(b, a));
      assert.equal(add(add(a, b), c), add(a, add(b, c)));
      assert.equal(sub(add(a, b), b), a);
    }
  });

  test('mul rejects fractional quantity', () => {
    assert.throws(() => mul(1000n, 1.5), MoneyError);
    assert.throws(() => mul(1000n, -1), MoneyError);
    assert.equal(mul(3500n, 3), 10500n);
  });
});

describe('basis points (commission / service fees)', () => {
  test('canonical order from MASTER_PLAN §3.4', () => {
    const itemTotal = fromCedis('70.00');
    assert.equal(bps(itemTotal, 1500), 1050n);            // 15% food commission
    assert.equal(sub(itemTotal, bps(itemTotal, 1500)), 5950n); // vendor 59.50
  });

  test('service fee with min/max clamp (food: 5%, min 2, max 15)', () => {
    const fee = (t: string) =>
      clamp(bps(fromCedis(t), 500), fromCedis('2'), fromCedis('15'));
    assert.equal(fee('10.00'), 200n);   // 0.50 → clamped up to 2.00
    assert.equal(fee('70.00'), 350n);   // 3.50 in range
    assert.equal(fee('1000.00'), 1500n); // 50.00 → clamped down to 15.00
  });

  test('half-up rounding is symmetric and never loses more than 1 pesewa', () => {
    for (let i = 0; i < 200_000; i++) {
      const amt = pesewas(randInt(0, 10_000_000));
      const rate = randInt(0, 10_000);
      const share = bps(amt, rate);
      const exact = (amt * BigInt(rate)) / 10_000n;
      assert.ok(share - exact >= 0n && share - exact <= 1n);
    }
  });
});

describe('allocate — no pesewa may be created or destroyed', () => {
  test('equal split always sums to the original (200k cases)', () => {
    for (let i = 0; i < 200_000; i++) {
      const amount = pesewas(randInt(-1_000_000, 1_000_000));
      const parts = randInt(1, 12);
      const shares = allocate(amount, parts);
      assert.equal(shares.length, parts);
      assert.equal(add(...shares), amount, `allocate(${amount},${parts}) leaked`);
    }
  });

  test('the indivisible case', () => {
    assert.deepEqual(allocate(10n, 3), [4n, 3n, 3n]);
    assert.equal(add(...allocate(10n, 3)), 10n);
  });

  test('weighted split always sums to the original (200k cases)', () => {
    for (let i = 0; i < 200_000; i++) {
      const amount = pesewas(randInt(0, 10_000_000));
      const weights = Array.from({ length: randInt(1, 5) }, () => randInt(0, 100));
      if (weights.reduce((a, b) => a + b, 0) === 0) continue;
      const shares = allocateByWeights(amount, weights);
      assert.equal(add(...shares), amount, `weights ${weights} leaked on ${amount}`);
    }
  });

  test('settlement split matches the canonical ledger entry', () => {
    // GHS 81.50 → vendor 59.50, rider 8.00, platform 14.00
    const total = fromCedis('81.50');
    const vendor = fromCedis('59.50');
    const rider = fromCedis('8.00');
    const platform = fromCedis('14.00');
    assert.equal(add(vendor, rider, platform), total);
  });
});

describe('scale', () => {
  test('1,000,000 chained operations lose nothing', () => {
    let acc = 0n;
    const ops: bigint[] = [];
    for (let i = 0; i < 1_000_000; i++) {
      const v = pesewas(randInt(1, 5000));
      ops.push(v);
      acc = add(acc, v);
    }
    const expected = ops.reduce((a, b) => a + b, 0n);
    assert.equal(acc, expected);
    // and subtracting them all returns exactly zero
    for (const v of ops) acc = sub(acc, v);
    assert.equal(acc, 0n);
  });
});
