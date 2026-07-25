/** cart.spec — one-vendor rule, addon/variant rules, server-side pricing. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CartService, DifferentVendorError,
  type CatalogueReader, type CatalogueItem, type Store,
} from '../src/cart/cart.ts';
import { toCedis } from '../../../libs/money/src/money.ts';
import { ValidationError, ConflictError, NotFoundError } from '../../../libs/platform/src/errors.ts';

const adwoa: Store = { id: 's1', name: "Auntie Adwoa's Kitchen", serviceType: 'food', isOpen: true, status: 'approved' };
const kfc: Store   = { id: 's2', name: 'KFC Osu', serviceType: 'food', isOpen: true, status: 'approved' };
const pharm: Store = { id: 's3', name: 'Osu Pharmacy', serviceType: 'pharmacy', isOpen: true, status: 'approved' };

// Jollof GHS 35, protein required pick 1–3, extras optional 0–3
const jollof: CatalogueItem = {
  id: 'i1', storeId: 's1', name: 'Jollof Rice', basePricePesewas: 3500,
  available: true, requiresPrescription: false,
  addonGroups: [
    { id: 'g1', name: 'Protein', required: true, minSelections: 1, maxSelections: 3, options: [
      { id: 'a1', name: 'Chicken', pricePesewas: 1500, available: true },
      { id: 'a2', name: 'Fish', pricePesewas: 1200, available: true },
      { id: 'a3', name: 'Beef', pricePesewas: 1000, available: false },
    ]},
    { id: 'g2', name: 'Extras', required: false, minSelections: 0, maxSelections: 3, options: [
      { id: 'a4', name: 'Extra plantain', pricePesewas: 500, available: true },
      { id: 'a5', name: 'Shito', pricePesewas: 0, available: true },
    ]},
  ],
  variantGroups: [],
};

const sobolo: CatalogueItem = {
  id: 'i2', storeId: 's1', name: 'Sobolo', basePricePesewas: 1000,
  available: true, requiresPrescription: false, addonGroups: [], variantGroups: [],
};

const phoneCase: CatalogueItem = {
  id: 'i3', storeId: 's2', name: 'iPhone 15 Case', basePricePesewas: 8500,
  available: true, requiresPrescription: false, addonGroups: [],
  variantGroups: [
    { id: 'v1', name: 'Colour', options: [
      { id: 'o1', name: 'Black', priceDeltaPesewas: 0, available: true },
      { id: 'o2', name: 'Clear', priceDeltaPesewas: 500, available: true },
      { id: 'o3', name: 'Blue', priceDeltaPesewas: 0, available: false },
    ]},
  ],
};

const paracetamol: CatalogueItem = {
  id: 'i4', storeId: 's3', name: 'Paracetamol 500mg', basePricePesewas: 1200,
  available: true, requiresPrescription: true, addonGroups: [], variantGroups: [],
};

const soldOut: CatalogueItem = { ...sobolo, id: 'i5', name: 'Waakye', available: false };

function reader(stores = [adwoa, kfc, pharm], items = [jollof, sobolo, phoneCase, paracetamol, soldOut]): CatalogueReader {
  return {
    async getStore(id) { return stores.find((s) => s.id === id) ?? null; },
    async getItem(id) { return items.find((i) => i.id === id) ?? null; },
  };
}

const svc = () => new CartService(reader());

describe('server-side pricing', () => {
  test('base + required addon, ×1', async () => {
    const c = await svc().price('cust1', [{ itemId: 'i1', quantity: 1, addonOptionIds: ['a1'] }]);
    assert.equal(toCedis(c.itemTotalPesewas), '50.00'); // 35 + 15
    assert.deepEqual(c.lines[0]!.addonNames, ['Chicken']);
  });

  test('quantity multiplies base AND addons', async () => {
    const c = await svc().price('cust1', [{ itemId: 'i1', quantity: 3, addonOptionIds: ['a1'] }]);
    assert.equal(toCedis(c.itemTotalPesewas), '150.00'); // (35+15)×3
  });

  test('reproduces the PDF §20 walkthrough cart', async () => {
    // Jollof + Chicken ×1 = 50, Sobolo ×2 = 20 → item total 70
    const c = await svc().price('cust1', [
      { itemId: 'i1', quantity: 1, addonOptionIds: ['a1'] },
      { itemId: 'i2', quantity: 2 },
    ]);
    assert.equal(toCedis(c.itemTotalPesewas), '70.00');
  });

  test('multiple addons stack', async () => {
    const c = await svc().price('cust1', [
      { itemId: 'i1', quantity: 1, addonOptionIds: ['a1', 'a4', 'a5'] },
    ]);
    assert.equal(toCedis(c.itemTotalPesewas), '55.00'); // 35 + 15 + 5 + 0
  });

  test('variant price delta applies', async () => {
    const c = await svc().price('cust1', [
      { itemId: 'i3', quantity: 1, variantOptionIds: ['o2'] },
    ]);
    assert.equal(toCedis(c.itemTotalPesewas), '90.00'); // 85 + 5
  });
});

describe('one vendor per cart (PDF §13)', () => {
  test('two items from the same vendor are fine', async () => {
    const c = await svc().price('cust1', [
      { itemId: 'i1', quantity: 1, addonOptionIds: ['a1'] },
      { itemId: 'i2', quantity: 1 },
    ]);
    assert.equal(c.storeId, 's1');
    assert.equal(c.lines.length, 2);
  });

  test('mixing vendors is rejected with a helpful message', async () => {
    await assert.rejects(
      () => svc().price('cust1', [
        { itemId: 'i1', quantity: 1, addonOptionIds: ['a1'] },
        { itemId: 'i3', quantity: 1, variantOptionIds: ['o1'] },
      ]),
      (err: unknown) => {
        assert.ok(err instanceof DifferentVendorError);
        assert.match(err.message, /Auntie Adwoa/);
        assert.match(err.message, /KFC Osu/);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

describe('addon group rules', () => {
  test('required group must be satisfied', async () => {
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i1', quantity: 1 }]),
      ValidationError,
    );
  });

  test('cannot exceed maxSelections', async () => {
    const many = { ...jollof, addonGroups: [{ ...jollof.addonGroups[0]!, maxSelections: 1 }] };
    const s = new CartService(reader([adwoa], [many]));
    await assert.rejects(
      () => s.price('cust1', [{ itemId: 'i1', quantity: 1, addonOptionIds: ['a1', 'a2'] }]),
      ValidationError,
    );
  });

  test('unavailable addon is rejected', async () => {
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i1', quantity: 1, addonOptionIds: ['a3'] }]),
      ConflictError,
    );
  });

  test('addon from a DIFFERENT item is rejected — price tampering guard', async () => {
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i2', quantity: 1, addonOptionIds: ['a1'] }]),
      ValidationError,
    );
  });
});

describe('variant rules', () => {
  test('exactly one variant per group is required', async () => {
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i3', quantity: 1 }]),
      ValidationError,
    );
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i3', quantity: 1, variantOptionIds: ['o1', 'o2'] }]),
      ValidationError,
    );
  });

  test('unavailable variant is rejected', async () => {
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i3', quantity: 1, variantOptionIds: ['o3'] }]),
      ConflictError,
    );
  });
});

describe('availability and validation', () => {
  test('out-of-stock item cannot be added', async () => {
    await assert.rejects(
      () => svc().price('cust1', [{ itemId: 'i5', quantity: 1 }]),
      ConflictError,
    );
  });

  test('unknown item 404s', async () => {
    await assert.rejects(() => svc().price('cust1', [{ itemId: 'nope', quantity: 1 }]), NotFoundError);
  });

  test('quantity must be a sane positive integer', async () => {
    for (const q of [0, -1, 1.5, 100]) {
      await assert.rejects(
        () => svc().price('cust1', [{ itemId: 'i2', quantity: q }]),
        ValidationError,
        `quantity ${q} should be rejected`,
      );
    }
  });

  test('suspended vendor cannot receive orders', async () => {
    const s = new CartService(reader([{ ...adwoa, status: 'suspended' }], [sobolo]));
    await assert.rejects(() => s.price('cust1', [{ itemId: 'i2', quantity: 1 }]), ConflictError);
  });
});

describe('checkout gate', () => {
  test('closed vendor blocks checkout', async () => {
    const s = new CartService(reader([{ ...adwoa, isOpen: false }], [sobolo]));
    await assert.rejects(
      () => s.validateForCheckout('cust1', [{ itemId: 'i2', quantity: 1 }]),
      ConflictError,
    );
  });

  test('empty cart cannot check out', async () => {
    await assert.rejects(() => svc().validateForCheckout('cust1', []), ValidationError);
  });

  test('prescription item forces an upload (PDF §2)', async () => {
    await assert.rejects(
      () => svc().validateForCheckout('cust1', [{ itemId: 'i4', quantity: 1 }]),
      ValidationError,
    );
    const ok = await svc().validateForCheckout(
      'cust1', [{ itemId: 'i4', quantity: 1 }], { prescriptionUploaded: true },
    );
    assert.equal(ok.requiresPrescription, true);
  });

  test('re-prices at checkout so a price change is caught', async () => {
    const items = [{ ...sobolo }];
    const s = new CartService(reader([adwoa], items));
    const before = await s.price('cust1', [{ itemId: 'i2', quantity: 1 }]);
    assert.equal(toCedis(before.itemTotalPesewas), '10.00');
    items[0]!.basePricePesewas = 1500; // vendor raises the price
    const after = await s.validateForCheckout('cust1', [{ itemId: 'i2', quantity: 1 }]);
    assert.equal(toCedis(after.itemTotalPesewas), '15.00');
  });
});
