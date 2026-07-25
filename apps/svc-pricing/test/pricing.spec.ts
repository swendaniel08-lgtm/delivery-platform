/** pricing.spec — verifies every figure in PDF §6 and the settlement invariant. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deliveryFee, serviceFee, commission, quote, parcelQuote, errandQuote,
  codEligible, DEFAULT_PRICING, PricingError,
} from '../src/pricing.ts';
import { fromCedis, toCedis, add, pesewas } from '../../../libs/money/src/money.ts';

describe('delivery fee tiers (PDF §6)', () => {
  test('0–3 km: base 5.00 + 1.50/km', () => {
    assert.equal(toCedis(deliveryFee(1_000)), '6.50');   // 5 + 1×1.5
    assert.equal(toCedis(deliveryFee(3_000)), '9.50');   // 5 + 3×1.5
  });

  test('3–7 km: base 8.00 + 1.20/km', () => {
    assert.equal(toCedis(deliveryFee(5_000)), '14.00');  // 8 + 5×1.2
  });

  test('7–15 km: base 12.00 + 1.00/km', () => {
    assert.equal(toCedis(deliveryFee(10_000)), '22.00'); // 12 + 10×1.0
  });

  test('15 km+: base 18.00 + 0.80/km', () => {
    assert.equal(toCedis(deliveryFee(20_000)), '34.00'); // 18 + 20×0.8
  });

  test('partial kilometres round up — never under-charge the rider', () => {
    assert.equal(toCedis(deliveryFee(2_100)), '9.50');   // charged as 3 km
  });

  test('rejects nonsense distances', () => {
    assert.throws(() => deliveryFee(-1), PricingError);
    assert.throws(() => deliveryFee(NaN), PricingError);
  });
});

describe('surcharges', () => {
  test('peak adds 20%', () => {
    const base = deliveryFee(3_000);                       // 9.50
    const peak = deliveryFee(3_000, { peak: true });       // 11.40
    assert.equal(toCedis(peak), '11.40');
    assert.ok(peak > base);
  });

  test('night adds 25%', () => {
    assert.equal(toCedis(deliveryFee(3_000, { night: true })), '11.88');
  });

  test('peak + night compound additively (+45%), not multiplicatively', () => {
    assert.equal(toCedis(deliveryFee(3_000, { peak: true, night: true })), '13.78');
  });

  test('fragile and heavy are flat additions', () => {
    assert.equal(toCedis(deliveryFee(3_000, { fragile: true })), '19.50');
    assert.equal(toCedis(deliveryFee(3_000, { heavy: true })), '14.50');
  });
});

describe('service fees (PDF §6)', () => {
  test('food 5% with GHS 2 floor and GHS 15 ceiling', () => {
    assert.equal(toCedis(serviceFee(fromCedis('10'), 'food')), '2.00');    // clamped up
    assert.equal(toCedis(serviceFee(fromCedis('70'), 'food')), '3.50');    // in band
    assert.equal(toCedis(serviceFee(fromCedis('1000'), 'food')), '15.00'); // clamped down
  });

  test('groceries 4%, pharmacy 4%, market list 7%', () => {
    assert.equal(toCedis(serviceFee(fromCedis('100'), 'groceries')), '4.00');
    assert.equal(toCedis(serviceFee(fromCedis('100'), 'pharmacy')), '4.00');
    assert.equal(toCedis(serviceFee(fromCedis('100'), 'market_list')), '7.00');
  });

  test('parcel is a flat GHS 3', () => {
    assert.equal(toCedis(serviceFee(fromCedis('500'), 'parcel')), '3.00');
  });
});

describe('commission (PDF §6)', () => {
  test('food 15%, groceries 12%, shop 10%', () => {
    assert.equal(toCedis(commission(fromCedis('100'), 'food')), '15.00');
    assert.equal(toCedis(commission(fromCedis('100'), 'groceries')), '12.00');
    assert.equal(toCedis(commission(fromCedis('100'), 'shop')), '10.00');
  });

  test('no vendor commission on parcel or errand', () => {
    assert.equal(commission(fromCedis('100'), 'parcel'), 0n);
    assert.equal(commission(fromCedis('100'), 'errand'), 0n);
  });
});

describe('the canonical order from MASTER_PLAN §3.4', () => {
  test('reproduces 70.00 items → 81.50 total, split 59.50 / 8.00 / 14.00', () => {
    // delivery fee of exactly 8.00 corresponds to the 3–7 km tier at 0 km
    // of distance component; use the documented figures directly.
    const q = quote({ service: 'food', itemTotal: fromCedis('70'), distanceMetres: 2_000 });
    // 0–3km tier: 5 + 2×1.5 = 8.00 ✔ matches the worked example
    assert.equal(toCedis(q.deliveryFee), '8.00');
    assert.equal(toCedis(q.serviceFee), '3.50');
    assert.equal(toCedis(q.total), '81.50');
    assert.equal(toCedis(q.vendorReceives), '59.50');
    assert.equal(toCedis(q.riderReceives), '8.00');
    assert.equal(toCedis(q.platformReceives), '14.00');
  });

  test('the split always reconstructs the total — the ledger depends on this', () => {
    for (let i = 0; i < 20_000; i++) {
      const itemTotal = pesewas(100 + ((i * 977) % 500_000));
      const distance = 200 + ((i * 613) % 25_000);
      const q = quote({
        service: (['food', 'groceries', 'shop', 'pharmacy', 'laundry'] as const)[i % 5]!,
        itemTotal,
        distanceMetres: distance,
        flags: { peak: i % 3 === 0, night: i % 7 === 0 },
      });
      assert.equal(
        add(q.vendorReceives, q.riderReceives, q.platformReceives),
        q.total,
        `split leaked at i=${i}`,
      );
    }
  });
});

describe('laundry — two legs', () => {
  test('both delivery fees are charged upfront (PDF §2)', () => {
    const one = quote({ service: 'laundry', itemTotal: fromCedis('40'), distanceMetres: 3_000 });
    const two = quote({ service: 'laundry', itemTotal: fromCedis('40'), distanceMetres: 3_000, legs: 2 });
    assert.equal(two.deliveryFee, one.deliveryFee * 2n);
    assert.equal(add(two.vendorReceives, two.riderReceives, two.platformReceives), two.total);
  });
});

describe('parcel pricing', () => {
  test('weight bands from PDF §6', () => {
    const q = parcelQuote(0.5, 3_000);
    // 10.00 weight + 9.50 distance = 19.50
    assert.equal(toCedis(q.total), '19.50');
  });

  test('rider keeps 80%, platform 20%', () => {
    const q = parcelQuote(3, 3_000);
    assert.equal(add(q.riderReceives, q.platformReceives), q.total);
    assert.equal(toCedis(q.riderReceives), '19.60'); // 80% of 24.50
  });

  test('rejects parcels over 20 kg', () => {
    assert.throws(() => parcelQuote(25, 1_000), PricingError);
  });
});

describe('errand pricing', () => {
  test('estimate + GHS 15 fee + delivery + 8% platform cut', () => {
    const q = errandQuote(fromCedis('100'), 3_000);
    assert.equal(toCedis(q.total), '132.50'); // 100 + 15 + 9.50 + 8
    assert.equal(toCedis(q.riderReceives), '24.50');
    assert.equal(toCedis(q.platformReceives), '8.00');
  });

  test('15% overspend tolerance ceiling', () => {
    const q = errandQuote(fromCedis('100'), 1_000);
    assert.equal(toCedis(q.autoApproveCeiling), '115.00');
  });
});

describe('COD eligibility (PDF §7)', () => {
  const base = {
    orderTotal: fromCedis('100'), service: 'food' as const,
    customerCompletedOrders: 10, riderUnremittedCod: 0n, hourOfDay: 14,
  };

  test('a normal daytime food order qualifies', () => {
    assert.equal(codEligible(base).eligible, true);
  });

  test('shop is never COD', () => {
    const d = codEligible({ ...base, service: 'shop' });
    assert.equal(d.eligible, false);
    assert.match(d.reason!, /prepaid/);
  });

  test('over GHS 200 is refused', () => {
    assert.equal(codEligible({ ...base, orderTotal: fromCedis('250') }).eligible, false);
  });

  test('new customers are capped at GHS 50', () => {
    const d = codEligible({ ...base, customerCompletedOrders: 1, orderTotal: fromCedis('80') });
    assert.equal(d.eligible, false);
    assert.match(d.reason!, /GHS 50/);
    assert.equal(
      codEligible({ ...base, customerCompletedOrders: 1, orderTotal: fromCedis('40') }).eligible,
      true,
    );
  });

  test('riders holding more than GHS 300 cash get no more COD', () => {
    assert.equal(codEligible({ ...base, riderUnremittedCod: fromCedis('350') }).eligible, false);
  });

  test('no COD after 9pm or before 6am', () => {
    assert.equal(codEligible({ ...base, hourOfDay: 22 }).eligible, false);
    assert.equal(codEligible({ ...base, hourOfDay: 3 }).eligible, false);
    assert.equal(codEligible({ ...base, hourOfDay: 9 }).eligible, true);
  });
});

describe('config is data, not code (PDF §6)', () => {
  test('admin can change rates without touching logic', () => {
    const cheaper = {
      ...DEFAULT_PRICING,
      deliveryTiers: [{ maxMetres: Infinity, basePesewas: 300, perKmPesewas: 100 }],
    };
    assert.equal(toCedis(deliveryFee(3_000, {}, cheaper)), '6.00');
    assert.equal(toCedis(deliveryFee(3_000)), '9.50', 'default must be untouched');
  });
});
