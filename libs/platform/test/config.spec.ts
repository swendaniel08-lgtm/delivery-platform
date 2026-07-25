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
  jwtFrom, describeConfig,
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
