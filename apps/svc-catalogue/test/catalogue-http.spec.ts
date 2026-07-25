/**
 * catalogue-http.spec — discovery, menus and vendor management over HTTP.
 *
 * The authorisation tests are the important half: a menu endpoint that
 * trusts a path parameter is how one vendor marks a competitor's kitchen
 * as closed on a Friday night.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createService, type RunningService } from '../../../libs/platform/src/service/bootstrap.ts';
import { CatalogueHttpModule, type Claims } from '../src/http.ts';
import { InMemoryCatalogueRepository } from '../src/repository.ts';
import type { OperatingHours } from '../src/catalogue.ts';

let svc: RunningService;
let BASE = '';
let repo: InMemoryCatalogueRepository;

const ALWAYS_OPEN: OperatingHours = {
  mon: { open: '00:00', close: '23:59' }, tue: { open: '00:00', close: '23:59' },
  wed: { open: '00:00', close: '23:59' }, thu: { open: '00:00', close: '23:59' },
  fri: { open: '00:00', close: '23:59' }, sat: { open: '00:00', close: '23:59' },
  sun: { open: '00:00', close: '23:59' },
};

/** Fake token format: "<sub>:<role>:<vendorId>" — the real one is a JWT. */
const token = (sub: string, role: string, vendorId?: string) =>
  `${sub}:${role}:${vendorId ?? ''}`;
const verifyToken = (t: string): Claims => {
  const [sub, role, vendorId] = t.split(':');
  if (!sub || !role) throw new Error('bad token');
  return { sub, role, ...(vendorId ? { vendorId } : {}) };
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

let ownerStore = '';
let otherStore = '';
let jollofId = '';

before(async () => {
  repo = new InMemoryCatalogueRepository();
  svc = await createService({
    name: 'svc-catalogue', port: 4532, host: '127.0.0.1',
    module: CatalogueHttpModule.forRoot({ repo, verifyToken }),
  });
  BASE = svc.url;

  const a = await repo.createStore({
    ownerId: 'u-owner', serviceType: 'food', name: 'Auntie Muni Waakye',
    latitude: 5.6050, longitude: -0.1870, phone: '+233244000001',
    operatingHours: ALWAYS_OPEN,
  });
  await repo.setStoreStatus(a.id, 'approved');
  ownerStore = a.id;

  const b = await repo.createStore({
    ownerId: 'u-other', serviceType: 'pharmacy', name: 'Ridge Pharmacy',
    latitude: 5.5700, longitude: -0.2000, phone: '+233244000002',
    operatingHours: ALWAYS_OPEN, pharmacyLicenseNumber: 'PH-9931',
  });
  await repo.setStoreStatus(b.id, 'approved');
  otherStore = b.id;

  const item = await repo.createItem({
    storeId: ownerStore, name: 'Jollof Rice', description: 'Smoky party jollof',
    basePricePesewas: 3500n,
  });
  jollofId = item.id;
  repo.attachOptions(jollofId, [{
    id: 'g1', name: 'Protein', isRequired: true, minSelections: 1, maxSelections: 2,
    items: [
      { id: 'a1', name: 'Chicken', pricePesewas: 1500n, isAvailable: true },
      { id: 'a2', name: 'Goat', pricePesewas: 2500n, isAvailable: false },
    ],
  }]);
  await repo.createItem({
    storeId: otherStore, name: 'Paracetamol 500mg', basePricePesewas: 800n,
    requiresPrescription: false,
  });
});
after(async () => { await svc?.stop(); });

const get = (p: string, h: Record<string, string> = {}) => fetch(`${BASE}${p}`, { headers: h });
const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b),
  });
const patch = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b),
  });

/* ------------------------------------------------------------------ */

describe('discovery', () => {
  test('lists nearby approved stores with distance and prep label', async () => {
    const r = await get('/catalogue/stores?lat=5.6037&lng=-0.1870');
    const b = await r.json() as any;
    assert.equal(r.status, 200);
    assert.ok(b.stores.length >= 1);
    const first = b.stores[0];
    assert.ok(typeof first.distanceMetres === 'number');
    assert.match(first.prepLabel, /^\d+-\d+ min$/);
    assert.equal(typeof first.isOpen, 'boolean');
  });

  test('missing coordinates is 422, not an unfiltered dump', async () => {
    const r = await get('/catalogue/stores');
    assert.equal(r.status, 422);
  });

  test('an unknown service type is rejected', async () => {
    const r = await get('/catalogue/stores?lat=5.6&lng=-0.18&service=spaceship');
    assert.equal(r.status, 422);
  });

  test('the service filter narrows results', async () => {
    const b = await (await get('/catalogue/stores?lat=5.6&lng=-0.18&service=pharmacy'))
      .json() as any;
    assert.ok(b.stores.every((s: any) => s.serviceType === 'pharmacy'));
  });

  test('a store page returns details plus the full menu', async () => {
    const b = await (await get(`/catalogue/stores/${ownerStore}`)).json() as any;
    assert.equal(b.store.name, 'Auntie Muni Waakye');
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].basePricePesewas, '3500', 'money is a string, never a JSON number');
    assert.equal(b.items[0].addonGroups[0].name, 'Protein');
    assert.equal(b.items[0].addonGroups[0].items[1].isAvailable, false);
  });

  test('an unapproved store 404s on the public route', async () => {
    const s = await repo.createStore({
      ownerId: 'u-x', serviceType: 'food', name: 'Not Yet', latitude: 5.6, longitude: -0.18,
      phone: '+233244000009',
    });
    assert.equal((await get(`/catalogue/stores/${s.id}`)).status, 404);
  });

  test('an unknown store is 404 in RFC-7807 shape', async () => {
    const r = await get('/catalogue/stores/00000000-0000-4000-8000-999999999999');
    const b = await r.json() as any;
    assert.equal(r.status, 404);
    assert.equal(b.type, 'https://errors.besonc.app/not-found');
  });
});

describe('search', () => {
  test('finds an item by name', async () => {
    const b = await (await get('/catalogue/search?q=jollof')).json() as any;
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].storeName, 'Auntie Muni Waakye', 'the app shows which store sells it');
  });

  test('matches the description too', async () => {
    const b = await (await get('/catalogue/search?q=smoky')).json() as any;
    assert.equal(b.items.length, 1);
  });

  test('a one-character query is refused rather than scanning the catalogue', async () => {
    assert.equal((await get('/catalogue/search?q=j')).status, 422);
  });

  test('search can be scoped to one service', async () => {
    // "para" matches the pharmacy item only; scoping to food must return none.
    const pharmacy = await (await get('/catalogue/search?q=para&service=pharmacy')).json() as any;
    assert.equal(pharmacy.items.length, 1);
    assert.equal(pharmacy.items[0].name, 'Paracetamol 500mg');

    const food = await (await get('/catalogue/search?q=para&service=food')).json() as any;
    assert.equal(food.items.length, 0);
  });
});

describe('server-side pricing', () => {
  test('prices the canonical configured item', async () => {
    const b = await (await post(`/catalogue/items/${jollofId}/price`,
      { addonItemIds: ['a1'], quantity: 2 })).json() as any;
    assert.equal(b.unitPricePesewas, '5000');
    assert.equal(b.linePesewas, '10000');
  });

  test('a stale cart missing a required group is refused', async () => {
    const r = await post(`/catalogue/items/${jollofId}/price`, { addonItemIds: [] });
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.ok(b.errors.Protein);
  });

  test('a sold-out addon cannot be bought even at the right price', async () => {
    const r = await post(`/catalogue/items/${jollofId}/price`, { addonItemIds: ['a2'] });
    assert.equal(r.status, 422);
  });

  test('an absurd quantity is refused', async () => {
    const r = await post(`/catalogue/items/${jollofId}/price`,
      { addonItemIds: ['a1'], quantity: 5000 });
    assert.equal(r.status, 422);
  });
});

describe('vendor management', () => {
  const owner = bearer(token('u-owner', 'vendor_owner', ''));

  test('managing a menu requires a token', async () => {
    assert.equal((await get(`/catalogue/manage/stores/${ownerStore}/items`)).status, 401);
  });

  test('the owner sees their own menu including hidden items', async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await get(`/catalogue/manage/stores/${ownerStore}/items`, h);
    const b = await r.json() as any;
    assert.equal(r.status, 200);
    assert.equal(b.items.length, 1);
  });

  test("a vendor cannot read another vendor's menu", async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await get(`/catalogue/manage/stores/${otherStore}/items`, h);
    assert.equal(r.status, 404, 'not 403 — probing must not confirm the store exists');
  });

  test("a vendor cannot close a competitor's store", async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await patch(`/catalogue/manage/stores/${otherStore}/open`, { isOpen: false }, h);
    assert.equal(r.status, 404);

    const still = await (await get(`/catalogue/stores/${otherStore}`)).json() as any;
    assert.equal(still.store.isOpen, true, 'the competitor is still trading');
  });

  test('a customer token cannot manage anything', async () => {
    const h = bearer(token('u-cust', 'customer'));
    const r = await post('/catalogue/manage/stores',
      { serviceType: 'food', name: 'Fake', latitude: 5.6, longitude: -0.18, phone: '+233200000000' }, h);
    assert.equal(r.status, 403);
  });

  test('the open override closes the store immediately, and null restores the schedule', async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    await patch(`/catalogue/manage/stores/${ownerStore}/open`, { isOpen: false }, h);
    let page = await (await get(`/catalogue/stores/${ownerStore}`)).json() as any;
    assert.equal(page.store.isOpen, false, 'gas ran out');

    await patch(`/catalogue/manage/stores/${ownerStore}/open`, { isOpen: null }, h);
    page = await (await get(`/catalogue/stores/${ownerStore}`)).json() as any;
    assert.equal(page.store.isOpen, true, 'back on the schedule');
  });

  test('a new item is created and appears on the public menu', async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await post(`/catalogue/manage/stores/${ownerStore}/items`,
      { name: 'Waakye', basePricePesewas: '2000' }, h);
    const b = await r.json() as any;
    assert.equal(r.status, 201);
    assert.equal(b.basePricePesewas, '2000');
    assert.equal(b.isAvailable, true);

    const page = await (await get(`/catalogue/stores/${ownerStore}`)).json() as any;
    assert.ok(page.items.some((i: any) => i.name === 'Waakye'));
  });

  test('a non-integer price is refused', async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await post(`/catalogue/manage/stores/${ownerStore}/items`,
      { name: 'Bad', basePricePesewas: '35.50' }, h);
    assert.equal(r.status, 422, 'GHS 35.50 must be sent as 3550 pesewas');
  });

  test('a negative price is refused', async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await post(`/catalogue/manage/stores/${ownerStore}/items`,
      { name: 'Bad', basePricePesewas: '-100' }, h);
    assert.equal(r.status, 422);
  });

  test('toggling availability is reflected instantly', async () => {
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const off = await (await patch(`/catalogue/manage/items/${jollofId}/availability`,
      { isAvailable: false }, h)).json() as any;
    assert.equal(off.isAvailable, false);

    const r = await post(`/catalogue/items/${jollofId}/price`, { addonItemIds: ['a1'] });
    assert.equal(r.status, 422, 'an unavailable item cannot be priced into a cart');

    await patch(`/catalogue/manage/items/${jollofId}/availability`, { isAvailable: true }, h);
  });

  test("a vendor cannot toggle another store's item", async () => {
    const other = (await repo.listItems(otherStore))[0]!;
    const h = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await patch(`/catalogue/manage/items/${other.id}/availability`,
      { isAvailable: false }, h);
    assert.equal(r.status, 404);
  });
});

describe('store registration and approval', () => {
  test('a pharmacy cannot be registered without a licence number', async () => {
    const h = bearer(token('u-new', 'vendor_owner'));
    const r = await post('/catalogue/manage/stores', {
      serviceType: 'pharmacy', name: 'Corner Chemist',
      latitude: 5.6, longitude: -0.18, phone: '+233244111222',
    }, h);
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.ok(b.errors.pharmacyLicenseNumber);
  });

  test('a new store starts pending_review and is invisible to customers', async () => {
    const h = bearer(token('u-new2', 'vendor_owner'));
    const b = await (await post('/catalogue/manage/stores', {
      serviceType: 'food', name: 'Fresh Kitchen',
      latitude: 5.6040, longitude: -0.1875, phone: '+233244111333',
      operatingHours: ALWAYS_OPEN,
    }, h)).json() as any;
    assert.equal(b.status, 'pending_review');

    const list = await (await get('/catalogue/stores?lat=5.6037&lng=-0.1870')).json() as any;
    assert.ok(!list.stores.some((s: any) => s.id === b.id));
  });

  test('malformed opening hours are refused at registration', async () => {
    const h = bearer(token('u-new3', 'vendor_owner'));
    const r = await post('/catalogue/manage/stores', {
      serviceType: 'food', name: 'Broken Hours',
      latitude: 5.6, longitude: -0.18, phone: '+233244111444',
      operatingHours: { mon: { open: 'noon', close: '21:00' } },
    }, h);
    assert.equal(r.status, 422);
  });

  test('only an admin can approve a store', async () => {
    const vendor = bearer(token('u-owner', 'vendor_owner', ownerStore));
    const r = await patch(`/catalogue/manage/stores/${ownerStore}/status`,
      { status: 'approved' }, vendor);
    assert.equal(r.status, 403, 'self-approval would defeat the pharmacy licence check');

    const admin = bearer(token('u-admin', 'admin'));
    const ok = await patch(`/catalogue/manage/stores/${ownerStore}/status`,
      { status: 'approved' }, admin);
    assert.equal(ok.status, 200);
  });

  test('an admin suspending a store removes it from discovery', async () => {
    const admin = bearer(token('u-admin', 'admin'));
    await patch(`/catalogue/manage/stores/${otherStore}/status`, { status: 'suspended' }, admin);
    const list = await (await get('/catalogue/stores?lat=5.6037&lng=-0.1870')).json() as any;
    assert.ok(!list.stores.some((s: any) => s.id === otherStore));
    await patch(`/catalogue/manage/stores/${otherStore}/status`, { status: 'approved' }, admin);
  });

  test('an invalid status value is refused', async () => {
    const admin = bearer(token('u-admin', 'admin'));
    const r = await patch(`/catalogue/manage/stores/${ownerStore}/status`,
      { status: 'vibing' }, admin);
    assert.equal(r.status, 422);
  });
});
