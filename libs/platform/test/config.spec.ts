/**
 * config.spec — the boot-time guardrails.
 *
 * Every test here describes a way a real deployment goes wrong: a
 * placeholder secret shipped to production, a test Paystack key charging
 * real customers, a half-configured SMS provider that looks fine until the
 * first OTP. The service must refuse to start rather than fail quietly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigError, required, optional, numberFrom, boolFrom, secret, redact,
  stageFrom, hubtelFrom, arkeselFrom, smsConfigFrom, paystackFrom, mapsFrom,
  jwtFrom, s3From, firebaseFrom, describeConfig,
} from '../src/config/env.ts';

const prod = (over: Record<string, string> = {}) => ({ NODE_ENV: 'production', ...over });
const dev = (over: Record<string, string> = {}) => ({ NODE_ENV: 'development', ...over });

/** A realistic 40-char secret. */
const STRONG = 'k7Qz2mVx9pLr4TnB8wYc1JfHs6DgAe3XuZoNiMvR';

describe('primitives', () => {
  test('required throws with the variable name in the message', () => {
    assert.throws(() => required('DATABASE_URL', {}), (e: any) =>
      e instanceof ConfigError && /DATABASE_URL/.test(e.message));
  });

  test('blank and whitespace-only count as missing', () => {
    assert.throws(() => required('X', { X: '' }), ConfigError);
    assert.throws(() => required('X', { X: '   ' }), ConfigError);
  });

  test('optional trims and falls back', () => {
    assert.equal(optional('X', 'fallback', {}), 'fallback');
    assert.equal(optional('X', 'fallback', { X: '  value  ' }), 'value');
    assert.equal(optional('X', 'fallback', { X: '' }), 'fallback');
  });

  test('numbers are validated, not silently NaN', () => {
    assert.equal(numberFrom('PORT', 3000, {}), 3000);
    assert.equal(numberFrom('PORT', 3000, { PORT: '8080' }), 8080);
    assert.throws(() => numberFrom('PORT', 3000, { PORT: 'eight' }), ConfigError);
  });

  test('booleans accept the forms people actually write', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      assert.equal(boolFrom('F', false, { F: v }), true, v);
    }
    for (const v of ['0', 'false', 'no', 'off']) {
      assert.equal(boolFrom('F', true, { F: v }), false, v);
    }
    assert.throws(() => boolFrom('F', true, { F: 'maybe' }), ConfigError);
  });

  test('stage falls back to development for unknown values', () => {
    assert.equal(stageFrom({ NODE_ENV: 'production' }), 'production');
    assert.equal(stageFrom({ NODE_ENV: 'staging' }), 'staging');
    assert.equal(stageFrom({ NODE_ENV: 'test' }), 'development');
    assert.equal(stageFrom({}), 'development');
  });

  test('redact never reveals a secret', () => {
    assert.equal(redact(undefined), '(unset)');
    assert.equal(redact('short'), '****');
    const out = redact('sk_live_abcdefghijklmnop');
    assert.ok(!out.includes('abcdefghij'));
    assert.match(out, /^sk_l…op \(\d+ chars\)$/);
  });
});

describe('secrets', () => {
  test('a dev fallback keeps local development frictionless', () => {
    assert.equal(secret('S', { devFallback: 'dev-value' }, dev()), 'dev-value');
  });

  test('production REFUSES a missing secret', () => {
    assert.throws(
      () => secret('S', { devFallback: 'dev-value' }, prod()),
      (e: any) => /MUST be set in production/.test(e.message),
    );
  });

  test('production REFUSES a known placeholder', () => {
    assert.throws(
      () => secret('JWT_ACCESS_SECRET', {}, prod({ JWT_ACCESS_SECRET: 'dev-only-change-me' })),
      (e: any) => /placeholder/.test(e.message),
      'a JWT signed with the placeholder is a forgeable admin token',
    );
  });

  test('production REFUSES a short secret', () => {
    assert.throws(
      () => secret('S', {}, prod({ S: 'abc123' })),
      (e: any) => /at least 32 characters/.test(e.message),
    );
  });

  test('a strong production secret is accepted', () => {
    assert.equal(secret('S', {}, prod({ S: STRONG })), STRONG);
  });
});

describe('Hubtel', () => {
  test('unconfigured is null, not an error, in development', () => {
    assert.equal(hubtelFrom(dev()), null);
  });

  test('a complete configuration parses', () => {
    const h = hubtelFrom(dev({
      HUBTEL_CLIENT_ID: 'abc', HUBTEL_CLIENT_SECRET: 'xyz', HUBTEL_SENDER_ID: 'Besonc',
    }));
    assert.equal(h!.senderId, 'Besonc');
    assert.equal(h!.clientId, 'abc');
  });

  test('HALF-configured is refused — it looks fine until the first OTP', () => {
    assert.throws(
      () => hubtelFrom(dev({ HUBTEL_CLIENT_ID: 'abc' })),
      (e: any) => /partially configured/.test(e.message),
    );
    assert.throws(
      () => hubtelFrom(dev({ HUBTEL_CLIENT_ID: 'abc', HUBTEL_CLIENT_SECRET: 'xyz' })),
      ConfigError,
      'a sender id is mandatory',
    );
  });

  test('a sender ID over 11 characters is refused at boot', () => {
    assert.throws(
      () => hubtelFrom(dev({
        HUBTEL_CLIENT_ID: 'a', HUBTEL_CLIENT_SECRET: 'b',
        HUBTEL_SENDER_ID: 'BesoncDeliveryGhana',
      })),
      (e: any) => /GSM limit is 11/.test(e.message),
      'otherwise messages silently never arrive',
    );
  });

  test('an 11-character sender ID is exactly allowed', () => {
    const h = hubtelFrom(dev({
      HUBTEL_CLIENT_ID: 'a', HUBTEL_CLIENT_SECRET: 'b', HUBTEL_SENDER_ID: 'BesoncGhan',
    }));
    assert.equal(h!.senderId, 'BesoncGhan');
  });
});

describe('SMS configuration', () => {
  test('development may run on the in-memory stub', () => {
    const cfg = smsConfigFrom(dev());
    assert.equal(cfg.usingStub, true);
    assert.equal(cfg.hubtel, null);
  });

  test('PRODUCTION REFUSES TO BOOT WITH NO SMS PROVIDER', () => {
    assert.throws(
      () => smsConfigFrom(prod()),
      (e: any) => /nobody could sign in/.test(e.message),
      'no OTP means no logins at all — this must never start',
    );
  });

  test('Hubtel alone satisfies production', () => {
    const cfg = smsConfigFrom(prod({
      HUBTEL_CLIENT_ID: 'a', HUBTEL_CLIENT_SECRET: 'b', HUBTEL_SENDER_ID: 'Besonc',
    }));
    assert.equal(cfg.usingStub, false);
    assert.equal(cfg.arkesel, null);
  });

  test('Arkesel is picked up as failover', () => {
    const cfg = smsConfigFrom(dev({
      HUBTEL_CLIENT_ID: 'a', HUBTEL_CLIENT_SECRET: 'b', HUBTEL_SENDER_ID: 'Besonc',
      ARKESEL_API_KEY: 'k', ARKESEL_SENDER_ID: 'Besonc',
    }));
    assert.equal(cfg.arkesel!.apiKey, 'k');
  });

  test('an Arkesel key without a sender id is refused', () => {
    assert.throws(() => arkeselFrom(dev({ ARKESEL_API_KEY: 'k' })), ConfigError);
  });
});

describe('Paystack', () => {
  test('unconfigured is null in development', () => {
    assert.equal(paystackFrom(dev()), null);
  });

  test('production requires a key', () => {
    assert.throws(() => paystackFrom(prod()), ConfigError);
  });

  test('a test key parses and is flagged as test mode', () => {
    const p = paystackFrom(dev({ PAYSTACK_SECRET_KEY: 'sk_test_abc123' }));
    assert.equal(p!.isTestMode, true);
    assert.equal(p!.webhookSecret, 'sk_test_abc123',
      'Paystack signs with the secret key unless a separate one is set');
  });

  test('A TEST KEY IN PRODUCTION IS REFUSED', () => {
    assert.throws(
      () => paystackFrom(prod({ PAYSTACK_SECRET_KEY: 'sk_test_abc123' })),
      (e: any) => /Real customers would be charged against a test account/.test(e.message),
    );
  });

  test('a live key in production is accepted', () => {
    const p = paystackFrom(prod({ PAYSTACK_SECRET_KEY: 'sk_live_abc123def456' }));
    assert.equal(p!.isTestMode, false);
  });

  test('a public key pasted into the secret slot is caught', () => {
    assert.throws(
      () => paystackFrom(dev({ PAYSTACK_SECRET_KEY: 'pk_test_abc123' })),
      (e: any) => /must start with sk_test_ or sk_live_/.test(e.message),
      'an easy copy-paste mistake that would fail on the first charge',
    );
  });

  test('a separate webhook secret overrides the key', () => {
    const p = paystackFrom(dev({
      PAYSTACK_SECRET_KEY: 'sk_test_abc', PAYSTACK_WEBHOOK_SECRET: 'whsec_xyz',
    }));
    assert.equal(p!.webhookSecret, 'whsec_xyz');
  });
});

describe('Maps', () => {
  test('development may run without a key', () => {
    assert.equal(mapsFrom(dev()), null);
  });

  test('production requires one', () => {
    assert.throws(() => mapsFrom(prod()), ConfigError);
  });
});

describe('Firebase push', () => {
  const SA = {
    project_id: 'besonc-gh',
    client_email: 'fcm@besonc-gh.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n',
  };
  const json = (o: object = {}) => JSON.stringify({ ...SA, ...o });

  test('absent is allowed everywhere — no push is degraded, not broken', () => {
    // Critical alerts fall back to SMS. That costs money, so the banner is
    // loud, but it must not stop a deployment.
    assert.equal(firebaseFrom(dev()), null);
    assert.equal(firebaseFrom(prod()), null);
  });

  test('parses a downloaded service-account file', () => {
    const fb = firebaseFrom(dev({ FIREBASE_SERVICE_ACCOUNT_JSON: json() }))!;
    assert.equal(fb.projectId, 'besonc-gh');
    assert.equal(fb.clientEmail, SA.client_email);
  });

  test('accepts base64, which is how most secret managers carry it', () => {
    const b64 = Buffer.from(json()).toString('base64');
    assert.equal(firebaseFrom(dev({ FIREBASE_SERVICE_ACCOUNT_JSON: b64 }))?.projectId, 'besonc-gh');
  });

  test('repairs \\n escapes mangled by a shell', () => {
    const mangled = JSON.stringify({
      ...SA, private_key: SA.private_key.replace(/\n/g, '\\n'),
    });
    const fb = firebaseFrom(dev({ FIREBASE_SERVICE_ACCOUNT_JSON: mangled }))!;
    assert.ok(fb.privateKey.includes('\n'));
  });

  test('a bad key fails at BOOT, not at the first "rider has arrived"', () => {
    assert.throws(
      () => firebaseFrom(dev({ FIREBASE_SERVICE_ACCOUNT_JSON: json({ private_key: 'nope' }) })),
      /PEM/,
    );
    assert.throws(
      () => firebaseFrom(dev({ FIREBASE_SERVICE_ACCOUNT_JSON: '{{{' })),
      ConfigError,
    );
    assert.throws(
      () => firebaseFrom(dev({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'x' }) })),
      /client_email/,
    );
  });

  test('the banner says when push is off AND why that costs money', () => {
    assert.match(describeConfig('svc-messaging', dev()).join('\n'), /fall back to SMS/);
  });

  test('the banner names the project when push is live', () => {
    assert.match(
      describeConfig('svc-messaging', dev({ FIREBASE_SERVICE_ACCOUNT_JSON: json() })).join('\n'),
      /push=fcm\(besonc-gh\)/,
    );
  });

  test('the banner NEVER prints the private key', () => {
    const lines = describeConfig('svc-messaging', dev({
      FIREBASE_SERVICE_ACCOUNT_JSON: json({
        private_key: '-----BEGIN PRIVATE KEY-----\nSUPERSECRETMATERIAL\n-----END PRIVATE KEY-----\n',
      }),
    })).join('\n');
    assert.ok(!lines.includes('SUPERSECRETMATERIAL'));
  });
});

describe('object storage', () => {
  const S3 = {
    S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
    S3_ACCESS_KEY: 'AKIA123',
    S3_SECRET_KEY: 'secret123',
  };

  test('development may run without storage', () => {
    assert.equal(s3From(dev()), null);
  });

  test('production refuses to start without it', () => {
    // Uploads would be silently discarded: no proof of delivery, no KYC.
    assert.throws(() => s3From(prod()), ConfigError);
  });

  test('a half-configured bucket fails at BOOT, not at the first upload', () => {
    assert.throws(() => s3From(dev({ S3_ENDPOINT: 'https://s3.example.com' })), ConfigError);
    assert.throws(
      () => s3From(dev({ S3_ENDPOINT: 'https://s3.example.com', S3_ACCESS_KEY: 'a' })),
      ConfigError,
    );
  });

  test('rejects a malformed endpoint', () => {
    assert.throws(() => s3From(dev({ ...S3, S3_ENDPOINT: 'not-a-url' })), /valid URL/);
  });

  test('rejects plain http in production', () => {
    // The signature travels in the query string; http would put it in clear.
    assert.throws(
      () => s3From(prod({ ...S3, S3_ENDPOINT: 'http://s3.example.com' })),
      /https/,
    );
  });

  test('http is allowed in development (MinIO)', () => {
    const cfg = s3From(dev({ ...S3, S3_ENDPOINT: 'http://localhost:9000' }));
    assert.equal(cfg?.endpoint, 'http://localhost:9000');
  });

  test('sensible defaults for bucket and region', () => {
    const cfg = s3From(dev(S3))!;
    assert.equal(cfg.bucket, 'besonc-media');
    assert.equal(cfg.region, 'auto');
    assert.equal(cfg.forcePathStyle, undefined, 'unset means "let the adapter detect"');
    assert.equal(cfg.publicBaseUrl, null);
  });

  test('path-style is a tri-state, not a boolean', () => {
    // undefined must stay undefined so the adapter can auto-detect localhost;
    // collapsing it to `false` breaks every MinIO setup.
    assert.equal(s3From(dev({ ...S3, S3_FORCE_PATH_STYLE: 'true' }))?.forcePathStyle, true);
    assert.equal(s3From(dev({ ...S3, S3_FORCE_PATH_STYLE: 'false' }))?.forcePathStyle, false);
    assert.equal(s3From(dev(S3))?.forcePathStyle, undefined);
  });

  test('the banner says loudly when uploads are being discarded', () => {
    assert.match(describeConfig('svc-media', dev()).join('\n'), /uploads are DISCARDED/);
  });

  test('the banner names the bucket when storage is real', () => {
    const lines = describeConfig('svc-media', dev(S3)).join('\n');
    assert.match(lines, /storage=s3\(s3\.eu-west-1\.amazonaws\.com\/besonc-media\)/);
  });

  test('the banner NEVER prints the S3 secret key', () => {
    const lines = describeConfig('svc-media', dev({
      ...S3, S3_SECRET_KEY: 'wJalrXUtnFEMIsupersecretvalue',
    })).join('\n');
    assert.ok(!lines.includes('supersecretvalue'));
  });
});

describe('JWT', () => {
  test('development gets working defaults', () => {
    const j = jwtFrom(dev());
    assert.equal(j.accessTtlSeconds, 900);
    assert.equal(j.refreshTtlSeconds, 30 * 24 * 3600);
  });

  test('production refuses the placeholder secrets', () => {
    assert.throws(() => jwtFrom(prod()), ConfigError);
  });

  test('REUSING ONE SECRET FOR BOTH IS REFUSED IN PRODUCTION', () => {
    assert.throws(
      () => jwtFrom(prod({ JWT_ACCESS_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG })),
      (e: any) => /defeats refresh-token rotation/.test(e.message),
      'a stolen access token could otherwise be replayed as a refresh token',
    );
  });

  test('two distinct strong secrets are accepted', () => {
    const j = jwtFrom(prod({
      JWT_ACCESS_SECRET: STRONG,
      JWT_REFRESH_SECRET: `${STRONG}-refresh`,
    }));
    assert.notEqual(j.accessSecret, j.refreshSecret);
  });
});

describe('startup banner', () => {
  test('shouts loudly when SMS is a stub', () => {
    const lines = describeConfig('svc-identity', dev()).join('\n');
    assert.match(lines, /IN-MEMORY STUB/);
    assert.match(lines, /no real messages will be sent/);
  });

  test('names the sender id when Hubtel is live', () => {
    const lines = describeConfig('svc-identity', dev({
      HUBTEL_CLIENT_ID: 'a', HUBTEL_CLIENT_SECRET: 'b', HUBTEL_SENDER_ID: 'Besonc',
    })).join('\n');
    assert.match(lines, /hubtel\(sender=Besonc\)/);
    assert.ok(!lines.includes('IN-MEMORY STUB'));
  });

  test('distinguishes Paystack test mode from live', () => {
    assert.match(
      describeConfig('svc-payment', dev({ PAYSTACK_SECRET_KEY: 'sk_test_a' })).join('\n'),
      /paystack=TEST MODE/,
    );
    assert.match(
      describeConfig('svc-payment', dev({ PAYSTACK_SECRET_KEY: 'sk_live_abc123' })).join('\n'),
      /paystack=LIVE/,
    );
  });

  test('NEVER prints a raw secret', () => {
    const lines = describeConfig('svc-payment', dev({
      GOOGLE_MAPS_SERVER_KEY: 'AIzaSyVERYSECRETVALUE123',
      PAYSTACK_SECRET_KEY: 'sk_test_supersecretvalue',
      HUBTEL_CLIENT_SECRET: 'hubtel-secret-value',
    })).join('\n');

    assert.ok(!lines.includes('AIzaSyVERYSECRETVALUE123'));
    assert.ok(!lines.includes('supersecretvalue'));
    assert.ok(!lines.includes('hubtel-secret-value'));
  });

  test('a misconfiguration is reported, not thrown, so the banner still prints', () => {
    const lines = describeConfig('svc-identity', dev({ HUBTEL_CLIENT_ID: 'only-this' }))
      .join('\n');
    assert.match(lines, /sms=MISCONFIGURED/);
  });
});
