/** bff.spec — screen composition, graceful degradation, call efficiency. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CustomerBff, SERVICE_TILES, prepRange,
  type CatalogueClient, type OrderClient, type AddressClient, type PricingClient,
  type StoreSummary, type ActiveOrderSummary,
} from '../src/bff.ts';
import { fromCedis } from '../../../libs/money/src/money.ts';
import { NotFoundError } from '../../../libs/platform/src/errors.ts';

const OSU = { lat: 5.5560, lng: -0.1821 };

const store = (id: string, over: Partial<StoreSummary> = {}): StoreSummary => ({
  id, name: `Store ${id}`, serviceType: 'food', imageUrl: null,
  rating: 4.2, totalOrders: 100, avgPrepMinutes: 25, isOpen: true,
  lat: OSU.lat, lng: OSU.lng, ...over,
});

function harness(over: {
  stores?: StoreSummary[];
  active?: ActiveOrderSummary[];
  address?: any;
  catalogueFails?: boolean;
  ordersFail?: boolean;
  pricingFails?: boolean;
} = {}) {
  const calls = { nearby: 0, active: 0, address: 0, quote: 0, search: 0 };

  const catalogue: CatalogueClient = {
    async nearbyStores() {
      calls.nearby++;
      if (over.catalogueFails) throw new Error('catalogue down');
      return over.stores ?? [store('a'), store('b')];
    },
    async search() { calls.search++; return over.stores ?? []; },
  };
  const orders: OrderClient = {
    async activeForCustomer() {
      calls.active++;
      if (over.ordersFail) throw new Error('order-svc down');
      return over.active ?? [];
    },
  };
  const addresses: AddressClient = {
    async defaultAddress() {
      calls.address++;
      return over.address === undefined
        ? { id: 'a1', label: 'Home', lat: OSU.lat, lng: OSU.lng,
            areaName: 'Osu', landmark: 'behind the MTN mast' }
        : over.address;
    },
  };
  const pricing: PricingClient = {
    async quoteDelivery() {
      calls.quote++;
      if (over.pricingFails) throw new Error('pricing down');
      return fromCedis('5');
    },
  };

  return { bff: new CustomerBff(catalogue, orders, addresses, pricing), calls };
}

describe('home screen composition (PDF §10)', () => {
  test('ONE call returns everything the screen needs', async () => {
    const { bff } = harness({
      active: [{
        id: 'o1', humanRef: '#1234', state: 'preparing', service: 'food',
        storeName: "Auntie Adwoa's", totalPesewas: '8150',
      }],
    });
    const home = await bff.home('cust-1');

    assert.equal(home.deliveringTo?.areaName, 'Osu');
    assert.equal(home.deliveringTo?.landmark, 'behind the MTN mast');
    assert.equal(home.services.length, 8);
    assert.equal(home.activeOrder?.humanRef, '#1234');
    assert.ok(home.popularNearYou.length > 0);
  });

  test('launch scope: Food and Parcel enabled, the rest behind flags', () => {
    const tiles = SERVICE_TILES({});
    const enabled = tiles.filter((t) => t.enabled).map((t) => t.key);
    assert.deepEqual(enabled.sort(), ['food', 'parcel']);
    assert.equal(tiles.length, 8, 'all 8 services are always visible');
  });

  test('flags can switch a service on without a deploy', () => {
    const tiles = SERVICE_TILES({ pharmacy: true });
    assert.equal(tiles.find((t) => t.key === 'pharmacy')!.enabled, true);
  });

  test('cards carry a delivery-fee estimate and an honest prep range', async () => {
    const { bff } = harness();
    const home = await bff.home('cust-1');
    const card = home.popularNearYou[0]!;
    assert.equal(card.deliveryFee, 'GHS 5.00');
    assert.equal(card.prepEstimate, '25-35 min');
  });
});

describe('graceful degradation', () => {
  test('a catalogue outage still shows the active order', async () => {
    const { bff } = harness({
      catalogueFails: true,
      active: [{ id: 'o1', humanRef: '#1234', state: 'in_transit', service: 'food',
                 storeName: 'X', totalPesewas: '8150' }],
    });
    const home = await bff.home('cust-1');
    assert.equal(home.activeOrder?.humanRef, '#1234',
      'the thing the customer opened the app for must survive');
    assert.deepEqual(home.popularNearYou, []);
  });

  test('an order-svc outage still shows vendors', async () => {
    const { bff } = harness({ ordersFail: true });
    const home = await bff.home('cust-1');
    assert.equal(home.activeOrder, null);
    assert.ok(home.popularNearYou.length > 0);
  });

  test('a pricing outage shows a dash rather than a wrong fee', async () => {
    const { bff } = harness({ pricingFails: true });
    const home = await bff.home('cust-1');
    assert.equal(home.popularNearYou[0]!.deliveryFee, '—',
      'never invent a price');
  });

  test('a new customer with no address still gets a usable screen', async () => {
    const { bff } = harness({ address: null });
    const home = await bff.home('cust-1');
    assert.equal(home.deliveringTo, null);
    assert.equal(home.services.length, 8, 'they can still pick a service');
  });
});

describe('call efficiency', () => {
  test('rendering the home screen makes ONE call per upstream', async () => {
    const { bff, calls } = harness();
    await bff.home('cust-1');
    assert.equal(calls.address, 1);
    assert.equal(calls.nearby, 1);
    assert.equal(calls.active, 1);
  });

  test('order and catalogue fetches run in PARALLEL, not sequentially', async () => {
    let concurrent = 0;
    let peak = 0;
    const track = async <T>(fn: () => Promise<T>): Promise<T> => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return fn();
    };
    const catalogue: CatalogueClient = {
      async nearbyStores() { return track(async () => [store('a')]); },
      async search() { return []; },
    };
    const orders: OrderClient = {
      async activeForCustomer() { return track(async () => []); },
    };
    const addresses: AddressClient = {
      async defaultAddress() {
        return { id: 'a', label: 'Home', lat: OSU.lat, lng: OSU.lng, areaName: null, landmark: null };
      },
    };
    const pricing: PricingClient = { async quoteDelivery() { return fromCedis('5'); } };

    await new CustomerBff(catalogue, orders, addresses, pricing).home('c1');
    assert.equal(peak, 2, 'both upstreams should be in flight together');
  });

  test('40 vendors do not cause 40 sequential pricing round trips', async () => {
    const many = Array.from({ length: 40 }, (_, i) => store(`s${i}`));
    let inFlight = 0, peak = 0;
    const pricing: PricingClient = {
      async quoteDelivery() {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return fromCedis('5');
      },
    };
    const catalogue: CatalogueClient = {
      async nearbyStores() { return many; }, async search() { return []; },
    };
    const orders: OrderClient = { async activeForCustomer() { return []; } };
    const addresses: AddressClient = {
      async defaultAddress() {
        return { id: 'a', label: 'Home', lat: OSU.lat, lng: OSU.lng, areaName: null, landmark: null };
      },
    };

    await new CustomerBff(catalogue, orders, addresses, pricing).home('c1');
    assert.ok(peak > 10, `quotes must be batched in parallel, peak concurrency was ${peak}`);
  });
});

describe('service listing and search', () => {
  test('closed vendors sort last (PDF §10)', async () => {
    const { bff } = harness({
      stores: [
        store('closed-great', { isOpen: false, rating: 5.0, opensAt: '08:00' }),
        store('open-ok', { isOpen: true, rating: 4.0 }),
      ],
    });
    const list = await bff.serviceListing('cust-1', 'food');
    assert.equal(list[0]!.id, 'open-ok', 'a closed 5-star vendor is useless right now');
    assert.equal(list[1]!.opensAt, '08:00', 'but tell the customer when it opens');
  });

  test('search needs at least 2 characters', async () => {
    const { bff, calls } = harness();
    assert.deepEqual(await bff.search('cust-1', 'a'), []);
    assert.equal(calls.search, 0, 'must not query upstream for one character');
  });

  test('listing without an address is a clear 404, not a crash', async () => {
    const { bff } = harness({ address: null });
    await assert.rejects(() => bff.serviceListing('cust-1', 'food'), NotFoundError);
  });
});

describe('prep ranges', () => {
  test('rounds to a readable 10-minute window', () => {
    assert.equal(prepRange(25), '25-35 min');
    assert.equal(prepRange(45), '45-55 min');
  });

  test('NEVER promises faster than the vendor\'s average', () => {
    // 12-minute average must not be advertised as "10-20" — we would be late
    // more often than early, and a late order costs more goodwill than an
    // early one earns.
    assert.equal(prepRange(12), '15-25 min');
    assert.equal(prepRange(21), '25-35 min');
  });

  test('never promises under 5 minutes', () => {
    assert.equal(prepRange(1), '5-15 min');
  });
});
