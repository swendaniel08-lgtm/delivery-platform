/** vendor + rider BFF specs — tenant isolation, urgency, single next action. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VendorBff, primaryActionFor,
  type OrderClient, type StoreClient, type EarningsClient, type VendorOrder,
} from '../src/bff.ts';
import {
  RiderBff, nextActionFor, headingFor, formatDuration,
  type LegClient, type RiderProfileClient, type RiderEarningsClient, type RiderLeg,
} from '../../bff-rider/src/bff.ts';
import { fromCedis } from '../../../libs/money/src/money.ts';
import { ForbiddenError, NotFoundError, ConflictError } from '../../../libs/platform/src/errors.ts';

/* ================================================================== */
/* Vendor                                                              */
/* ================================================================== */

const OWNER = 'owner-1';
const STORE = 'store-1';
const NOW = new Date('2026-07-25T12:00:00Z');

const vOrder = (over: Partial<VendorOrder> = {}): VendorOrder => ({
  id: 'o1', humanRef: '#1234', storeId: STORE, state: 'placed', service: 'food',
  lines: [{ name: 'Jollof Rice', quantity: 1, addonNames: ['Chicken'], variantNames: [] }],
  itemTotalPesewas: '7000', vendorAmountPesewas: '5950',
  placedAt: '2026-07-25T11:59:00Z', isCod: false, requiresPrescription: false, ...over,
});

function vHarness(over: { orders?: VendorOrder[]; ownerId?: string } = {}) {
  const orders: OrderClient = {
    async forStore() { return over.orders ?? [vOrder()]; },
    async get(id) { return (over.orders ?? [vOrder()]).find((o) => o.id === id) ?? null; },
  };
  let override: boolean | null = null;
  const stores: StoreClient = {
    async get(id) {
      if (id !== STORE) return null;
      return { id: STORE, ownerId: over.ownerId ?? OWNER, name: "Auntie Adwoa's",
               isOpen: true, isOpenOverride: override, rating: 4.6 };
    },
    async setOpenOverride(_id, open) { override = open; },
  };
  const earnings: EarningsClient = {
    async todayForStore() {
      return { orderCount: 12, grossPesewas: fromCedis('580'), netPesewas: fromCedis('493') };
    },
    async walletBalance() {
      return { availablePesewas: fromCedis('1200'), pendingPesewas: 0n };
    },
  };
  return { bff: new VendorBff(orders, stores, earnings, () => NOW), getOverride: () => override };
}

describe('vendor tenant isolation', () => {
  test('a vendor cannot open another store\'s dashboard', async () => {
    const { bff } = vHarness({ ownerId: 'someone-else' });
    await assert.rejects(() => bff.dashboard(OWNER, STORE), ForbiddenError);
  });

  test('an unknown store is a 404', async () => {
    const { bff } = vHarness();
    await assert.rejects(() => bff.dashboard(OWNER, 'store-999'), NotFoundError);
  });

  test('an order belonging to another store is refused even with a valid id', async () => {
    const { bff } = vHarness({ orders: [vOrder({ id: 'o9', storeId: 'other-store' })] });
    await assert.rejects(() => bff.orderDetail(OWNER, STORE, 'o9'), ForbiddenError);
  });
});

describe('vendor dashboard (PDF §11)', () => {
  test('one call returns today, new orders and work in progress', async () => {
    const { bff } = vHarness({
      orders: [
        vOrder({ id: 'n1', state: 'placed' }),
        vOrder({ id: 'p1', state: 'preparing' }),
        vOrder({ id: 'd1', state: 'delivered' }),
      ],
    });
    const d = await bff.dashboard(OWNER, STORE);
    assert.equal(d.storeName, "Auntie Adwoa's");
    assert.equal(d.today.revenueDisplay, 'GHS 493.00');
    assert.equal(d.newOrders.length, 1);
    assert.equal(d.inProgress.length, 1);
    assert.equal(d.completedToday, 1);
  });

  test('the accept countdown is shown and marked urgent under a minute', async () => {
    const { bff } = vHarness({
      orders: [
        vOrder({ id: 'fresh', placedAt: '2026-07-25T11:59:30Z' }), // 30s elapsed → 150 left
        vOrder({ id: 'urgent', placedAt: '2026-07-25T11:57:30Z' }), // 150s elapsed → 30 left
      ],
    });
    const d = await bff.dashboard(OWNER, STORE);
    // most urgent first
    assert.equal(d.newOrders[0]!.id, 'urgent');
    assert.equal(d.newOrders[0]!.secondsToRespond, 30);
    assert.equal(d.newOrders[0]!.urgent, true);
    assert.equal(d.newOrders[1]!.urgent, false);
  });

  test('the countdown never goes negative', async () => {
    const { bff } = vHarness({ orders: [vOrder({ placedAt: '2026-07-25T11:00:00Z' })] });
    const d = await bff.dashboard(OWNER, STORE);
    assert.equal(d.newOrders[0]!.secondsToRespond, 0);
  });

  test('vendors see what they EARN, not just the order total', async () => {
    const { bff } = vHarness();
    const d = await bff.dashboard(OWNER, STORE);
    assert.equal(d.newOrders[0]!.totalDisplay, 'GHS 70.00');
    assert.equal(d.newOrders[0]!.earnsDisplay, 'GHS 59.50', 'after commission');
  });

  test('COD and prescription orders are flagged on the card', async () => {
    const { bff } = vHarness({ orders: [vOrder({ isCod: true, requiresPrescription: true })] });
    const d = await bff.dashboard(OWNER, STORE);
    assert.equal(d.newOrders[0]!.isCod, true);
    assert.equal(d.newOrders[0]!.requiresPrescription, true);
  });

  test('an earnings outage still renders the dashboard', async () => {
    const orders: OrderClient = { async forStore() { return [vOrder()]; }, async get() { return null; } };
    const stores: StoreClient = {
      async get() { return { id: STORE, ownerId: OWNER, name: 'S', isOpen: true, isOpenOverride: null, rating: 4 }; },
      async setOpenOverride() {},
    };
    const broken: EarningsClient = {
      async todayForStore() { throw new Error('down'); },
      async walletBalance() { throw new Error('down'); },
    };
    const d = await new VendorBff(orders, stores, broken, () => NOW).dashboard(OWNER, STORE);
    assert.equal(d.today.revenueDisplay, 'GHS 0.00');
    assert.equal(d.newOrders.length, 1, 'orders must still show');
  });
});

describe('vendor single next action', () => {
  test('each state maps to exactly one button', () => {
    assert.equal(primaryActionFor('placed'), 'accept');
    assert.equal(primaryActionFor('vendor_accepted'), 'mark_preparing');
    assert.equal(primaryActionFor('preparing'), 'mark_ready');
    assert.equal(primaryActionFor('ready_for_pickup'), 'awaiting_rider');
    assert.equal(primaryActionFor('delivered'), 'none');
  });
});

describe('vendor open/closed switch', () => {
  test('the manual override is stored and can be cleared', async () => {
    const { bff, getOverride } = vHarness();
    await bff.setOpen(OWNER, STORE, false);
    assert.equal(getOverride(), false);
    await bff.setOpen(OWNER, STORE, null);
    assert.equal(getOverride(), null, 'null returns to the schedule');
  });

  test('a stranger cannot close someone else\'s shop', async () => {
    const { bff } = vHarness({ ownerId: 'other' });
    await assert.rejects(() => bff.setOpen(OWNER, STORE, false), ForbiddenError);
  });
});

/* ================================================================== */
/* Rider                                                               */
/* ================================================================== */

const RIDER = 'rider-1';

const leg = (over: Partial<RiderLeg> = {}): RiderLeg => ({
  legId: 'leg-1', orderId: 'o1', humanRef: '#1234', sequence: 1,
  legType: 'vendor_to_customer', state: 'assigned', service: 'food',
  pickup: { lat: 5.556, lng: -0.182, label: "Auntie Adwoa's" },
  dropoff: { lat: 5.580, lng: -0.175, label: 'Osu', landmark: 'blue gate behind the MTN mast',
             instructions: 'Call when you arrive' },
  feePesewas: '800', isCod: false, assignedRiderId: RIDER, ...over,
});

function rHarness(over: {
  leg?: RiderLeg | null; approved?: boolean; online?: boolean;
  cod?: { obligationPesewas: bigint; oldestUnremittedAt: Date | null };
} = {}) {
  let online = over.online ?? false;
  const legs: LegClient = {
    async activeForRider() { return over.leg === undefined ? leg() : over.leg; },
    async get() { return over.leg === undefined ? leg() : over.leg; },
  };
  const profiles: RiderProfileClient = {
    async get(id) {
      return { id, name: 'Kwame Mensah', isOnline: online,
               vehicle: 'motorbike', approved: over.approved ?? true };
    },
    async setOnline(_id, v) { online = v; },
  };
  const earnings: RiderEarningsClient = {
    async today() { return { deliveries: 8, earnedPesewas: fromCedis('120'), onlineSeconds: 15_780 }; },
    async wallet() { return { availablePesewas: fromCedis('340') }; },
    async codState() {
      return { riderId: RIDER, obligationPesewas: over.cod?.obligationPesewas ?? 0n,
               oldestUnremittedAt: over.cod?.oldestUnremittedAt ?? null };
    },
  };
  return { bff: new RiderBff(legs, profiles, earnings), isOnline: () => online };
}

describe('rider home (PDF §12)', () => {
  test('one call returns earnings, COD and the current job', async () => {
    const { bff } = rHarness();
    const h = await bff.home(RIDER);
    assert.equal(h.name, 'Kwame Mensah');
    assert.equal(h.today.earnedDisplay, 'GHS 120.00');
    assert.equal(h.today.onlineDisplay, '4h 23m');
    assert.equal(h.currentLeg?.humanRef, '#1234');
  });

  test('the COD balance is always present', async () => {
    const { bff } = rHarness({ cod: { obligationPesewas: fromCedis('85'), oldestUnremittedAt: new Date() } });
    const h = await bff.home(RIDER);
    assert.equal(h.cod.balanceDisplay, 'GHS 85.00');
    assert.equal(h.cod.status, 'holding');
  });

  test('an overdue cash balance blocks going online', async () => {
    const old = new Date(Date.now() - 50 * 3_600_000);
    const { bff } = rHarness({ cod: { obligationPesewas: fromCedis('100'), oldestUnremittedAt: old } });
    const h = await bff.home(RIDER);
    assert.equal(h.canGoOnline, false);
    assert.match(h.blockedReason!, /Remit/);
    await assert.rejects(() => bff.goOnline(RIDER, true), ConflictError);
  });

  test('an unapproved rider cannot go online', async () => {
    const { bff } = rHarness({ approved: false });
    const h = await bff.home(RIDER);
    assert.equal(h.canGoOnline, false);
    assert.match(h.blockedReason!, /under review/);
    await assert.rejects(() => bff.goOnline(RIDER, true), ForbiddenError);
  });

  test('a clear rider can toggle online', async () => {
    const { bff, isOnline } = rHarness();
    await bff.goOnline(RIDER, true);
    assert.equal(isOnline(), true);
  });

  test('with no assignment the card is null, not an error', async () => {
    const { bff } = rHarness({ leg: null });
    const h = await bff.home(RIDER);
    assert.equal(h.currentLeg, null);
  });
});

describe('rider navigation target follows the leg state', () => {
  test('heading to the vendor before pickup, to the customer after', () => {
    assert.equal(headingFor('assigned'), 'pickup');
    assert.equal(headingFor('rider_at_pickup'), 'pickup');
    assert.equal(headingFor('picked_up'), 'dropoff');
    assert.equal(headingFor('arrived'), 'dropoff');
  });

  test('the landmark only appears when heading to the customer', async () => {
    const before = await rHarness({ leg: leg({ state: 'assigned' }) }).bff.home(RIDER);
    assert.equal(before.currentLeg?.landmark, undefined);
    assert.equal(before.currentLeg?.navigateTo.label, "Auntie Adwoa's");

    const after = await rHarness({ leg: leg({ state: 'picked_up' }) }).bff.home(RIDER);
    assert.match(after.currentLeg!.landmark!, /blue gate/);
    assert.equal(after.currentLeg?.navigateTo.label, 'Osu');
  });
});

describe('rider single next action', () => {
  test('the state machine drives exactly one button', () => {
    assert.equal(nextActionFor(leg({ state: 'assigned' })).event, 'rider_arrive_pickup');
    assert.equal(nextActionFor(leg({ state: 'rider_at_pickup' })).event, 'rider_pickup');
    assert.equal(nextActionFor(leg({ state: 'picked_up' })).event, 'rider_arrive');
    assert.equal(nextActionFor(leg({ state: 'arrived' })).event, 'rider_deliver');
  });

  test('completing a delivery always requires proof', () => {
    const a = nextActionFor(leg({ state: 'arrived' }));
    assert.equal(a.requiresProof, true);
  });

  test('a COD delivery demands cash confirmation and says the amount', async () => {
    const codLeg = leg({ state: 'arrived', isCod: true, codAmountPesewas: '8150' });
    const action = nextActionFor(codLeg);
    assert.equal(action.requiresCashCollection, true);
    assert.match(action.label, /Collect cash/);

    const h = await rHarness({ leg: codLeg }).bff.home(RIDER);
    assert.equal(h.currentLeg?.collectCashDisplay, 'GHS 81.50');
  });

  test('a prepaid delivery does not ask for cash', () => {
    const a = nextActionFor(leg({ state: 'arrived', isCod: false }));
    assert.equal(a.requiresCashCollection, undefined);
  });
});

describe('rider assignment ownership', () => {
  test('a rider cannot act on someone else\'s leg', async () => {
    const { bff } = rHarness({ leg: leg({ assignedRiderId: 'other-rider' }) });
    await assert.rejects(() => bff.assertAssigned(RIDER, 'leg-1'), ForbiddenError);
  });

  test('an unknown leg is a 404', async () => {
    const { bff } = rHarness({ leg: null });
    await assert.rejects(() => bff.assertAssigned(RIDER, 'nope'), NotFoundError);
  });
});

describe('duration formatting', () => {
  test('reads naturally for riders', () => {
    assert.equal(formatDuration(15_780), '4h 23m');
    assert.equal(formatDuration(1_800), '30m');
    assert.equal(formatDuration(0), '0m');
  });
});
