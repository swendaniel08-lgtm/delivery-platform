/**
 * Media download authorisation — who may read which object.
 *
 * This file exists because of a real defect, found by exploit against a
 * running service. The check was:
 *
 *     if (!decoded.includes(c.sub)) throw new ForbiddenError('Not your object');
 *
 * A substring test against the object KEY. It was wrong in both directions
 * at once, which is what made it survive review:
 *
 *   DENIED the legitimate owner — buildKey embeds `ownerRef`, normally an
 *   ORDER id, not the uploader. The rider who took the proof photo got 403
 *   reading it back. Invisible because the app uploads and never re-reads.
 *
 *   GRANTED an attacker — `ownerRef` is client-supplied. Upload once with
 *   `ownerRef` set to your own id and every key containing that substring
 *   becomes readable.
 *
 * Ownership now comes from a recorded row, written when the URL is issued.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createService } from '../../../libs/platform/src/service/bootstrap.ts';
import { MediaHttpModule } from '../src/http.ts';
import { InMemoryMediaRepository } from '../src/pg-media-repository.ts';
import { InMemoryStorage } from '../src/media.ts';

const PORT = 4878;
const BASE = `http://127.0.0.1:${PORT}`;

const RIDER = 'rider-1';
const OTHER_RIDER = 'rider-2';

const tok = (role: string, sub: string) => JSON.stringify({ role, sub });

let svc: Awaited<ReturnType<typeof createService>>;

before(async () => {
  svc = await createService({
    name: 'svc-media-authz', port: PORT, host: '127.0.0.1',
    module: MediaHttpModule.forRoot({
      storage: new InMemoryStorage(),
      repository: new InMemoryMediaRepository(),
      verifyToken: (t: string) => JSON.parse(t),
    }),
  });
});

after(async () => { await svc?.stop?.(); });

async function upload(t: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/media/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

const view = (t: string, key: string) =>
  fetch(`${BASE}/media/objects/${encodeURIComponent(key)}/url`, {
    headers: { authorization: `Bearer ${t}` },
  });

const proof = (ownerRef: string) => ({
  kind: 'proof_of_delivery', contentType: 'image/jpeg',
  sizeBytes: 1024, ownerRef,
});

/* ------------------------------------------------------------------ */

describe('the uploader can read their own object', () => {
  test('a rider reads back the proof photo they took', async () => {
    // Regression: this returned 403 before. The key embeds the ORDER id, so
    // the substring check could never match the uploader.
    const t = tok('rider', RIDER);
    const up = await upload(t, proof('ord-1'));
    assert.equal(up.status, 201);

    const res = await view(t, up.body.objectKey);
    assert.equal(res.status, 200, 'the uploader was denied their own object');
    assert.ok((await res.json() as any).url);
  });
});

describe('THE BYPASS: ownership is not a substring match', () => {
  test('another rider cannot read it', async () => {
    const up = await upload(tok('rider', RIDER), proof('ord-2'));
    const res = await view(tok('rider', OTHER_RIDER), up.body.objectKey);
    assert.equal(res.status, 404);
  });

  test('a FORGED key containing the caller id is refused', async () => {
    // The exploit. Upload once naming yourself, then read anything whose
    // path happens to contain that string.
    await upload(tok('rider', 'evil'), proof('evil'));
    const res = await view(tok('rider', 'evil'), 'proof_of_delivery/evil/forged.jpg');
    assert.equal(res.status, 404,
      'a key the caller merely named is not a key the caller owns');
  });

  test('naming another rider as ownerRef grants nothing', async () => {
    // ownerRef is client-supplied, so it must confer no authority at all.
    const victim = await upload(tok('rider', RIDER), proof('ord-3'));
    const attacker = await upload(tok('rider', OTHER_RIDER), proof(RIDER));

    // The attacker owns their OWN object…
    assert.equal((await view(tok('rider', OTHER_RIDER), attacker.body.objectKey)).status, 200);
    // …but still not the victim's.
    assert.equal((await view(tok('rider', OTHER_RIDER), victim.body.objectKey)).status, 404);
  });

  test('an unknown key and a stranger\'s key answer identically', async () => {
    // Confirming an object exists leaks the order id encoded in the key.
    const up = await upload(tok('rider', RIDER), proof('ord-4'));
    const stranger = await view(tok('rider', OTHER_RIDER), up.body.objectKey);
    const missing = await view(tok('rider', OTHER_RIDER),
      'proof_of_delivery/ord-nope/00000000-0000-4000-8000-000000000000.jpg');

    assert.equal(stranger.status, missing.status);
    assert.deepEqual(
      (await stranger.json() as any).title,
      (await missing.json() as any).title,
    );
  });

  test('no token is refused', async () => {
    const res = await fetch(`${BASE}/media/objects/x/url`);
    assert.equal(res.status, 401);
  });
});

describe('KYC is admin-only, even for its subject', () => {
  test('a rider cannot re-read their own Ghana Card', async () => {
    // A key that leaks into a support chat must not become a document link.
    const t = tok('rider', RIDER);
    const up = await upload(t, {
      kind: 'kyc_ghana_card', contentType: 'image/jpeg', sizeBytes: 1024,
    });
    const res = await view(t, up.body.objectKey);
    assert.equal(res.status, 403);
  });

  test('an admin can', async () => {
    const up = await upload(tok('rider', RIDER), {
      kind: 'kyc_ghana_card', contentType: 'image/jpeg', sizeBytes: 1024,
    });
    assert.equal((await view(tok('admin', 'admin-1'), up.body.objectKey)).status, 200);
  });
});

describe('upload authorisation still holds', () => {
  test('a customer cannot upload proof of delivery', async () => {
    const res = await upload(tok('customer', 'cust-1'), proof('ord-5'));
    assert.equal(res.status, 403);
  });

  test('a rider cannot upload a menu photo', async () => {
    const res = await upload(tok('rider', RIDER), {
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 1024,
    });
    assert.equal(res.status, 403);
  });

  test('the role comes from the TOKEN, never the body', async () => {
    // Otherwise anyone could land a document in the KYC bucket.
    const res = await fetch(`${BASE}/media/uploads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok('customer', 'cust-1')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...proof('ord-6'), uploaderRole: 'rider', role: 'admin' }),
    });
    assert.equal(res.status, 403);
  });

  test('a public menu photo is readable without an ownership record', async () => {
    // Public kinds are CDN-cacheable by design; the check must not break them.
    const up = await upload(tok('vendor_owner', 'v1'), {
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 1024, ownerRef: 'store-1',
    });
    assert.equal((await view(tok('customer', 'anyone'), up.body.objectKey)).status, 200);
  });
});
