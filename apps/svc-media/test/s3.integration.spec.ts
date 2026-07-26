/**
 * s3.integration.spec — the adapter against a REAL S3 server (MinIO).
 *
 * The unit spec proves our signature matches an independent reimplementation
 * of the AWS algorithm. That is necessary but not sufficient: both could be
 * wrong in the same way. This spec settles it by having an actual S3
 * implementation accept or reject the signature, and by pushing real bytes
 * through a presigned URL and reading them back.
 *
 * Every bug this file is designed to catch is one that unit tests structurally
 * cannot see: a path-style mistake, an unsigned header, a clock-skew window,
 * a content-type mismatch. Those all fail as HTTP 403 SignatureDoesNotMatch —
 * indistinguishable from bad credentials, which is why they cost days.
 *
 * Skips (exit 0) when no server is reachable, so `test-all.sh` stays green on
 * a laptop with no Docker.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { S3Storage } from '../src/storage/s3.ts';
import { MediaService } from '../src/media.ts';

const ENDPOINT = process.env.S3_TEST_ENDPOINT ?? 'http://127.0.0.1:59000';
const BUCKET = `besonc-test-${Date.now()}`;

const storage = new S3Storage({
  endpoint: ENDPOINT,
  bucket: BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? 'besonc',
  secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? 'besonc_dev_secret',
  region: 'us-east-1',
  forcePathStyle: true,
});

/**
 * The probe runs at TOP LEVEL and SYNCHRONOUSLY.
 *
 * Two constraints collide here:
 *
 *   1. node:test evaluates `{ skip: ... }` while the `describe` body is being
 *      registered, which happens BEFORE any `before` hook fires. Deciding
 *      liveness in a hook makes every test skip unconditionally — a green
 *      light that can never go red, which is worse than no test at all.
 *   2. tsx transpiles to CJS here, so top-level `await` is unavailable.
 *
 * A synchronous curl satisfies both. It costs ~20ms and only runs once.
 */
function probe(): boolean {
  try {
    execFileSync('curl', ['-sf', '--max-time', '2', `${ENDPOINT}/minio/health/live`],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const live = probe();
if (!live) console.log(`# SKIP no S3 server at ${ENDPOINT} — start one with: make s3-up`);
else console.log(`# S3 server live at ${ENDPOINT}, bucket ${BUCKET}`);

/** Bucket creation is idempotent, so the first test that needs it may call it. */
let bucketReady = false;
async function ready() {
  if (!bucketReady) { await storage.ensureBucket(); bucketReady = true; }
}

const skip = () => (live ? false : 'no S3 server');

/* ------------------------------------------------------------------ */

describe('presigned upload against a real S3 server', () => {
  const key = 'proof_of_delivery/ord-live-1/photo.jpg';
  // A JPEG magic number — MinIO does not sniff, but a real CDN in front
  // might, and we want the fixture to be an honest image.
  const body = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(2048, 0x42),
  ]);

  test('a presigned PUT is ACCEPTED by the server', { skip: skip() }, async () => {
    await ready();
    const url = await storage.presignPut({
      key, contentType: 'image/jpeg', maxBytes: 3_000_000, expiresInSeconds: 300,
    });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: body as any,
    });
    assert.equal(res.status, 200,
      `S3 rejected our signature (${res.status}): ${await res.text()}`);
  });

  test('head sees the object at its TRUE size', { skip: skip() }, async () => {
    const info = await storage.head(key);
    assert.equal(info.exists, true);
    assert.equal(info.sizeBytes, body.length,
      'the size on disk is the only size we should ever trust');
    assert.equal(info.contentType, 'image/jpeg');
  });

  test('a presigned GET returns the exact bytes uploaded', { skip: skip() }, async () => {
    const url = await storage.presignGet({ key, expiresInSeconds: 900 });
    const res = await fetch(url);
    assert.equal(res.status, 200, `presigned GET failed: ${res.status}`);
    const got = Buffer.from(await res.arrayBuffer());
    assert.equal(got.length, body.length);
    assert.ok(got.equals(body), 'bytes round-tripped through S3 must be identical');
  });

  test('the PUT signature does not also authorise a GET', { skip: skip() }, async () => {
    // Method is part of the canonical request; if this ever passes, an
    // upload URL has become a read URL for the whole KYC prefix.
    const putUrl = await storage.presignPut({
      key, contentType: 'image/jpeg', maxBytes: 3_000_000, expiresInSeconds: 300,
    });
    const res = await fetch(putUrl, { method: 'GET' });
    // MinIO answers 400 (the signed content-type header is absent on a GET);
    // AWS answers 403. Either way it must not succeed — asserting the exact
    // code would make this spec provider-specific for no benefit.
    assert.ok(res.status >= 400, `a PUT URL must not read (got ${res.status})`);
  });

  test('a signature for one key cannot fetch another', { skip: skip() }, async () => {
    const url = await storage.presignGet({ key, expiresInSeconds: 300 });
    const tampered = url.replace('ord-live-1', 'ord-live-2');
    const res = await fetch(tampered);
    assert.equal(res.status, 403, 'editing the path must invalidate the signature');
  });

  test('a tampered signature is rejected', { skip: skip() }, async () => {
    const url = new URL(await storage.presignGet({ key, expiresInSeconds: 300 }));
    const sig = url.searchParams.get('X-Amz-Signature')!;
    url.searchParams.set('X-Amz-Signature', sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a'));
    assert.equal((await fetch(url.toString())).status, 403);
  });

  test('a PUT with the wrong content-type is rejected', { skip: skip() }, async () => {
    // content-type is in SignedHeaders precisely so this cannot happen: a
    // rider must not be able to store an executable behind a photo key.
    const url = await storage.presignPut({
      key: 'proof_of_delivery/ord-live-3/x.jpg',
      contentType: 'image/jpeg', maxBytes: 3_000_000, expiresInSeconds: 300,
    });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'MZ' as any,
    });
    assert.equal(res.status, 403, 'content-type must be bound by the signature');
  });

  test('an expired URL is rejected', { skip: skip() }, async () => {
    const past = new S3Storage({
      endpoint: ENDPOINT, bucket: BUCKET,
      accessKeyId: 'besonc', secretAccessKey: 'besonc_dev_secret',
      region: 'us-east-1', forcePathStyle: true,
      now: () => new Date(Date.now() - 3600_000),
    });
    const url = await past.presignGet({ key, expiresInSeconds: 60 });
    assert.equal((await fetch(url)).status, 403, 'a one-hour-old 60s URL must be dead');
  });

  test('wrong credentials are rejected by the server', { skip: skip() }, async () => {
    const bad = new S3Storage({
      endpoint: ENDPOINT, bucket: BUCKET,
      accessKeyId: 'besonc', secretAccessKey: 'wrong-secret',
      region: 'us-east-1', forcePathStyle: true,
    });
    assert.equal((await fetch(await bad.presignGet({ key, expiresInSeconds: 60 }))).status, 403);
  });

  test('delete really removes the object', { skip: skip() }, async () => {
    await storage.delete(key);
    assert.equal((await storage.head(key)).exists, false);
  });

  test('deleting an absent object is not an error', { skip: skip() }, async () => {
    await storage.delete(key); // second pass of a retried purge job
  });
});

/* ------------------------------------------------------------------ */

describe('MediaService end to end over real storage', () => {
  /**
   * The whole point of the port: MediaService is unchanged, but the URL it
   * hands a rider now leads somewhere real. This is the path that was
   * silently discarding every proof-of-delivery photo before today.
   */
  test('a rider proof photo survives the full round trip', { skip: skip() }, async () => {
    await ready();
    const media = new MediaService(storage);

    const upload = await media.requestUpload({
      kind: 'proof_of_delivery',
      contentType: 'image/jpeg',
      sizeBytes: 512,
      uploaderId: 'rider-1',
      uploaderRole: 'rider',
      ownerRef: 'ord-e2e-1',
    });

    assert.ok(upload.objectKey.startsWith('proof_of_delivery/ord-e2e-1/'));
    assert.equal(upload.publicUrl, null, 'proof photos are private');

    const bytes = Buffer.alloc(512, 0x37);
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: upload.requiredHeaders,
      body: bytes as any,
    });
    assert.equal(put.status, 200, await put.text());

    // The dispute path: months later, support asks to see the photo.
    const view = await media.viewUrl(upload.objectKey);
    const got = await fetch(view);
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).length, 512);

    await media.delete(upload.objectKey);
  });

  test('a menu photo is issued a public, unsigned URL', { skip: skip() }, async () => {
    await ready();
    const media = new MediaService(storage);
    const upload = await media.requestUpload({
      kind: 'menu_item',
      contentType: 'image/webp',
      sizeBytes: 90_000,
      uploaderId: 'vendor-1',
      uploaderRole: 'vendor_owner',
      ownerRef: 'store-1',
    });
    assert.ok(upload.publicUrl, 'menu photos must be CDN-cacheable');
    assert.ok(!upload.publicUrl!.includes('X-Amz-Signature'),
      'a cacheable URL cannot carry a signature — the CDN would cache the expiry too');
  });
});
