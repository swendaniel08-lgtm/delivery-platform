/**
 * bff-contract.e2e.spec — the BFFs answer what the apps actually parse.
 *
 * This suite exists because of a real bug: `VendorBff.dashboard()` emitted
 * `totalDisplay` / `secondsToRespond`, while `VendorOrder.fromJson` in the
 * Flutter app reads `itemTotalPesewas` / `placedAt`. Both sides were fully
 * tested and both were green — against themselves. The queue would have been
 * empty on a real device and no unit test could have told us.
 *
 * So these tests assert the KEYS, against fake upstreams, over real HTTP.
 * The companion Dart test (`bff_contract_test.dart`) feeds the same fixtures
 * through the real `fromJson` constructors.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createService, type RunningService,
} from '../../../libs/platform/src/service/bootstrap.ts';
import { ServiceClient } from '../../../libs/platform/src/http/service-client.ts';
import { CustomerBffHttpModule } from '../../bff-customer/src/http.ts';
import { VendorBffHttpModule } from '../../bff-vendor/src/http.ts';
import { RiderBffHttpModule } from '../../bff-rider/src/http.ts';

/* ------------------------------------------------------------------ */
/* A stub upstream: one fetch impl serving canned service responses.   */
/* ------------------------------------------------------------------ */

const routes = new Map<string, unknown>();
const calls: string[] = [];
const failing = new Set<string>();

/** Register `GET /users/me` → payload. Prefix match on the path. */
function route(key: string, payload: unknown) { routes.set(key, payload); }

const stubFetch: typeof fetch = async (input: any, init: any = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const path = new URL(url).pathname + (new URL(url).search || '');
  const key = `${init.method ?? 'GET'} ${path}`;
  calls.push(key);

  for (const bad of failing) {
    if (path.startsWith(bad)) {
      return new Response(JSON.stringify({ title: 'Upstream down' }), { status: 503 });
    }
  }
  // Longest prefix wins, so a stub for `/orders/o1` is not shadowed by the
  // one for `/orders`.
  let best: { prefix: string; payload: unknown } | null = null;
  for (const [pattern, payload] of routes) {
    const [method, prefix] = pattern.split(' ');
    if ((init.method ?? 'GET') !== method) continue;
    if (!path.startsWith(prefix!)) continue;
    if (!best || prefix!.length > best.prefix.length) {
      best = { prefix: prefix!, payload };
    }
  }
  if (best) {
    return new Response(JSON.stringify(best.payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ title: `no stub for ${key}` }), { status: 404 });
};

const client = (name: string) =>
  new ServiceClient({ baseUrl: 'http://upstream.test', name, fetchImpl: stubFetch });

const token = (sub: string, role: string, vendorId?: string) =>
  `${sub}:${role}:${vendorId ?? ''}`;
const verifyToken = (t: string) => {
  const [sub, role, vendorId] = t.split(':');
  if (!sub || !role) throw new Error('bad token');
  return { sub, role, ...(vendorId ? { vendorId } : {}) };
};
const as = (sub: string, role: string, vendorId?: string) => ({
  authorization: `Bearer ${token(sub, role, vendorId)}`,
  'content-type': 'application/json',
});

let customerSvc: RunningService;
let vendorSvc: RunningService;
let riderSvc: RunningService;

before(async () => {
  customerSvc = await createService({
    name: 'bff-customer', port: 4540, host: '127.0.0.1',
    module: CustomerBffHttpModule.forRoot({
      verifyToken,
      featureFlags: { food: true, parcel: true },
      upstreams: {
        identity: client('identity'), catalogue: client('catalogue'),
        order: client('order'), pricing: client('pricing'), tracking: client('tracking'),
        payment: client('payment'),
      },
    }),
  });
  vendorSvc = await createService({
    name: 'bff-vendor', port: 4541, host: '127.0.0.1',
    module: VendorBffHttpModule.forRoot({
      verifyToken,
      upstreams: {
        order: client('order'), catalogue: client('catalogue'), payment: client('payment'),
      },
    }),
  });
  riderSvc = await createService({
    name: 'bff-rider', port: 4542, host: '127.0.0.1',
    module: RiderBffHttpModule.forRoot({
      verifyToken,
      upstreams: {
        order: client('order'), dispatch: client('dispatch'), payment: client('payment'),
        tracking: client('tracking'), identity: client('identity'),
        media: client('media'),
      },
    }),
  });
});
after(async () => {
  await customerSvc?.stop();
  await vendorSvc?.stop();
  await riderSvc?.stop();
});

function reset() {
  routes.clear();
  calls.length = 0;
  failing.clear();
}

const get = (base: string, path: string, h: Record<string, string>) =>
  fetch(`${base}${path}`, { headers: h });
const post = (base: string, path: string, body: unknown, h: Record<string, string>) =>
  fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h },
    body: JSON.stringify(body),
  });

/* ------------------------------------------------------------------ */
/* Customer                                                            */
/* ------------------------------------------------------------------ */

describe('customer BFF contract', () => {
  function stubHome() {
    reset();
    route('GET /users/me/addresses', {
      addresses: [{
        id: 'a1', label: 'Home', latitude: 5.5560, longitude: -0.1821,
        areaName: 'Osu', landmark: 'behind the MTN mast', isDefault: true,
      }],
    });
    route('GET /catalogue/stores', {
      stores: [{
        id: 's1', name: 'Auntie Muni Waakye', averageRating: 4.7,
        prepLabel: '20-40 min', isOpen: true, distanceMetres: 900,
        averagePrepMinutes: 25,
      }],
    });
    route('GET /orders', {
      orders: [{
        id: 'o1', humanRef: 'BSC-4821', state: 'preparing', service: 'food',
        totalPesewas: '8150', storeName: 'Auntie Muni Waakye',
      }],
    });
  }

  test('home emits exactly the keys HomeData.fromJson reads', async () => {
    stubHome();
    const r = await get(customerSvc.url, '/api/customer/home', as('c1', 'customer'));
    const b = await r.json() as any;

    assert.equal(r.status, 200);
    for (const key of ['deliveringTo', 'services', 'activeOrder',
      'popularNearYou', 'topRated', 'newOnBesonc']) {
      assert.ok(key in b, `home is missing "${key}"`);
    }

    // Address → the app builds an Address from these four.
    assert.equal(b.deliveringTo.label, 'Home');
    assert.equal(b.deliveringTo.landmark, 'behind the MTN mast');
    assert.equal(typeof b.deliveringTo.lat, 'number');

    // StoreCard.fromJson reads: id, name, rating, prepEstimate,
    // deliveryFee, isOpen.
    const card = b.popularNearYou[0];
    for (const key of ['id', 'name', 'rating', 'prepEstimate', 'deliveryFee', 'isOpen']) {
      assert.ok(key in card, `store card is missing "${key}"`);
    }
    assert.equal(typeof card.rating, 'number');
    assert.equal(typeof card.prepEstimate, 'string');

    // ActiveOrder.fromJson reads: id, humanRef, state, service, totalPesewas.
    for (const key of ['id', 'humanRef', 'state', 'service', 'totalPesewas']) {
      assert.ok(key in b.activeOrder, `activeOrder is missing "${key}"`);
    }
    assert.equal(typeof b.activeOrder.totalPesewas, 'string',
      'money crosses the wire as a string — JSON has no bigint');
  });

  test('the active order survives a catalogue outage', async () => {
    stubHome();
    failing.add('/catalogue');

    const b = await (await get(customerSvc.url, '/api/customer/home',
      as('c1', 'customer'))).json() as any;

    assert.equal(b.activeOrder.humanRef, 'BSC-4821',
      'the banner is usually why the customer opened the app');
    assert.deepEqual(b.popularNearYou, []);
    assert.ok(b.degraded.includes('stores'), 'the app is told results are partial');
  });

  test('a new user with no address still gets a usable screen', async () => {
    reset();
    route('GET /users/me/addresses', { addresses: [] });
    route('GET /orders', { orders: [] });

    const b = await (await get(customerSvc.url, '/api/customer/home',
      as('c-new', 'customer'))).json() as any;

    assert.equal(b.deliveringTo, null);
    assert.equal(b.activeOrder, null);
    assert.ok(b.services.length > 0, 'the service tiles always render');
  });

  test('launch scope: food and parcel on, the rest behind flags', async () => {
    stubHome();
    const b = await (await get(customerSvc.url, '/api/customer/home',
      as('c1', 'customer'))).json() as any;
    const enabled = b.services.filter((s: any) => s.enabled).map((s: any) => s.key);
    assert.deepEqual(enabled.sort(), ['food', 'parcel']);
  });

  test('the store page emits what MenuItem.fromJson reads', async () => {
    reset();
    route('GET /catalogue/stores/s1', {
      store: { id: 's1', name: 'Auntie Muni', averageRating: 4.7, isOpen: true },
      items: [{
        id: 'i1', name: 'Jollof Rice', basePricePesewas: '3500', isAvailable: true,
        addonGroups: [{
          id: 'g1', name: 'Protein', isRequired: true, minSelections: 1, maxSelections: 2,
          items: [{ id: 'a1', name: 'Chicken', pricePesewas: '1500', isAvailable: true }],
        }],
        variantGroups: [],
      }],
    });

    const b = await (await get(customerSvc.url, '/api/customer/stores/s1',
      as('c1', 'customer'))).json() as any;

    const item = b.categories[0].items[0];
    for (const key of ['id', 'name', 'basePricePesewas', 'available', 'addonGroups']) {
      assert.ok(key in item, `menu item is missing "${key}"`);
    }
    assert.equal(item.available, true,
      'the Dart model reads "available", NOT "isAvailable"');
    // AddonGroup.fromJson reads `options`, not `items`.
    assert.ok('options' in item.addonGroups[0],
      'addon group must expose "options" for the Dart model');
    assert.equal(item.addonGroups[0].options[0].available, true);
  });

  test('an anonymous request is refused', async () => {
    reset();
    assert.equal((await fetch(`${customerSvc.url}/api/customer/home`)).status, 401);
  });
});


/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

describe('customer checkout', () => {
  function stubCheckout(over: { codEligible?: boolean; codReason?: string } = {}) {
    reset();
    route('GET /users/me/addresses', {
      addresses: [{
        id: 'a1', label: 'Home', latitude: 5.5560, longitude: -0.1821,
        landmark: 'behind the MTN mast', isDefault: true,
      }],
    });
    route('GET /catalogue/stores/s1', {
      store: {
        id: 's1', name: 'Auntie Muni Waakye', serviceType: 'food',
        latitude: 5.6037, longitude: -0.1870, isOpen: true,
      },
      items: [{ id: 'i1', name: 'Jollof Rice', basePricePesewas: '3500', isAvailable: true }],
    });
    // The catalogue prices the line; the client's number is never trusted.
    route('POST /catalogue/items/i1/price', {
      unitPricePesewas: '3500', quantity: 2, linePesewas: '7000',
    });
    route('POST /pricing/quote', {
      itemTotalPesewas: '7000', deliveryFeePesewas: '800',
      serviceFeePesewas: '350', totalPesewas: '8150',
      split: { vendorPesewas: '5950', riderPesewas: '800', platformPesewas: '1400' },
    });
    route('POST /pricing/cod/eligible', {
      eligible: over.codEligible ?? false,
      ...(over.codReason ? { reason: over.codReason } : {}),
    });
    route('POST /orders', {
      id: 'o-new', humanRef: '#515204', state: 'pending_payment',
      totalPesewas: '8150',
    });
  }

  const cart = {
    storeId: 's1',
    lines: [{ itemId: 'i1', quantity: 2, addonOptionIds: [] }],
  };

  test('the quote returns the canonical GHS 81.50 breakdown', async () => {
    stubCheckout();
    const r = await post(customerSvc.url, '/api/customer/checkout/quote',
      cart, as('c1', 'customer'));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.itemTotalPesewas, '7000');
    assert.equal(b.deliveryFeePesewas, '800');
    assert.equal(b.serviceFeePesewas, '350');
    assert.equal(b.totalPesewas, '8150');
    // Matches CheckoutQuote.fromJson in the Flutter app.
    for (const k of ['itemTotalPesewas', 'deliveryFeePesewas',
      'serviceFeePesewas', 'totalPesewas', 'codEligible']) {
      assert.ok(k in b, `quote is missing "${k}"`);
    }
  });

  test('THE SERVER REPRICES — a client-supplied price is ignored', async () => {
    stubCheckout();
    const r = await post(customerSvc.url, '/api/customer/checkout/quote', {
      ...cart,
      // A modified app claiming the jollof costs one pesewa.
      lines: [{ itemId: 'i1', quantity: 2, pricePesewas: '1', linePesewas: '1' }],
    }, as('c1', 'customer'));
    const b = await r.json() as any;

    assert.equal(b.itemTotalPesewas, '7000',
      'prices come from the catalogue, never from the request body');
    assert.equal(b.totalPesewas, '8150');
  });

  test('an item removed from the menu is refused, not silently dropped', async () => {
    stubCheckout();
    const r = await post(customerSvc.url, '/api/customer/checkout/quote', {
      storeId: 's1', lines: [{ itemId: 'deleted-item', quantity: 1 }],
    }, as('c1', 'customer'));
    const b = await r.json() as any;

    assert.equal(r.status, 422);
    assert.match(JSON.stringify(b.errors), /no longer on the menu/);
  });

  test('COD ineligibility carries the reason to the app', async () => {
    stubCheckout({ codEligible: false, codReason: 'Order exceeds the GHS 200 cash limit' });
    const b = await (await post(customerSvc.url, '/api/customer/checkout/quote',
      cart, as('c1', 'customer'))).json() as any;

    assert.equal(b.codEligible, false);
    assert.equal(b.codReason, 'Order exceeds the GHS 200 cash limit',
      'the disabled option must say WHY, not just be grey');
  });

  test('a customer with no address cannot be quoted', async () => {
    stubCheckout();
    route('GET /users/me/addresses', { addresses: [] });
    const r = await post(customerSvc.url, '/api/customer/checkout/quote',
      cart, as('c1', 'customer'));
    assert.equal(r.status, 422);
  });

  test('placing an order requires an idempotency key', async () => {
    stubCheckout();
    const r = await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'prepaid' }, as('c1', 'customer'));
    const b = await r.json() as any;

    assert.equal(r.status, 422);
    assert.match(JSON.stringify(b.errors), /retry cannot double-order/);
  });

  test('a prepaid order is created and flagged as needing approval', async () => {
    stubCheckout();
    const r = await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'prepaid' },
      { ...as('c1', 'customer'), 'idempotency-key': 'checkout-abc-123' });
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.orderId, 'o-new');
    assert.equal(b.totalPesewas, '8150');
    assert.equal(b.requiresApproval, true,
      'mobile money needs the customer to approve a prompt — the app must wait');
    assert.ok(calls.includes('POST /orders'));
  });

  test('CASH IS REFUSED when the server says it is ineligible', async () => {
    stubCheckout({ codEligible: false, codReason: 'Cash on delivery is unavailable after 9pm' });
    const r = await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'cod' },
      { ...as('c1', 'customer'), 'idempotency-key': 'checkout-cod-1' });
    const b = await r.json() as any;

    assert.equal(r.status, 422);
    assert.match(JSON.stringify(b.errors), /after 9pm/);
    assert.ok(!calls.includes('POST /orders'),
      'no order may be created for a payment method the server rejected');
  });

  test('cash goes through when eligible', async () => {
    stubCheckout({ codEligible: true });
    const r = await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'cod' },
      { ...as('c1', 'customer'), 'idempotency-key': 'checkout-cod-2' });

    assert.equal(r.status, 201);
    const b = await r.json() as any;
    assert.equal(b.requiresApproval, false, 'cash needs no Paystack prompt');
  });

  test('A MOMO CHARGE IS INITIATED after the order exists', async () => {
    stubCheckout();
    route('POST /payments/internal/charges/momo', {
      reference: 'order:o-new:1', status: 'pending',
      displayText: 'Approve the payment on your phone',
      awaitingApproval: true,
    });

    const r = await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'prepaid', momoPhone: '0244123456' },
      { ...as('c1', 'customer'), 'idempotency-key': 'checkout-momo-1' });
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.charge.status, 'pending');
    assert.equal(b.requiresApproval, true,
      'a 201 means "Paystack accepted the request", NOT "the customer paid"');

    // Order first, charge second. A charge with no order to attach it to is
    // a refund waiting to happen.
    const orderAt = calls.indexOf('POST /orders');
    const chargeAt = calls.indexOf('POST /payments/internal/charges/momo');
    assert.ok(orderAt >= 0 && chargeAt > orderAt,
      'the order must exist before money is asked for');
  });

  test('a failed charge does NOT lose the order', async () => {
    stubCheckout();
    failing.add('/payments/internal/charges');

    const r = await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'prepaid', momoPhone: '0244123456' },
      { ...as('c1', 'customer'), 'idempotency-key': 'checkout-momo-fail' });
    const b = await r.json() as any;

    assert.equal(r.status, 201, 'the order stands; the app offers a retry');
    assert.equal(b.orderId, 'o-new');
    assert.equal(b.charge.failed, true);
  });

  test('cash orders never touch Paystack', async () => {
    stubCheckout({ codEligible: true });
    await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'cod' },
      { ...as('c1', 'customer'), 'idempotency-key': 'checkout-cash-1' });

    assert.ok(!calls.some((c) => c.includes('charges/momo')),
      'asking a cash customer to approve a prompt would be nonsense');
  });

  test('the idempotency key is forwarded to order-svc', async () => {
    stubCheckout();
    await post(customerSvc.url, '/api/customer/checkout',
      { ...cart, paymentIntent: 'prepaid' },
      { ...as('c1', 'customer'), 'idempotency-key': 'key-forwarded' });

    // The stub records method+path; the header reaching the upstream is
    // asserted by the ServiceClient unit test. Here we assert the call
    // happened exactly once for one key.
    assert.equal(calls.filter((c) => c === 'POST /orders').length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Vendor                                                              */
/* ------------------------------------------------------------------ */

describe('vendor BFF contract', () => {
  const placedAt = new Date(Date.now() - 30_000).toISOString();

  function stubQueue() {
    reset();
    route('GET /catalogue/stores/store-1', {
      store: { id: 'store-1', name: 'Auntie Muni Waakye', averageRating: 4.7, isOpen: true },
    });
    route('GET /orders', {
      orders: [{
        id: 'o1', humanRef: 'BSC-4821', state: 'placed', storeId: 'store-1',
        lines: [{ name: 'Jollof Rice', quantity: 2, addonNames: ['Chicken'] }],
        itemTotalPesewas: '7000', vendorAmountPesewas: '5950',
        placedAt, isCod: false, requiresPrescription: false,
      }],
    });
  }

  test('the queue emits exactly the keys VendorOrder.fromJson reads', async () => {
    stubQueue();
    const r = await get(vendorSvc.url, '/api/vendor/queue',
      as('v1', 'vendor_owner', 'store-1'));
    const b = await r.json() as any;

    assert.equal(r.status, 200);
    assert.equal(b.storeName, 'Auntie Muni Waakye');
    assert.equal(typeof b.isOpen, 'boolean');

    const o = b.orders[0];
    // THE REGRESSION: these are the keys the Dart model actually reads.
    for (const key of ['id', 'humanRef', 'state', 'lines', 'itemTotalPesewas',
      'vendorAmountPesewas', 'placedAt', 'isCod', 'requiresPrescription']) {
      assert.ok(key in o, `vendor order is missing "${key}" — the app cannot parse it`);
    }
    assert.equal(typeof o.itemTotalPesewas, 'string');
    assert.equal(typeof o.placedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(o.placedAt)), 'placedAt must be ISO-8601');

    // The line shape VendorOrderLine.fromJson reads.
    assert.deepEqual(o.lines[0].addonNames, ['Chicken']);
    assert.equal(o.lines[0].quantity, 2);
  });

  test('placedAt is the SERVER time — no preformatted countdown', async () => {
    stubQueue();
    const b = await (await get(vendorSvc.url, '/api/vendor/queue',
      as('v1', 'vendor_owner', 'store-1'))).json() as any;

    assert.ok(!('secondsToRespond' in b.orders[0]),
      'a countdown computed server-side freezes between 10s polls; '
      + 'the app derives it from placedAt so it ticks smoothly');
    assert.equal(b.orders[0].placedAt, placedAt);
  });

  test('each action maps to the right order event', async () => {
    stubQueue();
    route('GET /orders/o1', { id: 'o1', storeId: 'store-1' });
    route('POST /orders/o1/events', { to: 'vendor_accepted' });

    const r = await post(vendorSvc.url, '/api/vendor/orders/o1/accept', {},
      as('v1', 'vendor_owner', 'store-1'));
    assert.equal(r.status, 201);
    assert.ok(calls.includes('POST /orders/o1/events'));
  });

  test('an invented action is refused', async () => {
    stubQueue();
    route('GET /orders/o1', { id: 'o1', storeId: 'store-1' });
    const r = await post(vendorSvc.url, '/api/vendor/orders/o1/cancel_everything', {},
      as('v1', 'vendor_owner', 'store-1'));
    assert.equal(r.status, 422, 'the vendor vocabulary is fixed');
  });

  test('rejecting without a reason is refused', async () => {
    stubQueue();
    route('GET /orders/o1', { id: 'o1', storeId: 'store-1' });
    const r = await post(vendorSvc.url, '/api/vendor/orders/o1/reject', {},
      as('v1', 'vendor_owner', 'store-1'));
    assert.equal(r.status, 422);
  });

  test("a vendor cannot act on another store's order", async () => {
    stubQueue();
    route('GET /orders/o1', { id: 'o1', storeId: 'SOMEONE-ELSE' });

    const r = await post(vendorSvc.url, '/api/vendor/orders/o1/accept', {},
      as('v1', 'vendor_owner', 'store-1'));
    assert.equal(r.status, 404,
      'a kitchen ticket leaks a competitor\'s volume and their customers');
  });

  test('a vendor account with no store fails clearly', async () => {
    reset();
    const r = await get(vendorSvc.url, '/api/vendor/queue', as('v-nostore', 'vendor_owner'));
    assert.equal(r.status, 403, 'better than an empty queue that looks like "no orders"');
  });

  test('a customer token is refused', async () => {
    reset();
    assert.equal(
      (await get(vendorSvc.url, '/api/vendor/queue', as('c1', 'customer'))).status, 403,
    );
  });

  test('the menu INCLUDES items the vendor switched off', async () => {
    stubQueue();
    route('GET /catalogue/manage/stores/store-1/items', {
      items: [
        { id: 'i1', name: 'Jollof Rice', basePricePesewas: '3500',
          isAvailable: true, requiresPrescription: false },
        { id: 'i2', name: 'Grilled Tilapia', basePricePesewas: '6000',
          isAvailable: false, requiresPrescription: false },
      ],
    });

    const b = await (await get(vendorSvc.url, '/api/vendor/menu',
      as('v1', 'vendor_owner', 'store-1'))).json() as any;

    assert.equal(b.items.length, 2);
    assert.equal(b.items[1].isAvailable, false,
      'hiding sold-out items would leave the vendor unable to switch them '
      + 'back on when the fish arrives');
  });

  test('switching an item off is one call', async () => {
    stubQueue();
    route('PATCH /catalogue/manage/items/i1/availability', {
      id: 'i1', name: 'Jollof Rice', isAvailable: false,
    });

    const r = await fetch(`${vendorSvc.url}/api/vendor/menu/i1/availability`, {
      method: 'PATCH',
      headers: as('v1', 'vendor_owner', 'store-1'),
      body: JSON.stringify({ isAvailable: false }),
    });
    const b = await r.json() as any;

    assert.equal(r.status, 200);
    assert.equal(b.isAvailable, false);
  });

  test('availability must be a boolean, not a truthy string', async () => {
    stubQueue();
    const r = await fetch(`${vendorSvc.url}/api/vendor/menu/i1/availability`, {
      method: 'PATCH',
      headers: as('v1', 'vendor_owner', 'store-1'),
      body: JSON.stringify({ isAvailable: 'no' }),
    });
    assert.equal(r.status, 422,
      '"no" is truthy in JavaScript — it would switch the item ON');
  });

  test('a new dish needs a name and a price', async () => {
    stubQueue();
    const r = await post(vendorSvc.url, '/api/vendor/menu',
      { name: 'Waakye' }, as('v1', 'vendor_owner', 'store-1'));
    assert.equal(r.status, 422);
  });

  test('the queue still renders when the catalogue is down', async () => {
    stubQueue();
    failing.add('/catalogue');
    const b = await (await get(vendorSvc.url, '/api/vendor/queue',
      as('v1', 'vendor_owner', 'store-1'))).json() as any;

    assert.equal(b.orders.length, 1, 'orders matter more than the store name');
    assert.equal(b.storeName, 'Your store');
  });
});

/* ------------------------------------------------------------------ */
/* Rider                                                               */
/* ------------------------------------------------------------------ */

describe('rider BFF contract', () => {
  function stubRider(over: { leg?: unknown; offer?: unknown } = {}) {
    reset();
    route('GET /users/me', {
      id: 'r1', phone: '+233244000002', role: 'rider',
      firstName: 'Kofi', status: 'active',
    });
    route('GET /payments/wallet', {
      balancePesewas: '12400', codObligationPesewas: '5000',
      withdrawablePesewas: '7400',
    });
    route('GET /payments/earnings/today', { earnedPesewas: '4800', deliveries: 6 });
    route('GET /legs/active', { leg: over.leg ?? null });
    route('GET /dispatch/riders/r1/offer', { offer: over.offer ?? null });
  }

  const leg = {
    legId: 'leg-1', orderId: 'o-1', humanRef: 'BSC-4821', state: 'arrived',
    service: 'food',
    pickup: { lat: 5.6037, lng: -0.1870, label: 'Auntie Muni Waakye' },
    dropoff: {
      lat: 5.5560, lng: -0.1821, label: 'Osu',
      landmark: 'behind the MTN mast', instructions: 'blue gate',
    },
    feePesewas: '800', isCod: true, codAmountPesewas: '8150', customerName: 'Ama',
  };

  test('state emits exactly the keys RiderCoordinator.refresh reads', async () => {
    stubRider();
    const r = await get(riderSvc.url, '/api/rider/state', as('r1', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 200);
    for (const key of ['riderName', 'approved', 'walletBalancePesewas',
      'todayEarningsPesewas', 'todayDeliveries', 'codObligationPesewas',
      'activeLeg', 'offer']) {
      assert.ok(key in b, `rider state is missing "${key}"`);
    }
    assert.equal(b.riderName, 'Kofi');
    assert.equal(b.approved, true);
    assert.equal(b.codObligationPesewas, '5000');
    assert.equal(typeof b.todayDeliveries, 'number');
  });

  test('the active leg matches ActiveLeg.fromJson', async () => {
    stubRider({ leg });
    const b = await (await get(riderSvc.url, '/api/rider/state',
      as('r1', 'rider'))).json() as any;

    const l = b.activeLeg;
    for (const key of ['legId', 'orderId', 'humanRef', 'state', 'service',
      'pickup', 'dropoff', 'feePesewas', 'isCod']) {
      assert.ok(key in l, `active leg is missing "${key}"`);
    }
    assert.equal(typeof l.pickup.lat, 'number');
    assert.equal(l.dropoff.landmark, 'behind the MTN mast',
      'the landmark is the field riders actually navigate by');
    assert.equal(l.codAmountPesewas, '8150');
  });

  test('AN OFFER NEVER CARRIES THE EXACT DROPOFF', async () => {
    stubRider({
      offer: {
        legId: 'leg-9', orderId: 'o-9', service: 'food',
        pickupLabel: 'Chez Clarisse', dropoffArea: 'Cantonments',
        earningsPesewas: '900', distanceMetres: 2400,
        expiresAt: new Date(Date.now() + 25_000).toISOString(), isCod: false,
        // Even if dispatch leaks these, the BFF must not pass them on.
        dropoff: { lat: 5.5560, lng: -0.1821, label: '12 Blue Gate St' },
      },
    });

    const b = await (await get(riderSvc.url, '/api/rider/state',
      as('r1', 'rider'))).json() as any;

    assert.equal(b.offer.dropoffArea, 'Cantonments');
    assert.ok(!('dropoff' in b.offer),
      'a rider could farm customer addresses from offers without ever delivering');
    assert.ok(!JSON.stringify(b.offer).includes('Blue Gate'));
    assert.ok(!Number.isNaN(Date.parse(b.offer.expiresAt)));
  });

  test('an identity outage does NOT mark a rider approved', async () => {
    stubRider();
    failing.add('/users/me');

    const b = await (await get(riderSvc.url, '/api/rider/state',
      as('r1', 'rider'))).json() as any;

    assert.equal(b.approved, false,
      'failing open would let a suspended rider take jobs during an outage');
  });

  test('a rider mid-delivery keeps their job card when payment is down', async () => {
    stubRider({ leg });
    failing.add('/payments');

    const b = await (await get(riderSvc.url, '/api/rider/state',
      as('r1', 'rider'))).json() as any;

    assert.equal(b.activeLeg.legId, 'leg-1');
    assert.equal(b.walletBalancePesewas, '0');
  });

  test('going online is blocked over the GHS 300 cash ceiling', async () => {
    stubRider();
    route('GET /payments/wallet', {
      balancePesewas: '12400', codObligationPesewas: '35000',
    });

    const r = await post(riderSvc.url, '/api/rider/online', {}, as('r1', 'rider'));
    const b = await r.json() as any;
    assert.equal(r.status, 403);
    assert.match(b.detail ?? b.title, /GHS 300/,
      'a real reason beats silently receiving no offers all morning');
  });

  test('losing the accept race is a 200 with won:false', async () => {
    stubRider();
    route('POST /dispatch/legs/leg-1/accept', {
      won: false, reason: 'taken', message: 'Another rider took this one.',
    });

    const r = await post(riderSvc.url, '/api/rider/legs/leg-1/accept', {},
      as('r1', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.won, false);
    assert.equal(b.reason, 'taken');
  });

  test('an invented rider event is refused', async () => {
    stubRider();
    const r = await post(riderSvc.url, '/api/rider/legs/leg-1/events',
      { event: 'mark_paid' }, as('r1', 'rider'));
    assert.equal(r.status, 422);
  });

  test('completing a delivery without a photo is refused', async () => {
    stubRider();
    const r = await post(riderSvc.url, '/api/rider/legs/leg-1/events',
      { event: 'rider_deliver' }, as('r1', 'rider'));
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.ok(b.errors.photoUrl);
  });

  test('a delivery WITH a photo goes through', async () => {
    stubRider();
    route('POST /legs/leg-1/events', { to: 'delivered' });
    const r = await post(riderSvc.url, '/api/rider/legs/leg-1/events',
      { event: 'rider_deliver', photoUrl: 'https://media/pod.jpg' }, as('r1', 'rider'));
    assert.equal(r.status, 201);
  });

  test('PROOF UPLOAD: the rider gets a presigned URL for the delivery photo',
    async () => {
      stubRider();
      route('POST /media/uploads', {
        objectKey: 'proof_of_delivery/o-1/abc.jpg',
        uploadUrl: 'https://storage.test/put/abc.jpg?sig=x',
        publicUrl: null,
        requiredHeaders: { 'content-type': 'image/jpeg' },
        expiresInSeconds: 300,
        maxBytes: 3_000_000,
      });

      const r = await post(riderSvc.url, '/api/rider/proof-uploads',
        { orderId: 'o-1', contentType: 'image/jpeg', sizeBytes: 900_000 },
        as('r1', 'rider'));
      const b = await r.json() as any;

      assert.equal(r.status, 201);
      assert.ok(b.uploadUrl, 'without this a rider can never finish a delivery');
      assert.match(b.objectKey, /^proof_of_delivery\//);
      assert.ok(b.expiresInSeconds >= 60,
        'a 3MB photo on 3G needs more than a moment');
    });

  test('a proof upload without an order is refused', async () => {
    stubRider();
    const r = await post(riderSvc.url, '/api/rider/proof-uploads',
      { contentType: 'image/jpeg', sizeBytes: 100 }, as('r1', 'rider'));
    assert.equal(r.status, 422);
  });

  test('a vendor token cannot drive rider endpoints', async () => {
    stubRider();
    assert.equal(
      (await get(riderSvc.url, '/api/rider/state', as('v1', 'vendor_owner'))).status, 403,
    );
  });
});

/* ------------------------------------------------------------------ */

describe('upstream resilience', () => {
  test('a slow upstream times out rather than hanging the phone', async () => {
    const slow = new ServiceClient({
      baseUrl: 'http://upstream.test', name: 'slow', defaultTimeoutMs: 50,
      fetchImpl: (async (_i: any, init: any) => {
        await new Promise((r) => setTimeout(r, 500));
        if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    await assert.rejects(
      () => slow.get('/anything'),
      (e: any) => /timed out after 50ms/.test(e.message),
    );
  });

  test('an upstream 4xx keeps its own message', async () => {
    const c = new ServiceClient({
      baseUrl: 'http://upstream.test', name: 'catalogue',
      fetchImpl: (async () => new Response(
        JSON.stringify({ title: 'Not Found', detail: 'Store not found' }), { status: 404 },
      )) as typeof fetch,
    });
    await assert.rejects(() => c.get('/x'), /Store not found/);
  });
});
