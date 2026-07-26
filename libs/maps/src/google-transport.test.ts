/**
 * google-transport.test — the real Google Maps client.
 *
 * The central concern here is that Google returns **HTTP 200 for logical
 * failures**. A revoked key, an exhausted quota and "no route exists" all
 * arrive as 200 with a `status` field. Checking `res.ok` alone is how a
 * platform ends up quoting GHS 0.00 delivery on every order in the country.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { GoogleMapsTransport, UnavailableMapsTransport } from './google-transport.ts';
import { UpstreamError } from '../../platform/src/errors.ts';

const ACCRA = { lat: 5.6037, lng: -0.1870 };
const OSU = { lat: 5.5560, lng: -0.1821 };

/** Records the URL and returns a canned body. */
function stub(body: unknown, init: { status?: number; delayMs?: number } = {}) {
  const urls: string[] = [];
  const impl: typeof fetch = async (input: any, opts: any = {}) => {
    urls.push(String(input));
    if (init.delayMs) {
      await new Promise((r) => setTimeout(r, init.delayMs));
      if (opts?.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    }
    return new Response(JSON.stringify(body), { status: init.status ?? 200 });
  };
  return { impl, urls };
}

const transport = (fetchImpl: typeof fetch, over = {}) =>
  new GoogleMapsTransport({ apiKey: 'test-key', fetchImpl, ...over });

/* ------------------------------------------------------------------ */

describe('configuration', () => {
  test('refuses to construct without a key', () => {
    assert.throws(
      () => new GoogleMapsTransport({ apiKey: '' }),
      /requires an API key/,
    );
  });

  test('the key is sent, and Ghana is the region', async () => {
    const s = stub({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', distance: { value: 5332 }, duration: { value: 900 } }] }],
    });
    await transport(s.impl).distanceMatrix(ACCRA, OSU);

    assert.match(s.urls[0]!, /key=test-key/);
    assert.match(s.urls[0]!, /region=gh/);
  });
});

describe('distanceMatrix', () => {
  test('returns metres and seconds from a real-shaped response', async () => {
    const s = stub({
      status: 'OK',
      rows: [{
        elements: [{
          status: 'OK',
          distance: { value: 5332, text: '5.3 km' },
          duration: { value: 900 },
          duration_in_traffic: { value: 1320 },
        }],
      }],
    });

    const r = await transport(s.impl).distanceMatrix(ACCRA, OSU);

    assert.equal(r.distanceMetres, 5332);
    assert.equal(r.durationSeconds, 1320,
      'traffic-aware duration is the one that matters in Accra');
  });

  test('asks for traffic — without it Accra ETAs are fiction', async () => {
    const s = stub({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', distance: { value: 100 }, duration: { value: 60 } }] }],
    });
    await transport(s.impl).distanceMatrix(ACCRA, OSU);
    assert.match(s.urls[0]!, /departure_time=now/);
  });

  test('falls back to free-flow duration when traffic data is absent', async () => {
    const s = stub({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', distance: { value: 800 }, duration: { value: 240 } }] }],
    });
    const r = await transport(s.impl).distanceMatrix(ACCRA, OSU);
    assert.equal(r.durationSeconds, 240);
  });

  test('A REVOKED KEY THROWS — it must never become a free delivery', async () => {
    // Google answers 200 for this. It is the single most dangerous
    // response shape in the whole integration.
    const s = stub({
      status: 'REQUEST_DENIED',
      error_message: 'The provided API key is expired.',
    });

    await assert.rejects(
      () => transport(s.impl).distanceMatrix(ACCRA, OSU),
      (e: any) => e instanceof UpstreamError
        && /REQUEST_DENIED/.test(e.message)
        && /expired/.test(e.message),
    );
  });

  test('an exhausted quota throws rather than returning zero', async () => {
    const s = stub({ status: 'OVER_QUERY_LIMIT' });
    await assert.rejects(
      () => transport(s.impl).distanceMatrix(ACCRA, OSU),
      /OVER_QUERY_LIMIT/,
    );
  });

  test('no route between two points is an error the caller can degrade on', async () => {
    const s = stub({
      status: 'OK',
      rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
    });
    await assert.rejects(
      () => transport(s.impl).distanceMatrix(ACCRA, OSU),
      (e: any) => e instanceof UpstreamError && /no route/.test(e.message),
    );
  });

  test('a malformed body does not produce a zero distance', async () => {
    const s = stub({ status: 'OK' });   // no rows at all
    await assert.rejects(
      () => transport(s.impl).distanceMatrix(ACCRA, OSU),
      /malformed response/,
    );
  });

  test('an HTTP 500 is an upstream error', async () => {
    const s = stub({}, { status: 500 });
    await assert.rejects(
      () => transport(s.impl).distanceMatrix(ACCRA, OSU),
      /returned 500/,
    );
  });

  test('a slow Google call times out', async () => {
    const s = stub({ status: 'OK', rows: [] }, { delayMs: 500 });
    await assert.rejects(
      () => transport(s.impl, { timeoutMs: 50 }).distanceMatrix(ACCRA, OSU),
      (e: any) => /timed out after 50ms/.test(e.message),
    );
  });

  test('an unreachable network is reported plainly', async () => {
    const impl: typeof fetch = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(
      () => transport(impl).distanceMatrix(ACCRA, OSU),
      /unreachable: ENOTFOUND/,
    );
  });
});

describe('reverseGeocode', () => {
  const body = (components: Array<{ long_name: string; types: string[] }>) => ({
    status: 'OK',
    results: [{
      formatted_address: 'Oxford St, Accra, Ghana',
      address_components: components,
    }],
  });

  test('PREFERS THE NEIGHBOURHOOD over the city', async () => {
    // "Osu" identifies a delivery. "Accra" covers several million people.
    const s = stub(body([
      { long_name: 'Osu', types: ['neighborhood'] },
      { long_name: 'Accra', types: ['locality'] },
    ]));

    const r = await transport(s.impl).reverseGeocode(OSU);
    assert.equal(r.areaName, 'Osu');
    assert.equal(r.formattedAddress, 'Oxford St, Accra, Ghana');
  });

  test('falls back through sublocality to locality', async () => {
    const s1 = stub(body([
      { long_name: 'East Legon', types: ['sublocality_level_1', 'sublocality'] },
      { long_name: 'Accra', types: ['locality'] },
    ]));
    assert.equal((await transport(s1.impl).reverseGeocode(OSU)).areaName, 'East Legon');

    const s2 = stub(body([{ long_name: 'Tema', types: ['locality'] }]));
    assert.equal((await transport(s2.impl).reverseGeocode(OSU)).areaName, 'Tema');
  });

  test('an unnamed pin still yields the formatted address', async () => {
    const s = stub({
      status: 'OK',
      results: [{ formatted_address: 'Unnamed Road, Ghana', address_components: [] }],
    });
    const r = await transport(s.impl).reverseGeocode(OSU);
    assert.equal(r.areaName, 'Unnamed Road, Ghana');
  });

  test('no result at all is an error', async () => {
    const s = stub({ status: 'ZERO_RESULTS', results: [] });
    await assert.rejects(() => transport(s.impl).reverseGeocode(OSU), UpstreamError);
  });
});

describe('autocomplete', () => {
  const predictions = {
    status: 'OK',
    predictions: [{
      place_id: 'ChIJ123',
      description: 'Accra Mall, Spintex Road, Accra, Ghana',
      structured_formatting: {
        main_text: 'Accra Mall',
        secondary_text: 'Spintex Road, Accra, Ghana',
      },
    }],
  };

  test('splits the prediction the way the UI renders it', async () => {
    const s = stub(predictions);
    const out = await transport(s.impl).autocomplete('accra mall', 'sess-1', ACCRA);

    assert.equal(out.length, 1);
    assert.equal(out[0]!.placeId, 'ChIJ123');
    assert.equal(out[0]!.mainText, 'Accra Mall');
    assert.equal(out[0]!.secondaryText, 'Spintex Road, Accra, Ghana');
  });

  test('RESTRICTS TO GHANA', async () => {
    const s = stub(predictions);
    await transport(s.impl).autocomplete('accra mall', 'sess-1');
    assert.match(s.urls[0]!, /components=country%3Agh/,
      'unrestricted, "Accra Mall" can return a shopping centre in Texas');
  });

  test('SENDS THE SESSION TOKEN — Google bills per keystroke without it', async () => {
    const s = stub(predictions);
    await transport(s.impl).autocomplete('acc', 'sess-abc');
    assert.match(s.urls[0]!, /sessiontoken=sess-abc/,
      'no token means per-keystroke billing, multiplying the bill by the '
      + 'length of what people type');
  });

  test('biases to the customer when a location is known', async () => {
    const s = stub(predictions);
    await transport(s.impl).autocomplete('mall', 'sess-1', ACCRA);
    assert.match(s.urls[0]!, /location=5\.6037%2C-0\.187/);
    assert.match(s.urls[0]!, /radius=30000/);
  });

  test('omits the bias when there is no location yet', async () => {
    const s = stub(predictions);
    await transport(s.impl).autocomplete('mall', 'sess-1');
    assert.ok(!s.urls[0]!.includes('location='));
  });

  test('NO MATCHES IS AN ANSWER, not an error', async () => {
    const s = stub({ status: 'ZERO_RESULTS', predictions: [] });
    const out = await transport(s.impl).autocomplete('zzzzz', 'sess-1');
    assert.deepEqual(out, [],
      'an empty list is what the user typed something unknown looks like');
  });

  test('a denied key still throws here', async () => {
    const s = stub({ status: 'REQUEST_DENIED' });
    await assert.rejects(() => transport(s.impl).autocomplete('x', 's'), /REQUEST_DENIED/);
  });
});

describe('the unconfigured transport', () => {
  test('throws rather than returning zeros', async () => {
    const t = new UnavailableMapsTransport();
    // MapsClient falls back to haversine on failure; a silent zero would
    // be a free delivery.
    await assert.rejects(() => t.distanceMatrix(), /no API key configured/);
    await assert.rejects(() => t.reverseGeocode(), /no API key configured/);
    await assert.rejects(() => t.autocomplete(), /no API key configured/);
  });
});
