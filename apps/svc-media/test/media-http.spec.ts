/**
 * media-http.spec — who may upload what, and who may read it back.
 *
 * A presigned URL cannot be recalled once issued, so every one of these
 * checks has to happen BEFORE the URL exists. The KYC tests matter most: a
 * Ghana Card scan is the most sensitive thing on the platform.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createService, type RunningService } from '../../../libs/platform/src/service/bootstrap.ts';
import { MediaHttpModule, type Claims } from '../src/http.ts';
import { InMemoryStorage } from '../src/media.ts';

let svc: RunningService;
let BASE = '';

const token = (sub: string, role: string) => `${sub}:${role}`;
const verifyToken = (t: string): Claims => {
  const [sub, role] = t.split(':');
  if (!sub || !role) throw new Error('bad token');
  return { sub, role };
};
const as = (sub: string, role: string) => ({
  authorization: `Bearer ${token(sub, role)}`, 'content-type': 'application/json',
});

before(async () => {
  svc = await createService({
    name: 'svc-media', port: 4536, host: '127.0.0.1',
    module: MediaHttpModule.forRoot({ storage: new InMemoryStorage(), verifyToken }),
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

describe('requesting an upload', () => {
  test('a rider gets a presigned URL for proof of delivery', async () => {
    const r = await post('/media/uploads', {
      kind: 'proof_of_delivery', contentType: 'image/jpeg', sizeBytes: 900_000,
      ownerRef: 'order-1',
    }, as('r1', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.ok(b.uploadUrl, 'the client uploads straight to storage');
    assert.match(b.objectKey, /^proof_of_delivery\//);
    assert.ok(b.expiresInSeconds >= 60,
      'a 3MB photo on 3G needs more than a moment');
  });

  test('a customer cannot upload a menu photo', async () => {
    const r = await post('/media/uploads', {
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 100_000,
    }, as('c1', 'customer'));
    assert.equal(r.status, 403);
  });

  test('THE ROLE COMES FROM THE TOKEN, never the body', async () => {
    const r = await post('/media/uploads', {
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 100_000,
      // A client naming its own role would be able to land anything anywhere.
      uploaderRole: 'admin', uploaderId: 'someone-else',
    }, as('c1', 'customer'));
    assert.equal(r.status, 403, 'the body must not be able to escalate a role');
  });

  test('an oversized file is refused before a URL exists', async () => {
    const r = await post('/media/uploads', {
      kind: 'proof_of_delivery', contentType: 'image/jpeg', sizeBytes: 50_000_000,
    }, as('r1', 'rider'));
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(b.errors), /maximum 3MB/,
      'the limit is stated so the app can compress instead of failing');
  });

  test('a PDF cannot be passed off as a delivery photo', async () => {
    const r = await post('/media/uploads', {
      kind: 'proof_of_delivery', contentType: 'application/pdf', sizeBytes: 100_000,
    }, as('r1', 'rider'));
    assert.equal(r.status, 422);
  });

  test('a prescription MAY be a PDF — pharmacies send scans', async () => {
    const r = await post('/media/uploads', {
      kind: 'prescription', contentType: 'application/pdf', sizeBytes: 500_000,
    }, as('c1', 'customer'));
    assert.equal(r.status, 201);
  });

  test('an unknown kind is refused', async () => {
    const r = await post('/media/uploads', {
      kind: 'nuclear_codes', contentType: 'image/jpeg', sizeBytes: 100,
    }, as('r1', 'rider'));
    assert.equal(r.status, 422);
  });

  test('zero bytes is refused', async () => {
    const r = await post('/media/uploads', {
      kind: 'proof_of_delivery', contentType: 'image/jpeg', sizeBytes: 0,
    }, as('r1', 'rider'));
    assert.equal(r.status, 422);
  });

  test('an anonymous request gets nothing', async () => {
    const r = await post('/media/uploads', {
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 100,
    });
    assert.equal(r.status, 401);
  });
});

describe('reading an object back', () => {
  /** Upload something and return its key. */
  async function upload(kind: string, sub: string, role: string) {
    const b = await (await post('/media/uploads', {
      kind, contentType: 'image/jpeg', sizeBytes: 500_000, ownerRef: sub,
    }, as(sub, role))).json() as any;
    return b.objectKey as string;
  }

  test('a public menu photo is readable', async () => {
    const key = await upload('menu_item', 'v1', 'vendor_owner');
    const r = await get(`/media/objects/${encodeURIComponent(key)}/url`, as('c1', 'customer'));
    assert.equal(r.status, 200);
  });

  test('a rider can re-read their own proof photo', async () => {
    const key = await upload('proof_of_delivery', 'r1', 'rider');
    const r = await get(`/media/objects/${encodeURIComponent(key)}/url`, as('r1', 'rider'));
    assert.equal(r.status, 200);
  });

  test("another rider cannot read someone else's proof photo", async () => {
    const key = await upload('proof_of_delivery', 'r1', 'rider');
    const r = await get(`/media/objects/${encodeURIComponent(key)}/url`, as('r2', 'rider'));
    assert.equal(r.status, 403);
  });

  test('A RIDER CANNOT RE-READ THEIR OWN GHANA CARD', async () => {
    const key = await upload('kyc_ghana_card', 'r1', 'rider');
    const r = await get(`/media/objects/${encodeURIComponent(key)}/url`, as('r1', 'rider'));
    assert.equal(r.status, 403,
      'a key that leaks into a support chat must not resurrect an identity document');
  });

  test('an admin can read a KYC document', async () => {
    const key = await upload('kyc_ghana_card', 'r1', 'rider');
    const r = await get(`/media/objects/${encodeURIComponent(key)}/url`, as('a1', 'admin'));
    assert.equal(r.status, 200);
    const b = await r.json() as any;
    assert.ok(b.expiresInSeconds <= 3600,
      'a viewing URL must be short-lived — long enough to review, not to archive');
  });

  test('a nonsense key is 404, not a stack trace', async () => {
    const r = await get('/media/objects/not-a-real-key/url', as('a1', 'admin'));
    assert.equal(r.status, 404);
  });
});

describe('policy', () => {
  test('the apps can read the rules before choosing a file', async () => {
    const b = await (await get('/media/policy')).json() as any;

    assert.equal(b.kinds.proof_of_delivery.maxBytes, 3_000_000);
    assert.equal(b.kinds.menu_item.visibility, 'public');
    assert.equal(b.kinds.kyc_ghana_card.visibility, 'private');
    assert.deepEqual(b.kinds.prescription.allowedRoles, ['customer']);
    // 7 years: Ghanaian KYC retention.
    assert.equal(b.kinds.kyc_ghana_card.retentionDays, 2555);
  });

  test('proof photos are capped tighter than menu photos', async () => {
    const b = await (await get('/media/policy')).json() as any;
    assert.ok(b.kinds.proof_of_delivery.maxBytes < b.kinds.menu_item.maxBytes,
      'riders upload at volume on mobile data; vendors upload once on wifi');
  });
});
