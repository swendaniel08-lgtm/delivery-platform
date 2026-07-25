/**
 * Geohash — the cache key primitive behind our Google Maps cost controls.
 * MASTER_PLAN §3.7.
 *
 * Precision reference (approximate cell size):
 *   6 → 1.2 km × 0.6 km   ← distance-matrix cache (vendor→customer legs)
 *   7 → 153 m × 153 m     ← reverse-geocode cache (pin → area name)
 *   8 → 38 m × 19 m
 *
 * Two customers in the same Osu block share a cache entry, which is exactly
 * the behaviour that takes us from ~120k Directions calls/hour to ~3 per order.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface LatLng {
  lat: number;
  lng: number;
}

export class GeoError extends Error {}

export function assertLatLng(p: LatLng): void {
  if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) {
    throw new GeoError(`latitude out of range: ${p.lat}`);
  }
  if (!Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) {
    throw new GeoError(`longitude out of range: ${p.lng}`);
  }
}

export function encode(point: LatLng, precision = 7): string {
  assertLatLng(point);
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new GeoError(`precision must be 1..12, got ${precision}`);
  }

  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '';
  let bits = 0;
  let bit = 0;
  let evenBit = true;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (point.lng >= mid) { bit = (bit << 1) + 1; lngMin = mid; }
      else { bit = bit << 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (point.lat >= mid) { bit = (bit << 1) + 1; latMin = mid; }
      else { bit = bit << 1; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bits === 5) {
      hash += BASE32[bit]!;
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

/** Deterministic cache key for an origin→destination pair. */
export function routeCacheKey(from: LatLng, to: LatLng, precision = 6): string {
  return `${encode(from, precision)}:${encode(to, precision)}`;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMetres(a: LatLng, b: LatLng): number {
  assertLatLng(a); assertLatLng(b);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Fallback when Google Directions is unavailable.
 * PDF §5: straight-line × 1.4 is the average road-winding factor for
 * Ghanaian cities.
 */
export const ROAD_WINDING_FACTOR = 1.4;

export function fallbackRoadDistanceMetres(a: LatLng, b: LatLng): number {
  return Math.round(haversineMetres(a, b) * ROAD_WINDING_FACTOR);
}

/** Rough bounding box for Ghana — rejects obviously-bogus coordinates. */
export const GHANA_BOUNDS = {
  minLat: 4.5, maxLat: 11.2, minLng: -3.3, maxLng: 1.25,
} as const;

export function isWithinGhana(p: LatLng): boolean {
  return (
    p.lat >= GHANA_BOUNDS.minLat && p.lat <= GHANA_BOUNDS.maxLat &&
    p.lng >= GHANA_BOUNDS.minLng && p.lng <= GHANA_BOUNDS.maxLng
  );
}
