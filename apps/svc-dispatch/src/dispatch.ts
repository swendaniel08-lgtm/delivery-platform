/**
 * Dispatch — rider matching and assignment. PDF §4.
 *
 * Model: broadcast to the nearest N riders, FIRST TO ACCEPT WINS.
 *
 * Closes issue #7. The spec's "first to accept" is a race: three riders get
 * the offer simultaneously and two can tap Accept in the same millisecond.
 * Without an atomic claim both are told they won, both ride to the vendor,
 * and one is unpaid. The winner is decided by a single Redis
 * `SET key value NX PX ttl` — the only operation that can arbitrate this.
 *
 * Rounds (PDF §4): 3 km → 5 km → 8 km, 30 s each, 3 riders per round.
 */

import { ConflictError, NotFoundError, ValidationError } from '../../../libs/platform/src/errors.ts';
import { haversineMetres, type LatLng } from '../../../libs/maps/src/geohash.ts';
import type { Pesewas } from '../../../libs/money/src/money.ts';

export type VehicleType = 'bicycle' | 'motorbike' | 'car';

/** PDF §4 — which vehicles may carry which orders. */
export const VEHICLE_CAPABILITY: Record<VehicleType, {
  services: string[]; maxWeightKg: number; fragile: boolean;
}> = {
  bicycle:   { services: ['parcel', 'food'], maxWeightKg: 5, fragile: false },
  motorbike: { services: ['food','groceries','shop','market_catalogue','market_list','pharmacy','parcel','errand'], maxWeightKg: 10, fragile: false },
  car:       { services: ['food','groceries','shop','market_catalogue','market_list','pharmacy','laundry','parcel','errand'], maxWeightKg: 20, fragile: true },
};

export interface RiderCandidate {
  riderId: string;
  position: LatLng;
  vehicle: VehicleType;
  isOnline: boolean;
  hasActiveLeg: boolean;
  /** Unremitted cash the rider is holding. */
  codObligationPesewas: Pesewas;
  acceptanceRate: number;   // 0..1, last 30 days
  cancellationsToday: number;
}

export interface DispatchRequest {
  orderId: string;
  legId: string;
  service: string;
  pickup: LatLng;
  dropoff: LatLng;
  /** Estimated rider earnings, shown in the offer. */
  earningsPesewas: Pesewas;
  isCod: boolean;
  orderTotalPesewas: Pesewas;
  weightKg?: number;
  fragile?: boolean;
}

/* ---------------------------------------------------------------- */
/* Round configuration                                               */
/* ---------------------------------------------------------------- */

export interface DispatchRound {
  round: number;
  radiusMetres: number;
  riderCount: number;
  offerTtlSeconds: number;
}

export const DISPATCH_ROUNDS: DispatchRound[] = [
  { round: 1, radiusMetres: 3_000, riderCount: 3, offerTtlSeconds: 30 },
  { round: 2, radiusMetres: 5_000, riderCount: 3, offerTtlSeconds: 30 },
  { round: 3, radiusMetres: 8_000, riderCount: 3, offerTtlSeconds: 30 },
];

/** After all rounds: retry every 60 s for up to 5 minutes (PDF §4). */
export const RETRY_INTERVAL_SECONDS = 60;
export const MAX_RETRY_SECONDS = 300;

/** PDF §7 — a rider holding more than GHS 300 gets no more cash orders. */
export const RIDER_MAX_COD_PESEWAS = 30_000n;
/** PDF §8 — 3 cancellations in a day = 2 hours offline. */
export const MAX_DAILY_CANCELLATIONS = 3;

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

/** Why a rider may not receive a given offer. Order matters for diagnostics. */
export function isEligible(rider: RiderCandidate, req: DispatchRequest): EligibilityResult {
  if (!rider.isOnline) return { eligible: false, reason: 'offline' };
  if (rider.hasActiveLeg) return { eligible: false, reason: 'already on a delivery' };
  if (rider.cancellationsToday >= MAX_DAILY_CANCELLATIONS) {
    return { eligible: false, reason: 'suspended for cancellations' };
  }

  const cap = VEHICLE_CAPABILITY[rider.vehicle];
  if (!cap.services.includes(req.service)) {
    return { eligible: false, reason: `${rider.vehicle} cannot carry ${req.service}` };
  }
  if (req.weightKg !== undefined && req.weightKg > cap.maxWeightKg) {
    return { eligible: false, reason: `${rider.vehicle} limit is ${cap.maxWeightKg}kg` };
  }
  if (req.fragile && !cap.fragile) {
    return { eligible: false, reason: `${rider.vehicle} cannot carry fragile items` };
  }

  // COD gating — both the existing balance and what this order would add.
  if (req.isCod) {
    if (rider.codObligationPesewas > RIDER_MAX_COD_PESEWAS) {
      return { eligible: false, reason: 'unremitted cash balance too high' };
    }
    if (rider.codObligationPesewas + req.orderTotalPesewas > RIDER_MAX_COD_PESEWAS) {
      return { eligible: false, reason: 'this cash order would exceed the limit' };
    }
  }
  return { eligible: true };
}

/**
 * Rank eligible riders. Distance dominates, but acceptance rate breaks ties so
 * riders who habitually ignore offers slide down.
 */
export function rankRiders(
  riders: RiderCandidate[], req: DispatchRequest, radiusMetres: number,
): Array<RiderCandidate & { distanceMetres: number; score: number }> {
  return riders
    .map((r) => ({ ...r, distanceMetres: haversineMetres(r.position, req.pickup) }))
    .filter((r) => r.distanceMetres <= radiusMetres && isEligible(r, req).eligible)
    .map((r) => ({
      ...r,
      score: 0.8 * (1 / (1 + r.distanceMetres / 1000)) + 0.2 * r.acceptanceRate,
    }))
    .sort((a, b) => b.score - a.score || a.distanceMetres - b.distanceMetres);
}

/* ---------------------------------------------------------------- */
/* Atomic claim — the fix for issue #7                               */
/* ---------------------------------------------------------------- */

/**
 * Minimal Redis surface we depend on. `setNx` MUST map to
 * `SET key value NX PX ttl` — the atomicity is the whole point.
 */
export interface ClaimStore {
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Redis GEO: riders within radius, nearest first. */
  geoSearch(key: string, centre: LatLng, radiusMetres: number): Promise<string[]>;
  geoAdd(key: string, member: string, p: LatLng): Promise<void>;
}

export class InMemoryClaimStore implements ClaimStore {
  private kv = new Map<string, { v: string; exp: number }>();
  private geo = new Map<string, Map<string, LatLng>>();
  constructor(private nowMs: () => number = Date.now) {}

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const cur = this.kv.get(key);
    if (cur && cur.exp > this.nowMs()) return false;
    this.kv.set(key, { v: value, exp: this.nowMs() + ttlMs });
    return true;
  }
  async get(key: string) {
    const c = this.kv.get(key);
    return c && c.exp > this.nowMs() ? c.v : null;
  }
  async del(key: string) { this.kv.delete(key); }
  async geoAdd(key: string, member: string, p: LatLng) {
    if (!this.geo.has(key)) this.geo.set(key, new Map());
    this.geo.get(key)!.set(member, p);
  }
  async geoSearch(key: string, centre: LatLng, radiusMetres: number) {
    const m = this.geo.get(key) ?? new Map<string, LatLng>();
    return [...m.entries()]
      .map(([id, p]) => ({ id, d: haversineMetres(p, centre) }))
      .filter((x) => x.d <= radiusMetres)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.id);
  }
}

export interface Offer {
  legId: string;
  orderId: string;
  riderIds: string[];
  round: number;
  expiresAtMs: number;
}

export interface AcceptOutcome {
  won: boolean;
  winnerRiderId: string;
  /** Why this rider lost, for a clear client message. */
  reason?: 'won' | 'taken' | 'expired' | 'not_offered';
}

export class DispatchService {
  constructor(
    private readonly claims: ClaimStore,
    private readonly nowMs: () => number = Date.now,
  ) {}

  private claimKey(legId: string) { return `assignment:${legId}:winner`; }
  private offerKey(legId: string) { return `assignment:${legId}:offer`; }

  /** Broadcast one round. Returns the riders who were offered the job. */
  async broadcast(
    req: DispatchRequest, riders: RiderCandidate[], round: number,
  ): Promise<Offer> {
    const cfg = DISPATCH_ROUNDS.find((r) => r.round === round);
    if (!cfg) throw new ValidationError({ round: [`no round ${round}`] });

    // Already assigned? Don't re-broadcast.
    if (await this.claims.get(this.claimKey(req.legId))) {
      throw new ConflictError('leg already assigned');
    }

    const ranked = rankRiders(riders, req, cfg.radiusMetres).slice(0, cfg.riderCount);
    const offer: Offer = {
      legId: req.legId,
      orderId: req.orderId,
      riderIds: ranked.map((r) => r.riderId),
      round,
      expiresAtMs: this.nowMs() + cfg.offerTtlSeconds * 1000,
    };
    await this.claims.setNx(
      this.offerKey(req.legId), JSON.stringify(offer), cfg.offerTtlSeconds * 1000,
    );
    return offer;
  }

  /**
   * A rider taps Accept.
   *
   * The winner is decided by ONE atomic operation. Any number of riders may
   * call this concurrently; exactly one gets `won: true`.
   */
  async accept(legId: string, riderId: string): Promise<AcceptOutcome> {
    const raw = await this.claims.get(this.offerKey(legId));
    if (!raw) {
      // The offer window closed. Someone may still have claimed it.
      const winner = await this.claims.get(this.claimKey(legId));
      if (winner) {
        return { won: winner === riderId, winnerRiderId: winner, reason: winner === riderId ? 'won' : 'taken' };
      }
      return { won: false, winnerRiderId: '', reason: 'expired' };
    }

    const offer = JSON.parse(raw) as Offer;
    if (!offer.riderIds.includes(riderId)) {
      return { won: false, winnerRiderId: '', reason: 'not_offered' };
    }

    // THE ATOMIC CLAIM. Only the first caller succeeds.
    const won = await this.claims.setNx(this.claimKey(legId), riderId, 24 * 3600 * 1000);
    if (won) return { won: true, winnerRiderId: riderId, reason: 'won' };

    const winner = (await this.claims.get(this.claimKey(legId))) ?? '';
    return { won: false, winnerRiderId: winner, reason: 'taken' };
  }

  async currentWinner(legId: string): Promise<string | null> {
    return this.claims.get(this.claimKey(legId));
  }

  /** Rider cancels after accepting: release the claim so dispatch can retry. */
  async releaseClaim(legId: string): Promise<void> {
    await this.claims.del(this.claimKey(legId));
    await this.claims.del(this.offerKey(legId));
  }

  /** Live rider positions for the GEO index. */
  async updatePosition(riderId: string, p: LatLng): Promise<void> {
    await this.claims.geoAdd('riders:online', riderId, p);
  }

  async nearbyRiderIds(centre: LatLng, radiusMetres: number): Promise<string[]> {
    return this.claims.geoSearch('riders:online', centre, radiusMetres);
  }
}

/* ---------------------------------------------------------------- */
/* Round escalation                                                  */
/* ---------------------------------------------------------------- */

export interface EscalationDecision {
  action: 'broadcast' | 'retry_later' | 'give_up';
  round?: number;
  waitSeconds?: number;
  customerMessage?: string;
}

/**
 * What to do when a round expires with no acceptance.
 * PDF §4: 3 rounds of 30 s, then retry for up to 5 minutes, then let the
 * customer choose to wait or cancel.
 */
export function nextAction(elapsedSeconds: number, lastRound: number): EscalationDecision {
  if (lastRound < DISPATCH_ROUNDS.length) {
    return { action: 'broadcast', round: lastRound + 1 };
  }
  const sinceRounds = elapsedSeconds - DISPATCH_ROUNDS.length * 30;
  if (sinceRounds < MAX_RETRY_SECONDS) {
    return {
      action: 'retry_later',
      waitSeconds: RETRY_INTERVAL_SECONDS,
      customerMessage: 'Finding a rider is taking longer than usual',
    };
  }
  return {
    action: 'give_up',
    customerMessage: 'We could not find a rider. Wait a little longer, or cancel for a full refund.',
  };
}
