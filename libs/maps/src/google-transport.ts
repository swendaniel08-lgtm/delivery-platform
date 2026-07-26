/**
 * The real Google Maps transport.
 *
 * Everything above this file talks to the `GoogleTransport` port, so this
 * is the only place that knows Google's URL shapes, parameter names and
 * status codes. Swapping providers means writing one more file.
 *
 * Three things drive the design:
 *
 *   1. **Google bills per call.** `MapsClient` caches and budgets on top of
 *      this; here we make sure a single logical lookup is a single HTTP
 *      request, and that a failure never silently retries into a bill.
 *   2. **Google returns HTTP 200 for logical failures.** `REQUEST_DENIED`,
 *      `OVER_QUERY_LIMIT` and `ZERO_RESULTS` all arrive as 200 with a
 *      `status` field. Checking `res.ok` alone is how a platform ends up
 *      quoting GHS 0.00 delivery on every order.
 *   3. **Ghana-specific bias.** Results are restricted to GH and biased to
 *      the customer's location, or "Accra Mall" returns a shopping centre
 *      in Texas.
 */

import { UpstreamError } from '../../platform/src/errors.ts';
import type { LatLng } from './geohash.ts';
import type { GoogleTransport, PlaceSuggestion } from './maps-client.ts';

export interface GoogleMapsConfig {
  apiKey: string;
  /** Overridable for tests and for a regional endpoint. */
  baseUrl?: string;
  timeoutMs?: number;
  /** ISO country code for autocomplete restriction. */
  country?: string;
  fetchImpl?: typeof fetch;
}

/** Statuses Google returns inside a 200 response. */
const RETRYABLE_STATUSES = new Set(['UNKNOWN_ERROR', 'OVER_QUERY_LIMIT']);

export class GoogleMapsTransport implements GoogleTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly country: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: GoogleMapsConfig) {
    if (!cfg.apiKey) {
      throw new Error('GoogleMapsTransport requires an API key');
    }
    this.baseUrl = cfg.baseUrl ?? 'https://maps.googleapis.com/maps/api';
    // Deliberately short. A BFF answering a phone has its own deadline, and
    // a slow Maps call must not consume all of it.
    this.timeoutMs = cfg.timeoutMs ?? 3_000;
    this.country = cfg.country ?? 'gh';
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  /**
   * Straight-line-corrected road distance and duration.
   *
   * Distance Matrix rather than Directions: we need a number, not a
   * polyline, and Matrix is cheaper per element.
   */
  async distanceMatrix(
    from: LatLng, to: LatLng,
  ): Promise<{ distanceMetres: number; durationSeconds: number }> {
    const url = new URL(`${this.baseUrl}/distancematrix/json`);
    url.searchParams.set('origins', `${from.lat},${from.lng}`);
    url.searchParams.set('destinations', `${to.lat},${to.lng}`);
    url.searchParams.set('mode', 'driving');
    // Ghanaian traffic is the dominant term in an Accra ETA; without this
    // the numbers are optimistic to the point of being useless.
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('region', this.country);
    url.searchParams.set('key', this.cfg.apiKey);

    const body = await this.call<any>(url, 'distanceMatrix');

    const element = body.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') {
      // ZERO_RESULTS is normal — an island, a bad pin, a new estate with no
      // mapped road. The caller falls back to haversine rather than failing
      // the customer's checkout.
      throw new UpstreamError(
        'google-maps',
        `no route: ${element?.status ?? 'malformed response'}`,
      );
    }

    return {
      distanceMetres: Number(element.distance?.value ?? 0),
      // duration_in_traffic only appears with departure_time; fall back to
      // the free-flow duration when Google omits it.
      durationSeconds: Number(
        element.duration_in_traffic?.value ?? element.duration?.value ?? 0,
      ),
    };
  }

  /**
   * A human area name for a pin.
   *
   * Ghana's addressing means the useful answer is usually the
   * neighbourhood ("Osu", "East Legon"), not a street line. We surface both
   * and let the UI choose.
   */
  async reverseGeocode(
    p: LatLng,
  ): Promise<{ areaName: string; formattedAddress: string }> {
    const url = new URL(`${this.baseUrl}/geocode/json`);
    url.searchParams.set('latlng', `${p.lat},${p.lng}`);
    url.searchParams.set('region', this.country);
    url.searchParams.set('key', this.cfg.apiKey);

    const body = await this.call<any>(url, 'reverseGeocode');
    const first = body.results?.[0];
    if (!first) {
      throw new UpstreamError('google-maps', 'no geocode result');
    }

    return {
      areaName: pickAreaName(first) ?? first.formatted_address ?? '',
      formattedAddress: first.formatted_address ?? '',
    };
  }

  /**
   * Place autocomplete, restricted to Ghana and biased to the user.
   *
   * `sessionToken` is not optional in practice: Google bills autocomplete
   * per SESSION when one is supplied and per KEYSTROKE when it is not.
   * Omitting it multiplies the bill by roughly the length of what people
   * type.
   */
  async autocomplete(
    input: string, sessionToken: string, near?: LatLng,
  ): Promise<PlaceSuggestion[]> {
    const url = new URL(`${this.baseUrl}/place/autocomplete/json`);
    url.searchParams.set('input', input);
    url.searchParams.set('sessiontoken', sessionToken);
    url.searchParams.set('components', `country:${this.country}`);
    if (near) {
      url.searchParams.set('location', `${near.lat},${near.lng}`);
      // 30km covers Greater Accra; results outside it are almost never what
      // someone ordering dinner meant.
      url.searchParams.set('radius', '30000');
    }
    url.searchParams.set('key', this.cfg.apiKey);

    const body = await this.call<any>(url, 'autocomplete', ['ZERO_RESULTS']);

    return (body.predictions ?? []).map((p: any): PlaceSuggestion => ({
      placeId: p.place_id,
      mainText: p.structured_formatting?.main_text ?? p.description ?? '',
      secondaryText: p.structured_formatting?.secondary_text ?? '',
    }));
  }

  /**
   * One HTTP call, with the two failure modes Google actually has.
   *
   * `tolerate` lists logical statuses that should return the body rather
   * than throw — ZERO_RESULTS from autocomplete means "no matches", which
   * is an answer, not an error.
   */
  private async call<T>(
    url: URL, operation: string, tolerate: string[] = [],
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.doFetch(url, { signal: controller.signal });
    } catch (err) {
      const e = err as Error;
      throw new UpstreamError(
        'google-maps',
        e.name === 'AbortError'
          ? `${operation} timed out after ${this.timeoutMs}ms`
          : `${operation} unreachable: ${e.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new UpstreamError('google-maps', `${operation} returned ${res.status}`);
    }

    const body = await res.json() as { status?: string; error_message?: string };

    // THE IMPORTANT PART. Google answers 200 for REQUEST_DENIED (a bad or
    // unrestricted key), OVER_QUERY_LIMIT (billing) and ZERO_RESULTS.
    // Trusting res.ok alone means a revoked key quietly becomes "distance
    // 0", and every delivery in the country is suddenly free.
    const status = body.status;
    if (status && status !== 'OK' && !tolerate.includes(status)) {
      const detail = body.error_message ? `: ${body.error_message}` : '';
      throw new UpstreamError(
        'google-maps',
        `${operation} ${status}${detail}`,
        // Surfaced so a caller can distinguish "try again" from
        // "your key is wrong".
      );
    }

    return body as T;
  }
}

/**
 * The most useful place name in a Google geocode result.
 *
 * Preference order matters for Ghana: a neighbourhood ("Osu") identifies a
 * delivery far better than a locality ("Accra"), which covers millions of
 * people.
 */
function pickAreaName(result: any): string | null {
  const components: Array<{ long_name: string; types: string[] }> =
    result.address_components ?? [];

  const byType = (type: string) =>
    components.find((c) => c.types?.includes(type))?.long_name ?? null;

  return byType('neighborhood')
    ?? byType('sublocality_level_1')
    ?? byType('sublocality')
    ?? byType('locality')
    ?? byType('administrative_area_level_2')
    ?? null;
}

/**
 * A transport that never calls Google.
 *
 * Used when no key is configured. It throws rather than returning zeros,
 * because `MapsClient` already falls back to haversine on failure — and a
 * silent zero would be a free delivery.
 */
export class UnavailableMapsTransport implements GoogleTransport {
  private fail(op: string): never {
    throw new UpstreamError('google-maps', `${op}: no API key configured`);
  }
  async distanceMatrix(): Promise<never> { this.fail('distanceMatrix'); }
  async reverseGeocode(): Promise<never> { this.fail('reverseGeocode'); }
  async autocomplete(): Promise<never> { this.fail('autocomplete'); }
}
