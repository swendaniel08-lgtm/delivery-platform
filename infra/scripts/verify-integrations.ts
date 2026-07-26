/**
 * Are our third-party credentials actually alive?
 *
 * Every provider client in this codebase is real and wired to env vars, but
 * none has ever been run against real credentials. This script closes that
 * gap in one command, and it is designed so that NOBODY has to paste a key
 * into a chat window, a ticket or a pull request:
 *
 *   1. Fill in `.env` on your own machine.
 *   2. `make verify`
 *   3. Share the OUTPUT. Every secret is redacted to `sk_test_…4f2a`, and the
 *      provider's own error text is printed verbatim because that is the part
 *      that actually says what is wrong.
 *
 * Each check is the cheapest real call that proves the credential works:
 * a balance read, a zero-result lookup, a token mint, a bucket HEAD. Nothing
 * here charges a customer, sends a text to a stranger, or pushes to a device.
 *
 * Exit codes: 0 = everything configured is working. 1 = something configured
 * is broken. Absent credentials are reported as SKIP, never as failure —
 * a partial environment is a normal state, not an error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSign } from 'node:crypto';

const ROOT = join(import.meta.dirname, '../..');

/* ------------------------------------------------------------------ */
/* .env loading and redaction                                          */
/* ------------------------------------------------------------------ */

function loadEnv(): void {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) {
    console.log('No .env found — reading credentials from the process environment.\n');
    return;
  }
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined && value !== '') process.env[key] = value;
  }
}

/**
 * Enough to identify a key, never enough to use one.
 * Keeps the provider prefix, because `sk_live_` vs `sk_test_` is often the
 * whole answer.
 */
function redact(v: string | undefined | null): string {
  if (!v) return '(not set)';
  if (v.length <= 8) return '…'.padStart(v.length, '•');
  const prefixMatch = /^(sk_test_|sk_live_|pk_test_|pk_live_|AIza)/.exec(v);
  const prefix = prefixMatch ? prefixMatch[1] : v.slice(0, 3);
  return `${prefix}…${v.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

type Status = 'ok' | 'fail' | 'skip';

const results: Array<{ name: string; status: Status; detail: string }> = [];

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  grey: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function report(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
  const tag = status === 'ok' ? C.green('  LIVE')
    : status === 'fail' ? C.red('  FAIL')
      : C.grey('  SKIP');
  console.log(`${tag}  ${name.padEnd(22)} ${detail}`);
}

/** Bounded — a hanging provider must not hang the whole check. */
async function fetchWithTimeout(
  url: string, init: RequestInit = {}, ms = 10_000,
): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

function describeError(err: unknown): string {
  const e = err as Error;
  if (e.name === 'AbortError') return 'timed out after 10s';
  // A DNS or TLS failure here usually means egress is blocked, not that the
  // key is wrong — worth distinguishing, because the fix is entirely different.
  if (/ENOTFOUND|EAI_AGAIN/.test(e.message)) {
    return `cannot resolve the host (${e.message}) — DNS or egress blocked?`;
  }
  return e.message;
}

/* ------------------------------------------------------------------ */
/* Paystack                                                            */
/* ------------------------------------------------------------------ */

async function checkPaystack(): Promise<void> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return report('Paystack', 'skip', 'PAYSTACK_SECRET_KEY not set');

  if (!/^sk_(test|live)_/.test(key)) {
    return report('Paystack', 'fail',
      `${redact(key)} — a secret key must start with sk_test_ or sk_live_. `
      + 'This looks like a public key.');
  }

  const mode = key.startsWith('sk_live_') ? C.red('LIVE MODE') : 'test mode';

  try {
    // /balance, NOT /bank.
    //
    // The first version of this check listed banks — and reported a
    // completely fabricated key as LIVE, because /bank is a PUBLIC endpoint
    // that ignores the Authorization header entirely. A credential check that
    // passes without a credential is worse than no check: it manufactures
    // confidence. /balance is account-scoped and answers 401 to a bad key.
    const res = await fetchWithTimeout(
      'https://api.paystack.co/balance',
      { headers: { authorization: `Bearer ${key}` } },
    );
    const body: any = await res.json().catch(() => ({}));

    if (res.status === 401) {
      return report('Paystack', 'fail',
        `${redact(key)} rejected (401): ${body.message ?? 'Invalid key'}. `
        + 'The key is wrong, revoked, or from a different Paystack account.');
    }
    if (!res.ok || body.status === false) {
      return report('Paystack', 'fail',
        `${redact(key)} HTTP ${res.status}: ${body.message ?? 'no detail'}`);
    }

    // Ghana-specific: a GHS balance entry means the account is actually
    // enabled for Ghana. Without one, mobile money will not work no matter
    // how valid the key is.
    const balances: any[] = Array.isArray(body.data) ? body.data : [];
    const ghs = balances.find((b) => b.currency === 'GHS');
    const currencies = balances.map((b) => b.currency).join(', ') || 'none';

    report('Paystack', ghs ? 'ok' : 'fail',
      `${redact(key)} (${mode}) — ${ghs
        ? `GHS balance available (${currencies})`
        : C.red(`NO GHS balance. Account currencies: ${currencies}. `
          + 'This account is not enabled for Ghana.')}`);
  } catch (err) {
    report('Paystack', 'fail', `${redact(key)} — ${describeError(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Hubtel                                                              */
/* ------------------------------------------------------------------ */

async function checkHubtel(): Promise<void> {
  const id = process.env.HUBTEL_CLIENT_ID;
  const secret = process.env.HUBTEL_CLIENT_SECRET;
  const sender = process.env.HUBTEL_SENDER_ID;

  if (!id || !secret) return report('Hubtel SMS', 'skip', 'HUBTEL_CLIENT_ID / SECRET not set');
  if (!sender) {
    return report('Hubtel SMS', 'fail',
      'HUBTEL_SENDER_ID is not set. Hubtel rejects messages without an '
      + 'APPROVED sender id, and approval is a multi-week manual process.');
  }

  try {
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');

    // Hubtel reports authentication failure as `status: 4` inside an HTTP
    // 200 body — the same trap as Google Maps, and the reason an earlier
    // version of this check reported both good and bad credentials as
    // failing (it read the HTTP code from a different host entirely).
    //
    // We deliberately omit `to`, so Hubtel validates the credentials and
    // then refuses on the missing recipient. NO MESSAGE IS SENT and nobody
    // is charged — but a bad client id still comes back as status 4.
    const url = new URL('https://smsc.hubtel.com/v1/messages/send');
    url.searchParams.set('from', sender);
    url.searchParams.set('content', 'besonc credential verification');

    const res = await fetchWithTimeout(url.toString(), {
      headers: { authorization: `Basic ${auth}` },
    });
    const body: any = await res.json().catch(() => ({}));
    const status = Number(body.status);

    // 4 = "Client ID is null or empty", 5 = authentication failed.
    if (status === 4 || status === 5 || res.status === 401 || res.status === 403) {
      return report('Hubtel SMS', 'fail',
        `${redact(id)} rejected — ${body.statusDescription ?? `HTTP ${res.status}`}. `
        + 'Check HUBTEL_CLIENT_ID and HUBTEL_CLIENT_SECRET.');
    }

    // Anything else means the credentials passed and Hubtel got as far as
    // validating the message itself, which is exactly how far we want to go.
    report('Hubtel SMS', 'ok',
      `${redact(id)} authenticated, sender "${sender}" `
      + `(${body.statusDescription ?? 'accepted'}) `
      + C.grey('— sender-id APPROVAL is separate; confirm it in the Hubtel portal'));
  } catch (err) {
    report('Hubtel SMS', 'fail', `${redact(id)} — ${describeError(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Google Maps                                                         */
/* ------------------------------------------------------------------ */

async function checkGoogleMaps(): Promise<void> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return report('Google Maps', 'skip', 'GOOGLE_MAPS_SERVER_KEY not set');

  try {
    // Two real Accra points. One Distance Matrix element is the cheapest
    // call that proves the key AND that the right API is enabled.
    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', '5.5560,-0.1821');       // Osu
    url.searchParams.set('destinations', '5.6206,-0.1730');  // Accra Mall
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('region', 'gh');
    url.searchParams.set('key', key);

    const res = await fetchWithTimeout(url.toString());
    const body: any = await res.json().catch(() => ({}));

    // Google answers HTTP 200 for logical failures. Checking res.ok alone is
    // how a platform ends up quoting GHS 0.00 delivery on every order.
    if (body.status !== 'OK') {
      return report('Google Maps', 'fail',
        `${redact(key)} — ${body.status}: ${body.error_message ?? 'no detail'}`
        + (body.status === 'REQUEST_DENIED'
          ? '\n         Usually: Distance Matrix API not enabled, or the key '
            + 'is restricted to the wrong referrer/IP.'
          : ''));
    }

    const el = body.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') {
      return report('Google Maps', 'fail',
        `${redact(key)} authenticated but returned no route (${el?.status})`);
    }

    const km = (el.distance.value / 1000).toFixed(1);
    // Sanity-check the answer, not just the status: Osu to Accra Mall is
    // ~7km, and a wildly different number means swapped coordinates.
    const sane = el.distance.value > 3000 && el.distance.value < 20000;
    report('Google Maps', sane ? 'ok' : 'fail',
      `${redact(key)} — Osu→Accra Mall ${km} km, ${Math.round(el.duration.value / 60)} min`
      + (sane ? '' : C.red('  ← implausible; check coordinate order')));
  } catch (err) {
    report('Google Maps', 'fail', `${redact(key)} — ${describeError(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Firebase / FCM                                                      */
/* ------------------------------------------------------------------ */

async function checkFirebase(): Promise<void> {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return report('Firebase push', 'skip', 'FIREBASE_SERVICE_ACCOUNT_JSON not set');

  let sa: any;
  try {
    sa = JSON.parse(raw);
  } catch {
    try {
      sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      return report('Firebase push', 'fail',
        'not valid JSON or base64 JSON. Paste the whole downloaded '
        + 'service-account file, or base64 it.');
    }
  }

  for (const f of ['project_id', 'client_email', 'private_key']) {
    if (!sa[f]) return report('Firebase push', 'fail', `service account is missing "${f}"`);
  }

  const privateKey = String(sa.private_key).replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    return report('Firebase push', 'fail',
      'private_key is not a PEM key — the \\n escapes were probably mangled '
      + 'by a shell. This fails later as an opaque OpenSSL error.');
  }

  try {
    // Mint a real OAuth2 token. This proves the key, the clock and that the
    // FCM API is enabled — without sending a notification to anyone.
    const iat = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = b64({ alg: 'RS256', typ: 'JWT' });
    const claims = b64({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    });
    const sig = createSign('RSA-SHA256')
      .update(`${header}.${claims}`).sign(privateKey).toString('base64url');

    const res = await fetchWithTimeout(
      sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${header}.${claims}.${sig}`,
        }).toString(),
      },
    );
    const body: any = await res.json().catch(() => ({}));

    if (!res.ok || !body.access_token) {
      return report('Firebase push', 'fail',
        `token mint failed (${res.status}): ${body.error_description ?? body.error}`
        + (body.error === 'invalid_grant'
          ? '\n         Usually: server clock skew, or the key was revoked.'
          : ''));
    }
    report('Firebase push', 'ok',
      `project ${sa.project_id} — OAuth token minted, expires in ${body.expires_in}s`);
  } catch (err) {
    report('Firebase push', 'fail', describeError(err));
  }
}

/* ------------------------------------------------------------------ */
/* Object storage                                                      */
/* ------------------------------------------------------------------ */

async function checkStorage(): Promise<void> {
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) return report('Object storage', 'skip', 'S3_ENDPOINT not set');

  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (!accessKey || !secretKey) {
    return report('Object storage', 'fail',
      'S3_ENDPOINT is set but S3_ACCESS_KEY / S3_SECRET_KEY are not.');
  }

  const bucket = process.env.S3_BUCKET ?? 'besonc-media';

  try {
    const { S3Storage } = await import('../../apps/svc-media/src/storage/s3.ts');
    const store = new S3Storage({
      endpoint,
      bucket,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: process.env.S3_REGION ?? 'auto',
      ...(process.env.S3_FORCE_PATH_STYLE
        ? { forcePathStyle: /^(1|true|yes)$/i.test(process.env.S3_FORCE_PATH_STYLE) }
        : {}),
    });

    const exists = await store.bucketExists();
    if (!exists) {
      return report('Object storage', 'fail',
        `bucket "${bucket}" does not exist at ${new URL(endpoint).host}. `
        + 'Create it with its retention and block-public-access policies.');
    }

    // Prove a presigned PUT is actually ACCEPTED, not merely generated. A
    // signature that S3 rejects looks identical to a bad credential until
    // something tries to upload.
    const key = `_besonc_verify/${Date.now()}.txt`;
    const url = await store.presignPut({
      key, contentType: 'text/plain', maxBytes: 1024, expiresInSeconds: 60,
    });
    const put = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'besonc verification',
    });

    if (!put.ok) {
      return report('Object storage', 'fail',
        `bucket reachable but a presigned PUT was refused (HTTP ${put.status}). `
        + 'Check S3_FORCE_PATH_STYLE and S3_REGION — a region mismatch fails '
        + 'exactly like a bad key.');
    }

    await store.delete(key);
    report('Object storage', 'ok',
      `${bucket} @ ${new URL(endpoint).host} — presigned upload accepted and cleaned up`);
  } catch (err) {
    report('Object storage', 'fail', describeError(err));
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  loadEnv();

  console.log(C.bold('\nBesonc — third-party credential check'));
  console.log(C.grey('Every secret below is redacted. Output is safe to share.\n'));

  // Sequential: the output is meant to be read top to bottom, and these are
  // five calls, not a load test.
  await checkPaystack();
  await checkHubtel();
  await checkGoogleMaps();
  await checkFirebase();
  await checkStorage();

  const failed = results.filter((r) => r.status === 'fail');
  const live = results.filter((r) => r.status === 'ok');
  const skipped = results.filter((r) => r.status === 'skip');

  console.log('');
  console.log(`  ${live.length} live · ${failed.length} failing · ${skipped.length} not configured`);

  if (skipped.length) {
    console.log(C.grey(
      `\n  Not configured is not a failure — the platform runs without these, `
      + `\n  degraded in documented ways. See docs/RUNNING.md.`,
    ));
  }
  if (failed.length) {
    console.log(C.red('\n  Something configured is broken. The provider error text above'));
    console.log(C.red('  is the real answer — it is printed verbatim for that reason.'));
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('verification script itself failed:', err);
  process.exit(2);
});
