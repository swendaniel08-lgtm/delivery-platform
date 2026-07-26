/**
 * fcm.spec — the real Firebase Cloud Messaging adapter.
 *
 * The interesting failures here are not "did the POST happen". They are:
 *   • minting an OAuth token per message and melting under dinner-time load
 *   • treating a permanently dead token as retryable and burning quota
 *   • treating a transient outage as permanent and dropping "rider arrived"
 *   • a mangled private key that fails with an opaque OpenSSL error
 *
 * A real RSA keypair is generated here so the RS256 assertion is genuinely
 * signed and genuinely verifiable — stubbing the signature would test nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import {
  FcmPushProvider, PushTokenInvalidError, parseServiceAccount, errorCode, isRetryable,
} from '../src/push/fcm.ts';
import { UpstreamError } from '../../../libs/platform/src/errors.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ACCOUNT = {
  project_id: 'besonc-gh',
  client_email: 'fcm@besonc-gh.iam.gserviceaccount.com',
  private_key: privateKey as string,
  token_uri: 'https://oauth2.test/token',
};

const MSG = {
  token: 'device-token-1',
  title: 'Your rider has arrived',
  body: 'Kwame is at the gate',
  critical: true,
  deepLink: 'besonc://orders/ord-1',
};

/** Records every call; answers OAuth and send separately. */
function harness(opts: {
  sendStatus?: number;
  sendBody?: unknown;
  oauthStatus?: number;
  oauthBody?: unknown;
  expiresIn?: number;
  delayMs?: number;
} = {}) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const impl: typeof fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({
      url,
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    if (url.includes('/token')) {
      return new Response(
        JSON.stringify(opts.oauthBody ?? {
          access_token: 'ya29.test-token', expires_in: opts.expiresIn ?? 3600,
        }),
        { status: opts.oauthStatus ?? 200 },
      );
    }
    return new Response(
      JSON.stringify(opts.sendBody ?? { name: 'projects/besonc-gh/messages/0:123' }),
      { status: opts.sendStatus ?? 200 },
    );
  };
  return { impl, calls, oauth: () => calls.filter((c) => c.url.includes('/token')) };
}

const provider = (o: Parameters<typeof harness>[0] = {}, over = {}) => {
  const h = harness(o);
  return {
    ...h,
    fcm: new FcmPushProvider({ serviceAccount: ACCOUNT, fetchImpl: h.impl, ...over }),
  };
};

/* ------------------------------------------------------------------ */

describe('service account parsing', () => {
  test('accepts a normal service-account JSON', () => {
    const sa = parseServiceAccount(JSON.stringify(ACCOUNT));
    assert.equal(sa.project_id, 'besonc-gh');
    assert.ok(sa.private_key.includes('BEGIN PRIVATE KEY'));
  });

  test('repairs \\n escapes mangled by a shell or a secrets UI', () => {
    // The classic deployment trap: the key arrives with literal backslash-n
    // and RS256 signing fails with an opaque OpenSSL error that looks like a
    // bad key rather than a formatting problem.
    const escaped = JSON.stringify({
      ...ACCOUNT, private_key: (privateKey as string).replace(/\n/g, '\\n'),
    });
    const sa = parseServiceAccount(escaped);
    assert.ok(sa.private_key.includes('\n'));
    assert.ok(!sa.private_key.includes('\\n'));
  });

  test('accepts base64-wrapped JSON (some secret managers)', () => {
    const b64 = Buffer.from(JSON.stringify(ACCOUNT)).toString('base64');
    assert.equal(parseServiceAccount(b64).project_id, 'besonc-gh');
  });

  test('rejects a missing field by NAME, not with a generic error', () => {
    const { private_key, ...rest } = ACCOUNT as any;
    assert.throws(() => parseServiceAccount(JSON.stringify(rest)), /private_key/);
  });

  test('rejects a value that is not a key at all', () => {
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ ...ACCOUNT, private_key: 'hunter2' })),
      /PEM/,
    );
  });

  test('rejects unparseable input', () => {
    assert.throws(() => parseServiceAccount('{{{'), /neither JSON nor base64/);
  });
});

/* ------------------------------------------------------------------ */

describe('OAuth2 assertion', () => {
  test('mints a token with a genuinely valid RS256 signature', async () => {
    const { fcm, oauth } = provider();
    assert.equal(await fcm.getAccessToken(), 'ya29.test-token');

    const assertion = new URLSearchParams(oauth()[0]!.body).get('assertion')!;
    const [h, c, sig] = assertion.split('.');

    // Verify against the PUBLIC key — the signature must be real.
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`)
      .verify(publicKey as string, Buffer.from(sig!, 'base64url'));
    assert.ok(ok, 'the OAuth assertion must carry a valid RS256 signature');

    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    assert.equal(claims.iss, ACCOUNT.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.aud, ACCOUNT.token_uri);
    assert.equal(claims.exp - claims.iat, 3600);
  });

  test('CACHES the token across sends', async () => {
    // Minting per message would put a Google round trip in front of every
    // notification and hit their quota at dinner-time peak.
    const { fcm, oauth } = provider();
    for (let i = 0; i < 5; i++) await fcm.send(MSG);
    assert.equal(oauth().length, 1, 'five sends must mint exactly one token');
  });

  test('keeps using the token while it is comfortably valid', async () => {
    let now = 1_000_000;
    const { fcm, oauth } = provider({ expiresIn: 3600 }, { now: () => now });
    await fcm.send(MSG);
    now += 3_000_000; // 50 minutes in, still 10 minutes of life left
    await fcm.send(MSG);
    assert.equal(oauth().length, 1);
  });

  test('re-mints once the token is near expiry', async () => {
    let now = 1_000_000;
    const { fcm, oauth } = provider({ expiresIn: 3600 }, { now: () => now });
    await fcm.send(MSG);
    // 59m20s: past (3600s - 60s safety margin), so the next send must re-mint
    // rather than fly with a token that expires mid-flight.
    now += 3_560_000;
    await fcm.send(MSG);
    assert.equal(oauth().length, 2);
  });

  test('a concurrent burst mints ONE token, not one each', async () => {
    const { fcm, oauth } = provider({ delayMs: 20 });
    await Promise.all(Array.from({ length: 10 }, () => fcm.send(MSG)));
    assert.equal(oauth().length, 1, 'the in-flight mint must be shared');
  });

  test('a rejected assertion is a clear UpstreamError', async () => {
    const { fcm } = provider({
      oauthStatus: 400,
      oauthBody: { error: 'invalid_grant', error_description: 'Invalid JWT: clock skew' },
    });
    await assert.rejects(() => fcm.send(MSG), (e: Error) => {
      assert.ok(e instanceof UpstreamError);
      assert.match(e.message, /clock skew/);
      return true;
    });
  });
});

/* ------------------------------------------------------------------ */

describe('sending', () => {
  test('posts to the v1 endpoint for the right project', async () => {
    const { fcm, calls } = provider();
    const res = await fcm.send(MSG);
    assert.equal(res.messageId, 'projects/besonc-gh/messages/0:123');

    const send = calls.find((c) => c.url.includes('messages:send'))!;
    assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/besonc-gh/messages:send');
    assert.equal(send.headers.authorization, 'Bearer ya29.test-token');
  });

  test('carries the token, title, body and deep link', async () => {
    const { fcm, calls } = provider();
    await fcm.send(MSG);
    const m = JSON.parse(calls.find((c) => c.url.includes('messages:send'))!.body).message;
    assert.equal(m.token, 'device-token-1');
    assert.equal(m.notification.title, 'Your rider has arrived');
    assert.equal(m.data.deepLink, 'besonc://orders/ord-1');
  });

  test('every data value is a STRING', async () => {
    // FCM rejects the entire message if any data value is a number or bool.
    const { fcm, calls } = provider();
    await fcm.send(MSG);
    const m = JSON.parse(calls.find((c) => c.url.includes('messages:send'))!.body).message;
    for (const [k, v] of Object.entries(m.data)) {
      assert.equal(typeof v, 'string', `data.${k} must be a string`);
    }
  });

  test('a critical push asks for high priority on both platforms', async () => {
    // "Your rider is at the gate" is worthless if the OS batches it.
    const { fcm, calls } = provider();
    await fcm.send(MSG);
    const m = JSON.parse(calls.find((c) => c.url.includes('messages:send'))!.body).message;
    assert.equal(m.android.priority, 'HIGH');
    assert.equal(m.apns.headers['apns-priority'], '10');
    assert.equal(m.apns.payload.aps['interruption-level'], 'time-sensitive');
    assert.equal(m.android.ttl, '600s');
  });

  test('a routine push is collapsible and lower priority', async () => {
    // A phone offline through six status changes should wake to the latest
    // one, not to six separate buzzes.
    const { fcm, calls } = provider();
    await fcm.send({ ...MSG, critical: false });
    const m = JSON.parse(calls.find((c) => c.url.includes('messages:send'))!.body).message;
    assert.equal(m.android.priority, 'NORMAL');
    assert.equal(m.android.collapse_key, 'besonc_status');
    assert.equal(m.apns.headers['apns-priority'], '5');
  });

  test('critical and routine use different notification channels', async () => {
    // Users must be able to silence status updates without silencing the
    // "rider is here" push that gets their food to them.
    const { fcm, calls } = provider();
    await fcm.send(MSG);
    await fcm.send({ ...MSG, critical: false });
    const chans = calls.filter((c) => c.url.includes('messages:send'))
      .map((c) => JSON.parse(c.body).message.android.notification.channel_id);
    assert.deepEqual(chans, ['besonc_critical', 'besonc_updates']);
  });
});

/* ------------------------------------------------------------------ */

describe('failure classification', () => {
  const fcmError = (errorCode: string, status = 404) => ({
    sendStatus: status,
    sendBody: {
      error: {
        status: 'NOT_FOUND',
        message: 'Requested entity was not found.',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }],
      },
    },
  });

  for (const code of ['UNREGISTERED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'SENDER_ID_MISMATCH']) {
    test(`${code} is reported as a DEAD TOKEN, with the token attached`, async () => {
      // This is the only signal we ever get that an app was uninstalled. If
      // it is not surfaced distinctly, the row lives forever and we pay the
      // round trip on every order for a phone that no longer exists.
      const { fcm } = provider(fcmError(code));
      await assert.rejects(() => fcm.send(MSG), (e: Error) => {
        assert.ok(e instanceof PushTokenInvalidError, `${code} must be a PushTokenInvalidError`);
        assert.equal((e as PushTokenInvalidError).token, 'device-token-1');
        return true;
      });
    });
  }

  test('a server outage is an UpstreamError, NOT a dead token', async () => {
    // Deleting a good token because Google had a bad minute would silently
    // unsubscribe the customer forever.
    const { fcm } = provider(fcmError('UNAVAILABLE', 503));
    await assert.rejects(() => fcm.send(MSG), (e: Error) => {
      assert.ok(!(e instanceof PushTokenInvalidError));
      assert.ok(e instanceof UpstreamError);
      return true;
    });
  });

  test('a 401 clears the cached token so the next send re-mints', async () => {
    let status = 401;
    const calls: string[] = [];
    const impl: typeof fetch = async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      }
      const s = status; status = 200;
      return new Response(
        JSON.stringify(s === 401 ? { error: { status: 'UNAUTHENTICATED' } }
          : { name: 'projects/besonc-gh/messages/1' }),
        { status: s },
      );
    };
    const fcm = new FcmPushProvider({ serviceAccount: ACCOUNT, fetchImpl: impl });

    await assert.rejects(() => fcm.send(MSG), /credentials/);
    await fcm.send(MSG);
    assert.equal(calls.filter((u) => u.includes('/token')).length, 2,
      'a revoked token must be re-minted, not reused');
  });

  test('a timeout is an UpstreamError naming the deadline', async () => {
    const { fcm } = provider({ delayMs: 200 }, { timeoutMs: 50 });
    await assert.rejects(() => fcm.send(MSG), /timed out after 50ms/);
  });

  test('errorCode digs the machine-readable code out of details', () => {
    assert.equal(errorCode({
      error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
    }), 'UNREGISTERED');
    // Falls back to the coarse status when details are absent.
    assert.equal(errorCode({ error: { status: 'PERMISSION_DENIED' } }), 'PERMISSION_DENIED');
    assert.equal(errorCode({}), 'UNKNOWN');
  });

  test('retryability is classified, not guessed', () => {
    assert.ok(isRetryable('UNAVAILABLE'));
    assert.ok(isRetryable('QUOTA_EXCEEDED'));
    assert.ok(!isRetryable('UNREGISTERED'));
    assert.ok(!isRetryable('THIRD_PARTY_AUTH_ERROR'));
  });
});
