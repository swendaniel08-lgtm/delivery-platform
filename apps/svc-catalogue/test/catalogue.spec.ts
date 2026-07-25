/**
 * catalogue.spec — store hours, ranking, option pricing, discovery.
 *
 * The option-pricing tests matter most: every one of them is a way a stale
 * client cart could otherwise produce an order the kitchen cannot cook.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isOpenAt, validateHours, prepRange, rankScore, priceSelection, discover,
  accraParts, DEFAULT_DISCOVERY_RADIUS_METRES,
  type CatalogueItem, type StoreSummary, type OperatingHours,
} from '../src/catalogue.ts';
import { ValidationError } from '../../../libs/platform/src/errors.ts';

/** Ghana is UTC year-round, so a UTC literal IS Accra local time. */
const at = (iso: string) => new Date(iso);

const WEEKDAY: OperatingHours = {
  mon: { open: '08:00', close: '21:00' },
  tue: { open: '08:00', close: '21:00' },
  wed: { open: '08:00', close: '21:00' },
  thu: { open: '08:00', close: '21:00' },
  fri: { open: '08:00', close: '21:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: null,
};

describe('opening hours', () => {
  test('Accra day/minute extraction has no timezone drift', () => {
    // 2026-07-20 is a Monday.
    const p = accraParts(at('2026-07-20T14:30:00Z'));
    assert.equal(p.day, 'mon');
    assert.equal(p.minutes, 14 * 60 + 30);
  });

  test('open during the advertised window', () => {
    assert.equal(isOpenAt(WEEKDAY, null, at('2026-07-20T12:00:00Z')), true);
  });

  test('closed before opening and after closing', () => {
    assert.equal(isOpenAt(WEEKDAY, null, at('2026-07-20T07:59:00Z')), false);
    assert.equal(isOpenAt(WEEKDAY, null, at('2026-07-20T21:00:00Z')), false,
      'close is exclusive — 21:00 means last order 20:59');
  });

  test('a null day means closed all day', () => {
    assert.equal(isOpenAt(WEEKDAY, null, at('2026-07-19T12:00:00Z')), false, 'Sunday');
  });

  test('a manual override beats the schedule both ways', () => {
    assert.equal(isOpenAt(WEEKDAY, false, at('2026-07-20T12:00:00Z')), false,
      'vendor slammed the shutter — gas ran out');
    assert.equal(isOpenAt(WEEKDAY, true, at('2026-07-19T03:00:00Z')), true,
      'vendor opened specially');
  });

  test('an overnight chop bar is open after midnight', () => {
    // Friday 18:00 → Saturday 02:00.
    const bar: OperatingHours = { fri: { open: '18:00', close: '02:00' } };
    assert.equal(isOpenAt(bar, null, at('2026-07-24T20:00:00Z')), true, 'Friday evening');
    assert.equal(isOpenAt(bar, null, at('2026-07-25T01:00:00Z')), true, 'Saturday 1am, still Friday night');
    assert.equal(isOpenAt(bar, null, at('2026-07-25T03:00:00Z')), false, 'after last call');
    assert.equal(isOpenAt(bar, null, at('2026-07-24T17:00:00Z')), false, 'before opening');
  });

  test('malformed hours are rejected at write time, not read time', () => {
    assert.throws(() => validateHours({ mon: { open: '8am', close: '21:00' } } as any), ValidationError);
    assert.throws(() => validateHours({ mon: { open: '08:00', close: '25:70' } } as any), ValidationError);
    assert.throws(() => validateHours({ funday: { open: '08:00', close: '09:00' } } as any), ValidationError);
    assert.doesNotThrow(() => validateHours(WEEKDAY));
  });
});

describe('prep range', () => {
  test('never advertises faster than the vendor actually cooks', () => {
    // The bug this pins: 25 minutes must NOT display as "20-30 min".
    const r = prepRange(25);
    assert.equal(r.label, '20-40 min');
    assert.ok(r.max >= 25 + 10);
  });

  test('a fast vendor still gets a floor of 10 minutes', () => {
    assert.equal(prepRange(3).min, 10, 'no kitchen plates and a rider arrives in under 10 min');
  });

  test('exact multiples of ten stay tidy', () => {
    assert.equal(prepRange(20).label, '20-30 min');
    assert.equal(prepRange(40).label, '40-50 min');
  });
});

describe('ranking', () => {
  test('matches the SQL weighting: closer beats further, all else equal', () => {
    const near = rankScore({ distanceMetres: 500, rating: 4, orders30d: 100, prepMinutes: 20 });
    const far = rankScore({ distanceMetres: 7000, rating: 4, orders30d: 100, prepMinutes: 20 });
    assert.ok(near > far);
  });

  test('rating dominates a small distance difference', () => {
    const good = rankScore({ distanceMetres: 2000, rating: 4.8, orders30d: 100, prepMinutes: 20 });
    const bad = rankScore({ distanceMetres: 1800, rating: 2.0, orders30d: 100, prepMinutes: 20 });
    assert.ok(good > bad, 'we do not send people to bad food to save 200 metres');
  });

  test('volume saturates at 500 orders so incumbents cannot run away with it', () => {
    const a = rankScore({ distanceMetres: 1000, rating: 4, orders30d: 500, prepMinutes: 20 });
    const b = rankScore({ distanceMetres: 1000, rating: 4, orders30d: 50_000, prepMinutes: 20 });
    assert.equal(a, b);
  });

  test('the score stays inside 0..1', () => {
    const best = rankScore({ distanceMetres: 0, rating: 5, orders30d: 500, prepMinutes: 1 });
    const worst = rankScore({ distanceMetres: 100_000, rating: 0, orders30d: 0, prepMinutes: 600 });
    assert.ok(best <= 1 && best > 0.9);
    assert.ok(worst >= 0 && worst < 0.1);
  });
});

/* ------------------------------------------------------------------ */

function jollof(over: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id: 'i1', storeId: 's1', name: 'Jollof Rice',
    basePricePesewas: 3500n,
    isAvailable: true, requiresPrescription: false, substitutionAllowed: true,
    addonGroups: [{
      id: 'g1', name: 'Protein', isRequired: true, minSelections: 1, maxSelections: 2,
      items: [
        { id: 'a1', name: 'Chicken', pricePesewas: 1500n, isAvailable: true },
        { id: 'a2', name: 'Fish', pricePesewas: 2000n, isAvailable: true },
        { id: 'a3', name: 'Goat', pricePesewas: 2500n, isAvailable: false },
      ],
    }, {
      id: 'g2', name: 'Extras', isRequired: false, minSelections: 0, maxSelections: 3,
      items: [
        { id: 'a4', name: 'Shito', pricePesewas: 200n, isAvailable: true },
        { id: 'a5', name: 'Salad', pricePesewas: 500n, isAvailable: true },
      ],
    }],
    variantGroups: [],
    ...over,
  };
}

describe('option pricing', () => {
  test('base plus one required addon', () => {
    const p = priceSelection(jollof(), { addonItemIds: ['a1'], variantOptionIds: [] });
    assert.equal(p, 5000n, 'GHS 35.00 + 15.00');
  });

  test('optional extras stack', () => {
    const p = priceSelection(jollof(), { addonItemIds: ['a2', 'a4', 'a5'], variantOptionIds: [] });
    assert.equal(p, 3500n + 2000n + 200n + 500n);
  });

  test('skipping a required group is refused', () => {
    assert.throws(
      () => priceSelection(jollof(), { addonItemIds: [], variantOptionIds: [] }),
      (e: any) => e instanceof ValidationError && /at least 1/.test(e.extra.errors.Protein[0]),
    );
  });

  test('two proteins is the documented maximum, and is allowed', () => {
    const p = priceSelection(jollof(), { addonItemIds: ['a1', 'a2'], variantOptionIds: [] });
    assert.equal(p, 3500n + 1500n + 2000n);
  });

  test('exceeding max selections is refused', () => {
    // Protein allows at most 2; ask for three available ones.
    const item = jollof();
    item.addonGroups[0]!.items.push(
      { id: 'a6', name: 'Egg', pricePesewas: 400n, isAvailable: true },
    );
    assert.throws(
      () => priceSelection(item, { addonItemIds: ['a1', 'a2', 'a6'], variantOptionIds: [] }),
      (e: any) => e instanceof ValidationError && /at most 2/.test(e.extra.errors.Protein.join(' ')),
    );
  });

  test('a sold-out addon is refused even though the price is known', () => {
    assert.throws(
      () => priceSelection(jollof(), { addonItemIds: ['a3'], variantOptionIds: [] }),
      (e: any) => /sold out/.test(e.extra.errors.Protein.join(' ')),
    );
  });

  test('an unavailable item cannot be ordered at any price', () => {
    assert.throws(
      () => priceSelection(jollof({ isAvailable: false }), { addonItemIds: ['a1'], variantOptionIds: [] }),
      ValidationError,
    );
  });

  test('a stale cart referencing a deleted addon is refused, not silently dropped', () => {
    assert.throws(
      () => priceSelection(jollof(), { addonItemIds: ['a1', 'ghost'], variantOptionIds: [] }),
      (e: any) => e.extra.errors.addons !== undefined,
    );
  });

  test('variant groups are exactly-one', () => {
    const tee: CatalogueItem = jollof({
      addonGroups: [],
      basePricePesewas: 8000n,
      variantGroups: [{
        id: 'v1', name: 'Size',
        options: [
          { id: 'o1', name: 'M', priceDeltaPesewas: 0n, isAvailable: true },
          { id: 'o2', name: 'XL', priceDeltaPesewas: 1000n, isAvailable: true },
          { id: 'o3', name: 'XXL', priceDeltaPesewas: 1500n, isAvailable: false },
        ],
      }],
    });

    assert.equal(priceSelection(tee, { addonItemIds: [], variantOptionIds: ['o2'] }), 9000n);
    assert.throws(() => priceSelection(tee, { addonItemIds: [], variantOptionIds: [] }), ValidationError);
    assert.throws(
      () => priceSelection(tee, { addonItemIds: [], variantOptionIds: ['o1', 'o2'] }), ValidationError,
    );
    assert.throws(
      () => priceSelection(tee, { addonItemIds: [], variantOptionIds: ['o3'] }), ValidationError,
    );
  });
});

/* ------------------------------------------------------------------ */

const ACCRA = { lat: 5.6037, lng: -0.1870 };   // Accra Central

function store(over: Partial<StoreSummary>): StoreSummary {
  return {
    id: 's', serviceType: 'food', name: 'Store',
    latitude: 5.6037, longitude: -0.1870,
    averageRating: 4.5, totalOrders: 200, averagePrepMinutes: 20,
    operatingHours: WEEKDAY, isOpenOverride: null,
    status: 'approved', isActive: true,
    ...over,
  };
}

describe('discovery', () => {
  const monMidday = at('2026-07-20T12:00:00Z');

  test('unapproved and inactive stores never surface', () => {
    const rows = discover([
      store({ id: 'ok' }),
      store({ id: 'pending', status: 'pending_review' }),
      store({ id: 'suspended', status: 'suspended' }),
      store({ id: 'off', isActive: false }),
    ], ACCRA, { now: monMidday });
    assert.deepEqual(rows.map((r) => r.id), ['ok']);
  });

  test('open stores outrank closed ones regardless of score', () => {
    const rows = discover([
      store({ id: 'closed-excellent', averageRating: 5, totalOrders: 500, isOpenOverride: false }),
      store({ id: 'open-mediocre', averageRating: 3, totalOrders: 5, latitude: 5.61 }),
    ], ACCRA, { now: monMidday });
    assert.equal(rows[0]!.id, 'open-mediocre');
    assert.equal(rows[1]!.isOpen, false);
    assert.equal(rows.length, 2, 'the closed one is still listed, not hidden');
  });

  test('openOnly hides the closed ones for customers who want food now', () => {
    const rows = discover([
      store({ id: 'closed', isOpenOverride: false }),
      store({ id: 'open' }),
    ], ACCRA, { now: monMidday, openOnly: true });
    assert.deepEqual(rows.map((r) => r.id), ['open']);
  });

  test('the radius cut-off is enforced', () => {
    // ~0.5 degrees of latitude is ~55km — far outside any zone.
    const rows = discover([
      store({ id: 'near' }),
      store({ id: 'kumasi', latitude: 6.6885, longitude: -1.6244 }),
    ], ACCRA, { now: monMidday });
    assert.deepEqual(rows.map((r) => r.id), ['near']);
  });

  test('the service filter is honoured', () => {
    const rows = discover([
      store({ id: 'f', serviceType: 'food' }),
      store({ id: 'p', serviceType: 'pharmacy' }),
    ], ACCRA, { now: monMidday, service: 'pharmacy' });
    assert.deepEqual(rows.map((r) => r.id), ['p']);
  });

  test('a text query filters by name, case-insensitively', () => {
    const rows = discover([
      store({ id: 'a', name: 'Auntie Muni Waakye' }),
      store({ id: 'b', name: 'Pizza Inn' }),
    ], ACCRA, { now: monMidday, query: 'waakye' });
    assert.deepEqual(rows.map((r) => r.id), ['a']);
  });

  test('results carry the distance and prep label the app renders', () => {
    const rows = discover([store({ id: 'x', latitude: 5.6137, averagePrepMinutes: 25 })],
      ACCRA, { now: monMidday });
    assert.ok(rows[0]!.distanceMetres > 900 && rows[0]!.distanceMetres < 1300);
    assert.equal(rows[0]!.prepLabel, '20-40 min');
    assert.equal(Number.isInteger(rows[0]!.distanceMetres), true, 'no 1104.38271 metres in the UI');
  });

  test('the default radius is the 8km dispatch ceiling', () => {
    assert.equal(DEFAULT_DISCOVERY_RADIUS_METRES, 8_000);
  });

  test('limit caps the page', () => {
    const many = Array.from({ length: 80 }, (_, i) => store({ id: `s${i}` }));
    assert.equal(discover(many, ACCRA, { now: monMidday, limit: 20 }).length, 20);
  });
});
