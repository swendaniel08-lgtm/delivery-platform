/**
 * dispatch-http.spec — offers and the accept race over real HTTP.
 *
 * The concurrency test at the bottom is the important one: it fires many
 * simultaneous accepts through the full Fastify stack and asserts exactly
 * one winner. Double-assigning an order is the failure mode that costs real
 * money and cannot be undone once two riders reach the vendor.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createService, type RunningService } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  DispatchHttpModule, InMemoryRiderSource, type Claims,
} from '../src/http.ts';
import { InMemoryClaimStore, type RiderCandidate } from '../src/dispatch.ts';

let svc: RunningService;
let BASE = '';
let riderSource: InMemoryRiderSource;
let claimStore: InMemoryClaimStore;

const ACCRA = { lat: 5.6037, lng: -0.1870 };

/** Fake token: "<sub>:<role>". */
const token = (sub: string, role: string) => `${sub}:${role}`;
const verifyToken = (t: string): Claims => {
  const [sub, role] = t.split(':');
  if (!sub || !role) throw new Error('bad token');
  return { sub, role };
};
const asRider = (id: string) => ({
  authorization: `Bearer ${token(id, 'rider')}`, 'content-type': 'application/json',
});

function rider(over: Partial<RiderCandidate> = {}): RiderCandidate {
  return {
    riderId: 'r1',
    position: { lat: 5.6040, lng: -0.1872 },   // ~50m from pickup
    vehicle: 'motorbike',
    isOnline: true,
    hasActiveLeg: false,
    codObligationPesewas: 0n,
    acceptanceRate: 0.9,
    cancellationsToday: 0,
    ...over,
  };
}

/** The canonical GHS 81.50 food order from MASTER_PLAN §20. */
const legRequest = (over: Record<string, unknown> = {}) => ({
  orderId: 'o-1',
  legId: 'leg-1',
  service: 'food',
  pickup: ACCRA,
  dropoff: { lat: 5.5560, lng: -0.1821 },
  earningsPesewas: '800',
  isCod: false,
  orderTotalPesewas: '8150',
  ...over,
});

before(async () => {
  riderSource = new InMemoryRiderSource();
  claimStore = new InMemoryClaimStore();
  svc = await createService({
    name: 'svc-dispatch', port: 4533, host: '127.0.0.1',
    module: DispatchHttpModule.forRoot({
      riderSource, claims: claimStore, verifyToken,
    }),
  });
  BASE = svc.url;
});
after(async () => { await svc?.stop(); });

const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b),
  });
const get = (p: string, h: Record<string, string> = {}) => fetch(`${BASE}${p}`, { headers: h });

/* ------------------------------------------------------------------ */

describe('broadcast', () => {
  test('offers the job to the three nearest eligible riders', async () => {
    riderSource.riders = [
      rider({ riderId: 'near', position: { lat: 5.6038, lng: -0.1871 } }),
      rider({ riderId: 'mid', position: { lat: 5.6100, lng: -0.1900 } }),
      rider({ riderId: 'far', position: { lat: 5.6200, lng: -0.2000 } }),
      rider({ riderId: 'furthest', position: { lat: 5.6300, lng: -0.2100 } }),
    ];
    const r = await post('/dispatch/broadcast', legRequest({ legId: 'leg-b1' }));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.riderIds.length, 3, 'round 1 offers exactly 3 riders');
    assert.equal(b.riderIds[0], 'near', 'nearest first');
    assert.ok(!b.riderIds.includes('furthest'));
    assert.equal(b.radiusMetres, 3000, 'round 1 is a 3km radius');
    assert.ok(b.expiresAtMs > Date.now(), 'the offer has a deadline');
  });

  test('an offline rider is never offered a job', async () => {
    riderSource.riders = [
      rider({ riderId: 'sleeping', isOnline: false }),
      rider({ riderId: 'working' }),
    ];
    const b = await (await post('/dispatch/broadcast', legRequest({ legId: 'leg-b2' })))
      .json() as any;
    assert.deepEqual(b.riderIds, ['working']);
  });

  test('a rider already on a delivery is skipped', async () => {
    riderSource.riders = [
      rider({ riderId: 'busy', hasActiveLeg: true }),
      rider({ riderId: 'free' }),
    ];
    const b = await (await post('/dispatch/broadcast', legRequest({ legId: 'leg-b3' })))
      .json() as any;
    assert.deepEqual(b.riderIds, ['free']);
  });

  test('a bicycle is not offered a 15kg parcel', async () => {
    riderSource.riders = [rider({ riderId: 'bike', vehicle: 'bicycle' })];
    const b = await (await post('/dispatch/broadcast',
      legRequest({ legId: 'leg-b4', service: 'parcel', weightKg: 15 }))).json() as any;
    assert.deepEqual(b.riderIds, [], 'nobody eligible is a valid answer');
    assert.equal(b.candidatesConsidered, 1, 'the caller can tell riders existed but none fit');
  });

  test('a rider near the cash ceiling is not offered another COD order', async () => {
    riderSource.riders = [
      // Holding GHS 295; this GHS 81.50 order would breach GHS 300.
      rider({ riderId: 'loaded', codObligationPesewas: 29_500n }),
      rider({ riderId: 'empty', codObligationPesewas: 0n }),
    ];
    const b = await (await post('/dispatch/broadcast',
      legRequest({ legId: 'leg-b5', isCod: true }))).json() as any;
    assert.deepEqual(b.riderIds, ['empty']);
  });

  test('round 3 reaches 8km', async () => {
    riderSource.riders = [
      // ~6.5km away: outside round 1, inside round 3.
      rider({ riderId: 'distant', position: { lat: 5.6600, lng: -0.1870 } }),
    ];
    const r1 = await (await post('/dispatch/broadcast',
      legRequest({ legId: 'leg-b6', round: 1 }))).json() as any;
    assert.deepEqual(r1.riderIds, [], 'too far for round 1');

    const r3 = await (await post('/dispatch/broadcast',
      legRequest({ legId: 'leg-b7', round: 3 }))).json() as any;
    assert.deepEqual(r3.riderIds, ['distant']);
    assert.equal(r3.radiusMetres, 8000);
  });

  test('an unknown round is refused', async () => {
    const r = await post('/dispatch/broadcast', legRequest({ legId: 'leg-b8', round: 9 }));
    assert.equal(r.status, 422);
  });

  test('a malformed pickup is 422, not a crash', async () => {
    const r = await post('/dispatch/broadcast',
      { ...legRequest({ legId: 'leg-b9' }), pickup: 'Accra' });
    assert.equal(r.status, 422);
  });

  test('re-broadcasting an assigned leg is refused', async () => {
    riderSource.riders = [rider({ riderId: 'r-dup' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-dup' }));
    await post('/dispatch/legs/leg-dup/accept', {}, asRider('r-dup'));

    const r = await post('/dispatch/broadcast', legRequest({ legId: 'leg-dup' }));
    assert.equal(r.status, 409, 'a retried message must never double-assign an order');
  });
});

describe('accept', () => {
  test('an offered rider wins', async () => {
    riderSource.riders = [rider({ riderId: 'winner' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-a1' }));

    const r = await post('/dispatch/legs/leg-a1/accept', {}, asRider('winner'));
    const b = await r.json() as any;
    assert.equal(r.status, 201);
    assert.equal(b.won, true);
    assert.equal(b.reason, 'won');
  });

  test('a second rider gets a friendly "taken", not an error', async () => {
    riderSource.riders = [rider({ riderId: 'first' }), rider({ riderId: 'second' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-a2' }));
    await post('/dispatch/legs/leg-a2/accept', {}, asRider('first'));

    const r = await post('/dispatch/legs/leg-a2/accept', {}, asRider('second'));
    const b = await r.json() as any;
    assert.equal(r.status, 201, 'losing a race is a normal event, not a 409');
    assert.equal(b.won, false);
    assert.equal(b.reason, 'taken');
    assert.match(b.message, /Another rider took this one/);
  });

  test('a rider who was not offered the job cannot steal it', async () => {
    riderSource.riders = [rider({ riderId: 'offered' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-a3' }));

    const b = await (await post('/dispatch/legs/leg-a3/accept', {}, asRider('interloper')))
      .json() as any;
    assert.equal(b.won, false);
    assert.equal(b.reason, 'not_offered');
  });

  test('accepting a leg that was never broadcast reports expired', async () => {
    const b = await (await post('/dispatch/legs/leg-ghost/accept', {}, asRider('r1')))
      .json() as any;
    assert.equal(b.won, false);
    assert.equal(b.reason, 'expired');
  });

  test('accepting requires a rider token', async () => {
    assert.equal((await post('/dispatch/legs/leg-a1/accept', {})).status, 401);
    const asCustomer = { authorization: `Bearer ${token('c1', 'customer')}` };
    assert.equal(
      (await post('/dispatch/legs/leg-a1/accept', {}, asCustomer)).status, 403,
    );
  });

  test('THE RACE: 50 concurrent accepts produce exactly one winner', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `racer-${i}`);
    riderSource.riders = ids.map((id) => rider({ riderId: id }));

    // Round 3 so all 50 are inside the radius; still only 3 get the offer.
    const offer = await (await post('/dispatch/broadcast',
      legRequest({ legId: 'leg-race', round: 3 }))).json() as any;
    assert.equal(offer.riderIds.length, 3);

    // Every offered rider taps at the same instant on a flaky network.
    const results = await Promise.all(
      offer.riderIds.map((id: string) =>
        post('/dispatch/legs/leg-race/accept', {}, asRider(id)).then((r) => r.json())),
    );

    const winners = results.filter((r: any) => r.won);
    assert.equal(winners.length, 1, 'exactly one rider may be assigned');
    assert.equal(results.filter((r: any) => r.reason === 'taken').length, 2);

    const w = await (await get('/dispatch/legs/leg-race/winner')).json() as any;
    assert.ok(offer.riderIds.includes(w.riderId));
  });
});

describe('assignment lifecycle', () => {
  test('the winner is readable after the offer window closes', async () => {
    riderSource.riders = [rider({ riderId: 'r-win' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-w1' }));
    await post('/dispatch/legs/leg-w1/accept', {}, asRider('r-win'));

    const b = await (await get('/dispatch/legs/leg-w1/winner')).json() as any;
    assert.equal(b.riderId, 'r-win');
  });

  test('an unassigned leg has no winner', async () => {
    assert.equal((await get('/dispatch/legs/leg-nobody/winner')).status, 404);
  });

  test('a rider cannot release their own assignment', async () => {
    riderSource.riders = [rider({ riderId: 'r-rel' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-rel' }));
    await post('/dispatch/legs/leg-rel/accept', {}, asRider('r-rel'));

    const r = await post('/dispatch/legs/leg-rel/release', {}, asRider('r-rel'));
    assert.equal(r.status, 403,
      'a rider holding the food must not be able to silently drop the job');
  });

  test('the platform can release, and the leg becomes dispatchable again', async () => {
    riderSource.riders = [rider({ riderId: 'r-rel2' })];
    await post('/dispatch/broadcast', legRequest({ legId: 'leg-rel2' }));
    await post('/dispatch/legs/leg-rel2/accept', {}, asRider('r-rel2'));

    const admin = { authorization: `Bearer ${token('a1', 'admin')}` };
    assert.equal((await post('/dispatch/legs/leg-rel2/release', {}, admin)).status, 201);
    assert.equal((await get('/dispatch/legs/leg-rel2/winner')).status, 404);

    const again = await post('/dispatch/broadcast', legRequest({ legId: 'leg-rel2' }));
    assert.equal(again.status, 201, 're-dispatch is possible once released');
  });
});

describe('rider position', () => {
  test('a position update is accepted and feeds the GEO index', async () => {
    const r = await post('/dispatch/riders/position',
      { lat: 5.6037, lng: -0.1870 }, asRider('r-pos'));
    assert.equal(r.status, 201);
    assert.deepEqual(await (await r.json() as any), { accepted: true });
  });

  test('a non-numeric position is refused', async () => {
    const r = await post('/dispatch/riders/position',
      { lat: 'here', lng: 'there' }, asRider('r-pos'));
    assert.equal(r.status, 422);
  });

  test('only riders may push positions', async () => {
    assert.equal((await post('/dispatch/riders/position', { lat: 5.6, lng: -0.18 })).status, 401);
  });
});

describe('eligibility probe', () => {
  test('explains exactly why a rider is not getting offers', async () => {
    const b = await (await post('/dispatch/eligibility', {
      ...legRequest({ legId: 'leg-e1', isCod: true }),
      rider: {
        riderId: 'r-why', lat: 5.6040, lng: -0.1872, vehicle: 'motorbike',
        codObligationPesewas: '30500',
      },
    })).json() as any;

    assert.equal(b.eligible, false);
    assert.match(b.reason, /cash balance/, 'support gets a real answer, not a guess');
  });

  test('a healthy rider probes as eligible', async () => {
    const b = await (await post('/dispatch/eligibility', {
      ...legRequest({ legId: 'leg-e2' }),
      rider: { riderId: 'r-ok', lat: 5.6040, lng: -0.1872, vehicle: 'motorbike' },
    })).json() as any;
    assert.equal(b.eligible, true);
  });

  test('an unknown vehicle is refused', async () => {
    const r = await post('/dispatch/eligibility', {
      ...legRequest({ legId: 'leg-e3' }),
      rider: { riderId: 'r', lat: 5.6, lng: -0.18, vehicle: 'helicopter' },
    });
    assert.equal(r.status, 422);
  });
});

describe('escalation', () => {
  test('after round 1 expires, escalate to round 2', async () => {
    const b = await (await get('/dispatch/escalation?elapsedSeconds=30&lastRound=1'))
      .json() as any;
    assert.equal(b.action, 'broadcast');
    assert.equal(b.round, 2);
  });

  test('after all rounds, retry with a message for the customer', async () => {
    const b = await (await get('/dispatch/escalation?elapsedSeconds=100&lastRound=3'))
      .json() as any;
    assert.equal(b.action, 'retry_later');
    assert.equal(b.waitSeconds, 60);
    assert.match(b.customerMessage, /longer than usual/);
  });

  test('after five minutes, hand the choice to the customer', async () => {
    const b = await (await get('/dispatch/escalation?elapsedSeconds=500&lastRound=3'))
      .json() as any;
    assert.equal(b.action, 'give_up');
    assert.match(b.customerMessage, /cancel for a full refund/);
  });

  test('missing parameters are 422', async () => {
    assert.equal((await get('/dispatch/escalation')).status, 422);
  });
});

describe('config', () => {
  test('publishes the rounds so apps do not hardcode the countdown', async () => {
    const b = await (await get('/dispatch/config')).json() as any;
    assert.equal(b.rounds.length, 3);
    assert.deepEqual(b.rounds.map((r: any) => r.radiusMetres), [3000, 5000, 8000]);
    assert.ok(b.rounds.every((r: any) => r.offerTtlSeconds === 30));
    assert.equal(b.vehicleCapability.bicycle.maxWeightKg, 5);
  });
});
