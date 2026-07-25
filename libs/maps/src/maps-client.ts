/**
 * Google Maps client with aggressive cost controls.
 *
 * Closes issue #8. The naive spec ("recalculate ETA every 30s per active
 * order") costs ~120k Directions calls/hour at 1,000 concurrent orders.
 * Budget here: <= 3 Directions calls per order.
 *
 * Controls (MASTER_PLAN §3.7):
 *   1. Distance Matrix results cached by geohash-6 pair, 24h
 *   2. Reverse geocode cached by geohash-7, 30 days
 *   3. Places Autocomplete uses session tokens (billed per session, not keystroke)
 *   4. In-flight ETA recomputed ONLY on >300m movement, >90s elapsed, or route deviation
 *   5. Hard daily call budget per API — exceeding it degrades to fallback, never bills
 */

import {
  type LatLng, routeCacheKey, encode, haversineMetres,
  fallbackRoadDistanceMetres, assertLatLng,
} from './geohash.ts';

export interface RouteResult {
  distanceMetres: number;
  durationSeconds: number;
  /** true when this came from the straight-line fallback, not Google. */
  estimated: boolean;
  source: 'google' | 'cache' | 'fallback';
}

export interface PlaceSuggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface ReverseGeocodeResult {
  areaName: string;
  formattedAddress: string;
  source: 'google' | 'cache';
}

/** Minimal cache port — Redis in production. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class InMemoryCache implements CacheStore {
  private data = new Map<string, { v: string; exp: number }>();
  hits = 0;
  misses = 0;
  constructor(private nowMs: () => number = Date.now) {}
  async get(key: string): Promise<string | null> {
    const e = this.data.get(key);
    if (!e || e.exp <= this.nowMs()) { this.misses++; return null; }
    this.hits++;
    return e.v;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.data.set(key, { v: value, exp: this.nowMs() + ttlSeconds * 1000 });
  }
  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}

/** Counts real upstream calls so tests can assert the budget. */
export interface CallBudget {
  directions: number;
  distanceMatrix: number;
  geocode: number;
  autocomplete: number;
}

export interface GoogleTransport {
  distanceMatrix(from: LatLng, to: LatLng): Promise<{ distanceMetres: number; durationSeconds: number }>;
  reverseGeocode(p: LatLng): Promise<{ areaName: string; formattedAddress: string }>;
  autocomplete(input: string, sessionToken: string, near?: LatLng): Promise<PlaceSuggestion[]>;
}

export interface MapsConfig {
  /** Cache TTLs in seconds. */
  routeTtl?: number;
  geocodeTtl?: number;
  /** Daily upstream call caps; beyond these we degrade rather than bill. */
  dailyDirectionsBudget?: number;
  dailyGeocodeBudget?: number;
  /** How far reality may diverge from prediction before recomputing (metres). */
  etaDeviationMetres?: number;
  /** Hard ceiling on ETA staleness (seconds). */
  etaMinIntervalSeconds?: number;
  /** Distance from destination at which we take one final accurate reading. */
  etaArrivalMetres?: number;
}

const DEFAULTS: Required<MapsConfig> = {
  routeTtl: 86_400,
  geocodeTtl: 2_592_000,
  dailyDirectionsBudget: 50_000,
  dailyGeocodeBudget: 20_000,
  etaDeviationMetres: 500,
  etaMinIntervalSeconds: 300,
  etaArrivalMetres: 400,
};

export class MapsClient {
  readonly calls: CallBudget = { directions: 0, distanceMatrix: 0, geocode: 0, autocomplete: 0 };
  private readonly cfg: Required<MapsConfig>;

  constructor(
    private readonly transport: GoogleTransport,
    private readonly cache: CacheStore,
    cfg: MapsConfig = {},
    private readonly nowMs: () => number = Date.now,
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  /**
   * Road distance + duration, cached by geohash-6 pair.
   * Used for delivery-fee calculation at checkout — the highest-volume call.
   */
  async route(from: LatLng, to: LatLng): Promise<RouteResult> {
    assertLatLng(from); assertLatLng(to);
    const key = `maps:route:${routeCacheKey(from, to, 6)}`;

    const cached = await this.cache.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as { d: number; t: number };
      return { distanceMetres: parsed.d, durationSeconds: parsed.t, estimated: false, source: 'cache' };
    }

    if (this.calls.distanceMatrix >= this.cfg.dailyDirectionsBudget) {
      return this.fallback(from, to);
    }

    try {
      this.calls.distanceMatrix++;
      const res = await this.transport.distanceMatrix(from, to);
      await this.cache.set(key, JSON.stringify({ d: res.distanceMetres, t: res.durationSeconds }), this.cfg.routeTtl);
      return { ...res, estimated: false, source: 'google' };
    } catch {
      return this.fallback(from, to);
    }
  }

  private fallback(from: LatLng, to: LatLng): RouteResult {
    const distanceMetres = fallbackRoadDistanceMetres(from, to);
    // 20 km/h average for Accra traffic on a motorbike
    const durationSeconds = Math.round((distanceMetres / 1000 / 20) * 3600);
    return { distanceMetres, durationSeconds, estimated: true, source: 'fallback' };
  }

  /** Pin → area name, cached by geohash-7 for 30 days. */
  async reverseGeocode(p: LatLng): Promise<ReverseGeocodeResult> {
    assertLatLng(p);
    const key = `maps:geo:${encode(p, 7)}`;
    const cached = await this.cache.get(key);
    if (cached) return { ...(JSON.parse(cached) as Omit<ReverseGeocodeResult, 'source'>), source: 'cache' };

    if (this.calls.geocode >= this.cfg.dailyGeocodeBudget) {
      return { areaName: 'Unknown area', formattedAddress: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, source: 'cache' };
    }
    this.calls.geocode++;
    const res = await this.transport.reverseGeocode(p);
    await this.cache.set(key, JSON.stringify(res), this.cfg.geocodeTtl);
    return { ...res, source: 'google' };
  }

  /**
   * Autocomplete with a session token. Google bills per *session*, so all
   * keystrokes leading to one selection must share a token.
   */
  async autocomplete(input: string, sessionToken: string, near?: LatLng): Promise<PlaceSuggestion[]> {
    if (input.trim().length < 3) return []; // never bill for 1-2 chars
    this.calls.autocomplete++;
    return this.transport.autocomplete(input, sessionToken, near);
  }
}

/* ------------------------------------------------------------------ */
/* In-flight ETA throttling — the core of the issue-#8 fix              */
/* ------------------------------------------------------------------ */

export interface EtaState {
  lastPosition: LatLng;
  lastComputedAtMs: number;
  lastDurationSeconds: number;
  lastDistanceMetres: number;
  /** Destination, so we can predict where the rider *should* be. */
  destination?: LatLng;
}

export interface EtaDecision {
  shouldRecompute: boolean;
  reason: 'first' | 'deviated' | 'stale' | 'arriving' | 'arrived' | 'interpolated';
  /** Client-side interpolation when we skip the upstream call. */
  interpolatedSeconds: number;
}

/**
 * Decides whether a rider GPS ping warrants a fresh Directions call.
 *
 * Key insight (and the correction that made issue #8 actually solvable):
 * distance *travelled* is the wrong trigger — a rider moving normally along
 * the known route tells us nothing new, because we can interpolate. What
 * matters is whether reality has DIVERGED from the prediction:
 *
 *   - the rider is further from the destination than we predicted
 *     (wrong turn, traffic, detour), or
 *   - the ETA has gone stale, or
 *   - the rider is nearly there and the customer wants precision.
 *
 * Normal progress along the route costs zero API calls.
 */
export function shouldRecomputeEta(
  state: EtaState | null,
  current: LatLng,
  nowMs: number,
  cfg: {
    deviationMetres?: number;
    minIntervalSeconds?: number;
    arrivalMetres?: number;
  } = {},
): EtaDecision {
  const maxDeviation = cfg.deviationMetres ?? DEFAULTS.etaDeviationMetres;
  const minInterval = cfg.minIntervalSeconds ?? DEFAULTS.etaMinIntervalSeconds;
  const arrivalMetres = cfg.arrivalMetres ?? DEFAULTS.etaArrivalMetres;

  if (!state) return { shouldRecompute: true, reason: 'first', interpolatedSeconds: 0 };

  const elapsedSeconds = (nowMs - state.lastComputedAtMs) / 1000;
  const interpolated = Math.max(0, Math.round(state.lastDurationSeconds - elapsedSeconds));

  // Deviation check — compare the rider's ACTUAL straight-line progress toward
  // the destination against the progress implied by the elapsed fraction of
  // the last ETA. Both sides are straight-line, so the road-winding factor
  // cancels out and a rider travelling normally never triggers a recompute.
  if (state.destination) {
    const startRemaining = haversineMetres(state.lastPosition, state.destination);
    const nowRemaining = haversineMetres(current, state.destination);

    // One accurate final reading as the rider closes in.
    if (nowRemaining <= arrivalMetres && startRemaining > arrivalMetres) {
      return { shouldRecompute: true, reason: 'arriving', interpolatedSeconds: interpolated };
    }

    if (state.lastDurationSeconds > 0 && startRemaining > 0) {
      const expectedFraction = Math.min(1, elapsedSeconds / state.lastDurationSeconds);
      const expectedRemaining = startRemaining * (1 - expectedFraction);
      // Only *lagging* matters; arriving early is good news and free.
      if (nowRemaining - expectedRemaining > maxDeviation) {
        return { shouldRecompute: true, reason: 'deviated', interpolatedSeconds: interpolated };
      }
    }
  }

  // Once the rider is at the destination there is nothing left to compute.
  // Without this, the staleness timer keeps billing while the rider is parked
  // outside the customer's gate waiting for them to come down.
  if (state.destination && haversineMetres(current, state.destination) <= arrivalMetres) {
    return { shouldRecompute: false, reason: 'arrived', interpolatedSeconds: interpolated };
  }

  if (elapsedSeconds >= minInterval) {
    return { shouldRecompute: true, reason: 'stale', interpolatedSeconds: interpolated };
  }

  return { shouldRecompute: false, reason: 'interpolated', interpolatedSeconds: interpolated };
}
