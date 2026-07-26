/**
 * s3.spec — the real object-storage adapter.
 *
 * A presigned URL cannot be recalled once issued, so these specs are less
 * about "does it return a string" and more about what that string PERMITS.
 * The three failure modes that matter:
 *
 *   1. A signature that AWS rejects — looks exactly like bad credentials and
 *      wastes a day. Guarded by a determinstic vector below.
 *   2. A URL that permits more than intended (wrong key, no content-type,
 *      week-long expiry) — a silent security hole.
 *   3. A URL that leaks the secret key. Guarded explicitly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { S3Storage, uriEscape, escapeKey, amzDate } from '../src/storage/s3.ts';

const FIXED = new Date('2026-07-26T11:22:33Z');

const base = {
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  bucket: 'besonc-media',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'eu-west-1',
  now: () => FIXED,
};

const store = (over: Record<string, unknown> = {}) => new S3Storage({ ...base, ...over } as any);

/* ------------------------------------------------------------------ */

describe('configuration', () => {
  test('refuses to construct without credentials', () => {
    for (const missing of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']) {
      assert.throws(
        () => new S3Storage({ ...base, [missing]: '' } as any),
        new RegExp(missing),
        `missing ${missing} should fail loudly at construction, not at the first upload`,
      );
    }
  });

  test('virtual-host addressing for a real endpoint', () => {
    const url = new URL(store().presign({ method: 'GET', key: 'a/b.jpg', expiresInSeconds: 60 }));
    assert.equal(url.hostname, 'besonc-media.s3.eu-west-1.amazonaws.com');
    assert.equal(url.pathname, '/a/b.jpg');
  });

  test('path-style is auto-selected for localhost (MinIO in dev)', () => {
    // `besonc-media.127.0.0.1` cannot resolve; without this, every dev
    // upload fails with ENOTFOUND.
    const s = store({ endpoint: 'http://127.0.0.1:9000' });
    const url = new URL(s.presign({ method: 'GET', key: 'a/b.jpg', expiresInSeconds: 60 }));
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/besonc-media/a/b.jpg');
  });

  test('explicit forcePathStyle overrides detection', () => {
    const s = store({ forcePathStyle: true });
    const url = new URL(s.presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 }));
    assert.equal(url.hostname, 's3.eu-west-1.amazonaws.com');
    assert.equal(url.pathname, '/besonc-media/k.jpg');
  });
});

/* ------------------------------------------------------------------ */

describe('URI escaping', () => {
  test('escapes the characters encodeURIComponent leaves alone', () => {
    // AWS escapes these; if we do not, the canonical request differs from
    // theirs and the signature never matches.
    assert.equal(uriEscape("!'()*"), '%21%27%28%29%2A');
  });

  test('escapes slashes in a plain component but preserves them in a key', () => {
    assert.equal(uriEscape('a/b'), 'a%2Fb');
    assert.equal(escapeKey('proof_of_delivery/ord-1/x.jpg'), 'proof_of_delivery/ord-1/x.jpg');
  });

  test('escapes spaces as %20, never as +', () => {
    assert.equal(escapeKey('menu_item/v1/jollof rice.jpg'), 'menu_item/v1/jollof%20rice.jpg');
  });

  test('amzDate produces the AWS basic format', () => {
    assert.deepEqual(amzDate(FIXED), { long: '20260726T112233Z', short: '20260726' });
  });
});

/* ------------------------------------------------------------------ */

describe('SigV4 presigning', () => {
  /**
   * Independently recomputes the signature from the URL's own query string,
   * following the AWS spec by hand. If our signer and this verifier agree,
   * the canonical request is well-formed — this is the check that catches
   * ordering, escaping and scope mistakes before AWS does.
   */
  function recompute(signedUrl: string, method: string, secret: string, region: string) {
    const u = new URL(signedUrl);
    const params = new URLSearchParams(u.search);
    const claimed = params.get('X-Amz-Signature')!;
    params.delete('X-Amz-Signature');

    const signedHeaders = params.get('X-Amz-SignedHeaders')!;
    const long = params.get('X-Amz-Date')!;
    const short = long.slice(0, 8);

    const canonicalQuery = [...params.keys()].sort()
      .map((k) => `${uriEscape(k)}=${uriEscape(params.get(k)!)}`).join('&');

    const headerValues: Record<string, string> = { host: u.host };
    // content-type is the only other header we ever sign.
    const canonicalHeaders = signedHeaders.split(';')
      .map((h) => `${h}:${headerValues[h] ?? CT}\n`).join('');

    const canonicalRequest = [
      method, u.pathname, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
    ].join('\n');

    const scope = `${short}/${region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', long, scope,
      createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

    const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
    const key = h(h(h(h(`AWS4${secret}`, short), region), 's3'), 'aws4_request');
    return { claimed, computed: createHmac('sha256', key).update(sts).digest('hex') };
  }

  const CT = 'image/jpeg';

  test('GET signature verifies against an independent implementation', () => {
    const url = store().presign({ method: 'GET', key: 'kyc_selfie/u1/a.jpg', expiresInSeconds: 900 });
    const { claimed, computed } = recompute(url, 'GET', base.secretAccessKey, base.region);
    assert.equal(claimed, computed);
  });

  test('PUT signature with a signed content-type verifies', () => {
    const url = store().presign({
      method: 'PUT', key: 'proof_of_delivery/ord-1/a.jpg',
      contentType: CT, expiresInSeconds: 300,
    });
    const { claimed, computed } = recompute(url, 'PUT', base.secretAccessKey, base.region);
    assert.equal(claimed, computed);
  });

  test('signature is deterministic for the same inputs at the same instant', () => {
    const a = store().presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 });
    const b = store().presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 });
    assert.equal(a, b);
  });

  test('a different key produces a different signature', () => {
    // Otherwise one issued URL would unlock the whole bucket.
    const a = store().presign({ method: 'GET', key: 'kyc_selfie/u1/a.jpg', expiresInSeconds: 60 });
    const b = store().presign({ method: 'GET', key: 'kyc_selfie/u2/a.jpg', expiresInSeconds: 60 });
    assert.notEqual(
      new URL(a).searchParams.get('X-Amz-Signature'),
      new URL(b).searchParams.get('X-Amz-Signature'),
    );
  });

  test('a different method produces a different signature', () => {
    // A viewer must not be able to turn a GET URL into a DELETE.
    const g = store().presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 });
    const d = store().presign({ method: 'DELETE', key: 'k.jpg', expiresInSeconds: 60 });
    assert.notEqual(
      new URL(g).searchParams.get('X-Amz-Signature'),
      new URL(d).searchParams.get('X-Amz-Signature'),
    );
  });

  test('a wrong secret produces a different signature', () => {
    const good = store().presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 });
    const bad = store({ secretAccessKey: 'not-the-key' })
      .presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 });
    assert.notEqual(good, bad);
  });

  test('the secret key never appears in the URL', () => {
    const url = store().presign({
      method: 'PUT', key: 'k.jpg', contentType: CT, expiresInSeconds: 60,
    });
    assert.ok(!url.includes(base.secretAccessKey), 'secret leaked into a presigned URL');
    assert.ok(url.includes(base.accessKeyId), 'access key id is public and must be present');
  });

  test('content-type is in SignedHeaders for a PUT', () => {
    // Without this a rider could point a proof-of-delivery URL at any
    // payload type they like, including an executable.
    const url = store().presign({
      method: 'PUT', key: 'k.jpg', contentType: CT, expiresInSeconds: 60,
    });
    assert.equal(new URL(url).searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  });

  test('credential scope carries the region and the s3 service', () => {
    const url = store().presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 });
    assert.equal(
      new URL(url).searchParams.get('X-Amz-Credential'),
      'AKIAIOSFODNN7EXAMPLE/20260726/eu-west-1/s3/aws4_request',
    );
  });

  test('rejects a non-positive or over-7-day expiry', () => {
    assert.throws(() => store().presign({ method: 'GET', key: 'k', expiresInSeconds: 0 }), /expiry/);
    assert.throws(() => store().presign({ method: 'GET', key: 'k', expiresInSeconds: 604_801 }), /expiry/);
  });

  test('query parameters are sorted (AWS requires canonical ordering)', () => {
    const q = new URL(store().presign({ method: 'GET', key: 'k.jpg', expiresInSeconds: 60 })).search
      .replace(/^\?/, '').split('&').map((p) => p.split('=')[0]!)
      .filter((k) => k !== 'X-Amz-Signature');
    assert.deepEqual(q, [...q].sort(), 'canonical query must be sorted');
  });
});

/* ------------------------------------------------------------------ */

describe('StoragePort surface', () => {
  test('presignPut yields a 5-minute PUT URL for the exact key', async () => {
    const url = await store().presignPut({
      key: 'proof_of_delivery/ord-9/x.jpg',
      contentType: 'image/jpeg', maxBytes: 3_000_000, expiresInSeconds: 300,
    });
    const u = new URL(url);
    assert.equal(u.pathname, '/proof_of_delivery/ord-9/x.jpg');
    assert.equal(u.searchParams.get('X-Amz-Expires'), '300');
  });

  test('presignGet honours a longer view window', async () => {
    const url = await store().presignGet({ key: 'kyc_selfie/u1/a.jpg', expiresInSeconds: 900 });
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '900');
  });

  test('publicUrlFor uses the CDN base when configured', () => {
    const s = store({ publicBaseUrl: 'https://cdn.besonc.app/' });
    assert.equal(s.publicUrlFor('menu_item/v1/a.jpg'), 'https://cdn.besonc.app/menu_item/v1/a.jpg');
  });

  test('publicUrlFor falls back to the bucket origin, unsigned', () => {
    const url = store().publicUrlFor('menu_item/v1/a.jpg');
    assert.equal(url, 'https://besonc-media.s3.eu-west-1.amazonaws.com/menu_item/v1/a.jpg');
    assert.ok(!url.includes('X-Amz-Signature'), 'a public URL must not carry a signature');
  });
});

/* ------------------------------------------------------------------ */

describe('delete and head', () => {
  function fetchStub(status: number, headers: Record<string, string> = {}) {
    const calls: { url: string; method: string }[] = [];
    const impl: typeof fetch = async (input: any, init: any = {}) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(null, { status, headers });
    };
    return { impl, calls };
  }

  test('delete issues a signed DELETE, not a presigned URL handed out', async () => {
    const { impl, calls } = fetchStub(204);
    await store({ fetchImpl: impl }).delete('proof_of_delivery/ord-1/a.jpg');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'DELETE');
    assert.ok(calls[0]!.url.includes('X-Amz-Signature'));
  });

  test('delete treats 404 as success', async () => {
    // A retried purge job must not fail on its own second pass.
    const { impl } = fetchStub(404);
    await store({ fetchImpl: impl }).delete('k.jpg');
  });

  test('delete surfaces a real failure', async () => {
    const { impl } = fetchStub(500);
    await assert.rejects(() => store({ fetchImpl: impl }).delete('k.jpg'), /HTTP 500/);
  });

  test('head reports the TRUE size, not the client-claimed one', async () => {
    const { impl } = fetchStub(200, { 'content-length': '2411500', 'content-type': 'image/jpeg' });
    const r = await store({ fetchImpl: impl }).head('proof_of_delivery/o/a.jpg');
    assert.deepEqual(r, { exists: true, sizeBytes: 2_411_500, contentType: 'image/jpeg' });
  });

  test('head reports absence for 404 and 403 alike', async () => {
    // Buckets configured to hide keys answer 403; both mean "not there for us".
    for (const status of [404, 403]) {
      const { impl } = fetchStub(status);
      assert.equal((await store({ fetchImpl: impl }).head('k.jpg')).exists, false);
    }
  });
});
