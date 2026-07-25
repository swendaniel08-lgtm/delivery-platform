/**
 * dispatch.spec — exit criterion for issue #7.
 *
 * The headline test: N riders accept the SAME leg simultaneously and exactly
 * one wins. Everything else is eligibility and escalation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DispatchService, InMemoryClaimStore, isEligible, rankRiders, nextAction,
  DISPATCH_ROUNDS, VEHICLE_CAPABILITY, RIDER_MAX_COD_PESEWAS,
  type RiderCandidate, type DispatchRequest,
} from '../src/dispatch.ts';
import { fromCedis } from '../../../libs/money/src/money.ts';
import { ConflictError } from '../../../libs/platform/src/errors.ts';

const VENDOR = { lat: 5.5560, lng: -0.1821 };   // Osu
const CUSTOMER = { lat: 5.5800, lng: -0.1750 }; // Cantonments

const req = (over: Partial<DispatchRequest> = {}): DispatchRequest => ({
  orderId: 'o1', legId: 'leg1', service: 'food',
  pickup: VENDOR, dropoff: CUSTOMER,
  earningsPesewas: fromCedis('8'), isCod: false,
  orderTotalPesewas: fromCedis('81.50'),
  ...over,
});

const rider = (id: string, over: Partial<RiderCandidate> = {}): RiderCandidate => ({
  riderId: id,
  position: { lat: 5.5565, lng: -0.1825 },  // ~70 m from the vendor
  vehicle: 'motorbike',
  isOnline: true,
  hasActiveLeg: false,
  codObligationPesewas: 0n,
  acceptanceRate: 0.9,
  cancellationsToday: 0,
  ...over,
});

/* ================================================================ */
/* THE RACE — issue #7                                              */
/* ================================================================ */

describe('first-to-accept race (closes issue #7)', () => {
  test('50 riders accept simultaneously — exactly ONE wins', async () => {
    const store = new InMemoryClaimStore();
    const svc = new DispatchService(store);
    const riders = Array.from({ length: 50 }, (_, i) => rider(`r${i}`));

    // everyone is offered the job
    await store.setNx('assignment:leg1:offer', JSON.stringify({
      legId: 'leg1', orderId: 'o1', round: 1,
      riderIds: riders.map((r) => r.riderId), expiresAtMs: Date.now() + 30_000,
    }), 30_000);

    const outcomes = await Promise.all(riders.map((r) => svc.accept('leg1', r.riderId)));

    const winners = outcomes.filter((o) => o.won);
    assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}`);

    // every loser is told who won, so the UI can say "taken by another rider"
    const losers = outcomes.filter((o) => !o.won);
    assert.equal(losers.length, 49);
    for (const l of losers) {
      assert.equal(l.reason, 'taken');
      assert.equal(l.winnerRiderId, winners[0]!.winnerRiderId);
    }
  });

  test('repeated races never produce two winners', async () => {
    for (let trial = 0; trial < 200; trial++) {
      const store = new InMemoryClaimStore();
      const svc = new DispatchService(store);
      const ids = ['a', 'b', 'c'];
      await store.setNx('assignment:legX:offer', JSON.stringify({
        legId: 'legX', orderId: 'o', round: 1, riderIds: ids, expiresAtMs: Date.now() + 30_000,
      }), 30_000);
      const res = await Promise.all(ids.map((id) => svc.accept('legX', id)));
      assert.equal(res.filter((r) => r.won).length, 1, `trial ${trial} produced multiple winners`);
    }
  });

  test('the same rider accepting twice wins once and is idempotent', async () => {
    const store = new InMemoryClaimStore();
    const svc = new DispatchService(store);
    await store.setNx('assignment:leg1:offer', JSON.stringify({
      legId: 'leg1', orderId: 'o1', round: 1, riderIds: ['r1'], expiresAtMs: Date.now() + 30_000,
    }), 30_000);

    const first = await svc.accept('leg1', 'r1');
    const second = await svc.accept('leg1', 'r1');
    assert.equal(first.won, true);
    assert.equal(second.won, false);
    assert.equal(second.winnerRiderId, 'r1', 'must still report r1 as the holder');
  });

  test('a rider who was not offered the job cannot claim it', async () => {
    const store = new InMemoryClaimStore();
    const svc = new DispatchService(store);
    await store.setNx('assignment:leg1:offer', JSON.stringify({
      legId: 'leg1', orderId: 'o1', round: 1, riderIds: ['r1'], expiresAtMs: Date.now() + 30_000,
    }), 30_000);
    const out = await svc.accept('leg1', 'gatecrasher');
    assert.equal(out.won, false);
    assert.equal(out.reason, 'not_offered');
    assert.equal(await svc.currentWinner('leg1'), null);
  });

  test('accepting after the offer expired fails cleanly', async () => {
    let now = 1_000_000;
    const store = new InMemoryClaimStore(() => now);
    const svc = new DispatchService(store, () => now);
    await svc.broadcast(req(), [rider('r1')], 1);
    now += 31_000;
    const out = await svc.accept('leg1', 'r1');
    assert.equal(out.won, false);
    assert.equal(out.reason, 'expired');
  });

  test('a cancelling rider releases the claim for re-dispatch', async () => {
    const store = new InMemoryClaimStore();
    const svc = new DispatchService(store);
    await store.setNx('assignment:leg1:offer', JSON.stringify({
      legId: 'leg1', orderId: 'o1', round: 1, riderIds: ['r1', 'r2'], expiresAtMs: Date.now() + 30_000,
    }), 30_000);

    assert.equal((await svc.accept('leg1', 'r1')).won, true);
    await svc.releaseClaim('leg1');
    assert.equal(await svc.currentWinner('leg1'), null);

    // re-broadcast and r2 can now win
    await svc.broadcast(req(), [rider('r2')], 1);
    assert.equal((await svc.accept('leg1', 'r2')).won, true);
  });

  test('an assigned leg is not re-broadcast', async () => {
    const store = new InMemoryClaimStore();
    const svc = new DispatchService(store);
    await store.setNx('assignment:leg1:offer', JSON.stringify({
      legId: 'leg1', orderId: 'o1', round: 1, riderIds: ['r1'], expiresAtMs: Date.now() + 30_000,
    }), 30_000);
    await svc.accept('leg1', 'r1');
    await assert.rejects(() => svc.broadcast(req(), [rider('r2')], 2), ConflictError);
  });
});

/* ================================================================ */
/* Eligibility                                                       */
/* ================================================================ */

describe('rider eligibility (PDF §4)', () => {
  test('offline riders receive nothing', () => {
    assert.equal(isEligible(rider('r', { isOnline: false }), req()).eligible, false);
  });

  test('riders already on a delivery receive nothing (no batching at launch)', () => {
    assert.equal(isEligible(rider('r', { hasActiveLeg: true }), req()).eligible, false);
  });

  test('3 cancellations in a day sidelines a rider (PDF §8)', () => {
    assert.equal(isEligible(rider('r', { cancellationsToday: 3 }), req()).eligible, false);
    assert.equal(isEligible(rider('r', { cancellationsToday: 2 }), req()).eligible, true);
  });

  test('vehicle capability is respected', () => {
    // a bicycle cannot take groceries
    assert.equal(isEligible(rider('r', { vehicle: 'bicycle' }), req({ service: 'groceries' })).eligible, false);
    // only a car may take laundry
    assert.equal(isEligible(rider('r', { vehicle: 'motorbike' }), req({ service: 'laundry' })).eligible, false);
    assert.equal(isEligible(rider('r', { vehicle: 'car' }), req({ service: 'laundry' })).eligible, true);
  });

  test('weight limits are enforced', () => {
    assert.equal(isEligible(rider('r', { vehicle: 'motorbike' }),
      req({ service: 'parcel', weightKg: 15 })).eligible, false);
    assert.equal(isEligible(rider('r', { vehicle: 'car' }),
      req({ service: 'parcel', weightKg: 15 })).eligible, true);
  });

  test('only cars carry fragile items', () => {
    assert.equal(isEligible(rider('r', { vehicle: 'motorbike' }),
      req({ service: 'parcel', fragile: true })).eligible, false);
    assert.equal(isEligible(rider('r', { vehicle: 'car' }),
      req({ service: 'parcel', fragile: true })).eligible, true);
  });

  test('COD gating uses the balance AFTER this order, not before', () => {
    // GHS 250 held, GHS 100 order → would reach 350, over the 300 limit
    const r = rider('r', { codObligationPesewas: fromCedis('250') });
    const cod = req({ isCod: true, orderTotalPesewas: fromCedis('100') });
    const d = isEligible(r, cod);
    assert.equal(d.eligible, false);
    assert.match(d.reason!, /exceed/);

    // a small cash order still fits
    assert.equal(isEligible(r, req({ isCod: true, orderTotalPesewas: fromCedis('40') })).eligible, true);
  });

  test('COD limits do not apply to prepaid orders', () => {
    const r = rider('r', { codObligationPesewas: fromCedis('299') });
    assert.equal(isEligible(r, req({ isCod: false })).eligible, true);
  });

  test('the documented GHS 300 ceiling is what we enforce', () => {
    assert.equal(RIDER_MAX_COD_PESEWAS, fromCedis('300'));
  });
});

/* ================================================================ */
/* Ranking and rounds                                                */
/* ================================================================ */

describe('ranking', () => {
  test('nearest rider ranks first', () => {
    const near = rider('near', { position: { lat: 5.5561, lng: -0.1822 } });
    const far = rider('far', { position: { lat: 5.5800, lng: -0.2100 } });
    const ranked = rankRiders([far, near], req(), 5_000);
    assert.equal(ranked[0]!.riderId, 'near');
  });

  test('acceptance rate breaks ties between equidistant riders', () => {
    const p = { lat: 5.5565, lng: -0.1825 };
    const reliable = rider('reliable', { position: p, acceptanceRate: 0.95 });
    const flaky = rider('flaky', { position: p, acceptanceRate: 0.2 });
    const ranked = rankRiders([flaky, reliable], req(), 5_000);
    assert.equal(ranked[0]!.riderId, 'reliable');
  });

  test('riders beyond the radius are excluded', () => {
    const far = rider('far', { position: { lat: 5.9, lng: -0.5 } });
    assert.equal(rankRiders([far], req(), 3_000).length, 0);
  });

  test('ineligible riders never appear in the ranking', () => {
    const busy = rider('busy', { hasActiveLeg: true });
    assert.equal(rankRiders([busy], req(), 5_000).length, 0);
  });
});

describe('broadcast rounds (PDF §4)', () => {
  test('rounds widen 3km → 5km → 8km', () => {
    assert.deepEqual(DISPATCH_ROUNDS.map((r) => r.radiusMetres), [3_000, 5_000, 8_000]);
    assert.ok(DISPATCH_ROUNDS.every((r) => r.riderCount === 3 && r.offerTtlSeconds === 30));
  });

  test('at most 3 riders are offered per round', async () => {
    const svc = new DispatchService(new InMemoryClaimStore());
    const riders = Array.from({ length: 10 }, (_, i) => rider(`r${i}`));
    const offer = await svc.broadcast(req(), riders, 1);
    assert.equal(offer.riderIds.length, 3);
  });

  test('round 2 reaches riders round 1 could not', async () => {
    const svc = new DispatchService(new InMemoryClaimStore());
    const distant = rider('distant', { position: { lat: 5.5900, lng: -0.1900 } }); // ~4km
    const r1 = await svc.broadcast(req(), [distant], 1);
    assert.equal(r1.riderIds.length, 0, 'out of the 3km radius');
    await svc.releaseClaim('leg1');
    const r2 = await svc.broadcast(req(), [distant], 2);
    assert.equal(r2.riderIds.length, 1, 'within the 5km radius');
  });
});

describe('escalation (PDF §4)', () => {
  test('rounds 1→2→3 then timed retries then give up', () => {
    assert.deepEqual(nextAction(30, 1), { action: 'broadcast', round: 2 });
    assert.deepEqual(nextAction(60, 2), { action: 'broadcast', round: 3 });

    const retry = nextAction(120, 3);
    assert.equal(retry.action, 'retry_later');
    assert.equal(retry.waitSeconds, 60);
    assert.match(retry.customerMessage!, /longer than usual/);

    const done = nextAction(500, 3);
    assert.equal(done.action, 'give_up');
    assert.match(done.customerMessage!, /full refund/);
  });
});

describe('geo index', () => {
  test('finds riders within a radius, nearest first', async () => {
    const store = new InMemoryClaimStore();
    const svc = new DispatchService(store);
    await svc.updatePosition('near', { lat: 5.5565, lng: -0.1825 });
    await svc.updatePosition('mid', { lat: 5.5700, lng: -0.1800 });
    await svc.updatePosition('far', { lat: 5.9000, lng: -0.5000 });

    const ids = await svc.nearbyRiderIds(VENDOR, 3_000);
    assert.deepEqual(ids, ['near', 'mid']);
  });
});
