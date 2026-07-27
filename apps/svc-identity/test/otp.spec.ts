/**
 * otp.spec — exit criterion for Sprint 2 / issue #14.
 * Proves the SMS-pumping defences actually hold.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OtpService,
  InMemoryCounterStore,
  DEFAULT_OTP_LIMITS,
  type OtpLimits,
} from '../src/otp/otp-service.ts';
import {
  InMemorySmsProvider,
  FailoverSmsProvider,
  normaliseGhanaPhone,
  detectNetwork,
  InvalidPhoneError,
} from '../src/sms/provider.ts';
import { RateLimitError, ValidationError, UpstreamError } from '../../../libs/platform/src/errors.ts';

/** Controllable clock so we can jump forward without sleeping. */
function harness(overrides: Partial<OtpLimits> = {}) {
  let now = 1_700_000_000_000;
  const clock = { now: () => now, advance: (s: number) => (now += s * 1000) };
  const store = new InMemoryCounterStore(clock.now);
  const sms = new InMemorySmsProvider();
  const limits = { ...DEFAULT_OTP_LIMITS, ...overrides };
  const svc = new OtpService(store, sms, limits, { exposeCodeForTests: true });
  return { svc, sms, store, clock, limits };
}

const ctx = (over: Partial<{ phone: string; ip: string; deviceId: string }> = {}) => ({
  phone: '0551234987',
  ip: '10.0.0.1',
  deviceId: 'device-a',
  ...over,
});

describe('Ghana phone normalisation', () => {
  test('accepts every common local format', () => {
    for (const input of ['0551234987', '233551234987', '+233551234987', '+233 55 123 4987', '055-123-4987']) {
      assert.equal(normaliseGhanaPhone(input), '+233551234987');
    }
  });

  test('rejects malformed numbers', () => {
    for (const bad of ['12345', '05512349871234', 'abcdefghi', '0151234987']) {
      assert.throws(() => normaliseGhanaPhone(bad), InvalidPhoneError, `should reject ${bad}`);
    }
  });

  test('detects MoMo network (needed by payment-svc)', () => {
    assert.equal(detectNetwork('+233241234567'), 'mtn');
    assert.equal(detectNetwork('+233551234567'), 'mtn');
    assert.equal(detectNetwork('+233201234567'), 'vod');
    assert.equal(detectNetwork('+233271234567'), 'atl');
  });
});

describe('OTP happy path', () => {
  test('sends a 6-digit code and verifies it', async () => {
    const { svc, sms } = harness();
    const issued = await svc.request(ctx());
    assert.equal(sms.sent.length, 1);
    assert.match(issued.debugCode!, /^\d{6}$/);
    assert.equal(issued.phone, '+233551234987');
    assert.match(sms.sent[0]!.content, /Do not share/);

    const res = await svc.verify('0551234987', issued.debugCode!);
    assert.equal(res.verified, true);
  });

  test('code is single-use', async () => {
    const { svc, clock } = harness();
    const issued = await svc.request(ctx());
    await svc.verify('0551234987', issued.debugCode!);
    clock.advance(1);
    await assert.rejects(() => svc.verify('0551234987', issued.debugCode!), ValidationError);
  });

  test('code expires', async () => {
    const { svc, clock, limits } = harness();
    const issued = await svc.request(ctx());
    clock.advance(limits.codeTtlSeconds + 1);
    await assert.rejects(() => svc.verify('0551234987', issued.debugCode!), ValidationError);
  });
});

describe('rate limiting — closes issue #14', () => {
  test('4th request within an hour is rejected (per-phone limit 3)', async () => {
    const { svc, clock, sms } = harness();
    for (let i = 0; i < 3; i++) {
      await svc.request(ctx());
      clock.advance(61); // clear the resend cooldown
    }
    assert.equal(sms.sent.length, 3);
    await assert.rejects(() => svc.request(ctx()), RateLimitError);
    assert.equal(sms.sent.length, 3, 'no SMS may be sent once limited');
  });

  test('resend cooldown blocks rapid repeats', async () => {
    const { svc } = harness();
    await svc.request(ctx());
    await assert.rejects(() => svc.request(ctx()), RateLimitError);
  });

  test('daily cap holds even as hours roll over', async () => {
    const { svc, clock } = harness({ perPhoneHour: 100, perPhoneDay: 10, perIpHour: 1000, perDeviceHour: 1000 });
    for (let i = 0; i < 10; i++) {
      await svc.request(ctx());
      clock.advance(61);
    }
    await assert.rejects(() => svc.request(ctx()), RateLimitError);
  });

  test('per-IP limit stops one host farming many numbers', async () => {
    const { svc, clock } = harness({ perIpHour: 5, perDeviceHour: 1000 });
    for (let i = 0; i < 5; i++) {
      await svc.request(ctx({ phone: `05512349${String(10 + i)}` }));
      clock.advance(61);
    }
    await assert.rejects(
      () => svc.request(ctx({ phone: '0551234999' })),
      RateLimitError,
    );
  });

  test('per-device limit stops one handset farming many numbers', async () => {
    const { svc, clock } = harness({ perDeviceHour: 3, perIpHour: 1000 });
    for (let i = 0; i < 3; i++) {
      await svc.request(ctx({ phone: `05512349${String(20 + i)}`, ip: `10.0.0.${i}` }));
      clock.advance(61);
    }
    await assert.rejects(
      () => svc.request(ctx({ phone: '0551234888', ip: '10.0.9.9' })),
      RateLimitError,
    );
  });

  test('global circuit breaker caps platform SMS spend', async () => {
    const { svc, clock } = harness({
      globalHour: 4, perPhoneHour: 100, perIpHour: 100, perDeviceHour: 100,
    });
    for (let i = 0; i < 4; i++) {
      await svc.request(ctx({ phone: `05512340${String(10 + i)}`, ip: `10.1.0.${i}`, deviceId: `d${i}` }));
      clock.advance(61);
    }
    await assert.rejects(
      () => svc.request(ctx({ phone: '0551234777', ip: '10.9.9.9', deviceId: 'dz' })),
      RateLimitError,
    );
  });

  test('limits reset after the window', async () => {
    const { svc, clock } = harness();
    for (let i = 0; i < 3; i++) { await svc.request(ctx()); clock.advance(61); }
    await assert.rejects(() => svc.request(ctx()), RateLimitError);
    clock.advance(3601);
    const ok = await svc.request(ctx());
    assert.match(ok.debugCode!, /^\d{6}$/);
  });

  test('RateLimitError carries Retry-After', async () => {
    const { svc } = harness();
    await svc.request(ctx());
    await assert.rejects(() => svc.request(ctx()), (e: unknown) => {
      assert.ok(e instanceof RateLimitError);
      assert.ok(e.retryAfterSeconds > 0 && e.retryAfterSeconds <= 60);
      assert.equal(e.status, 429);
      return true;
    });
  });
});

describe('brute-force resistance', () => {
  test('code burns after 5 wrong attempts', async () => {
    const { svc } = harness();
    const issued = await svc.request(ctx());
    const wrong = issued.debugCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      await assert.rejects(() => svc.verify('0551234987', wrong), ValidationError);
    }
    await assert.rejects(() => svc.verify('0551234987', wrong), ValidationError);
    // even the CORRECT code is now dead
    await assert.rejects(() => svc.verify('0551234987', issued.debugCode!), ValidationError);
  });
});

describe('SMS failover — issue #4', () => {
  test('falls through to the secondary provider', async () => {
    const primary = new InMemorySmsProvider(new UpstreamError('hubtel', 'down'));
    const secondary = new InMemorySmsProvider();
    const failover = new FailoverSmsProvider([primary, secondary]);
    const res = await failover.send({ to: '+233551234987', content: 'hi' });
    assert.equal(res.provider, 'in-memory');
    assert.equal(secondary.sent.length, 1);
  });

  test('throws only when every provider fails', async () => {
    const a = new InMemorySmsProvider(new UpstreamError('hubtel', 'down'));
    const b = new InMemorySmsProvider(new UpstreamError('arkesel', 'down'));
    const failover = new FailoverSmsProvider([a, b]);
    await assert.rejects(() => failover.send({ to: '+233551234987', content: 'hi' }), UpstreamError);
  });

  test('OTP still issues when the primary SMS provider is down', async () => {
    const store = new InMemoryCounterStore();
    const primary = new InMemorySmsProvider(new UpstreamError('hubtel', 'down'));
    const secondary = new InMemorySmsProvider();
    const svc = new OtpService(store, new FailoverSmsProvider([primary, secondary]),
      DEFAULT_OTP_LIMITS, { exposeCodeForTests: true });
    const issued = await svc.request(ctx());
    assert.equal(secondary.sent.length, 1);
    assert.equal((await svc.verify('0551234987', issued.debugCode!)).verified, true);
  });
});

describe('validation', () => {
  test('invalid phone never reaches the SMS provider', async () => {
    const { svc, sms } = harness();
    await assert.rejects(() => svc.request(ctx({ phone: 'not-a-phone' })), ValidationError);
    assert.equal(sms.sent.length, 0);
  });
});


/* ------------------------------------------------------------------ */
/* OTP hashing at rest                                                 */
/* ------------------------------------------------------------------ */

describe('the stored OTP is not recoverable', () => {
  test('THE CODE IS NEVER STORED IN A REVERSIBLE FORM', async () => {
    // This was base64(phone:code) — reversible in one line. Anyone who could
    // read Redis (a backup, a misconfigured bind, a support dump) recovered
    // every live code and could sign in as any user mid-flight. It was
    // labelled a placeholder and nothing replaced it, which is how
    // placeholders reach production.
    const { svc, store } = harness();
    const { debugCode } = await svc.request(ctx({ phone: '0244000111' })) as any;
    assert.ok(debugCode, 'test harness should expose the code');

    // Read the REAL backing map.
    //
    // The first version of this assertion inspected `(store as any).map`,
    // which does not exist — the field is `data`. It therefore serialised
    // `undefined`, asserted against an empty string, and passed no matter
    // what the service stored. Reverting hash() to base64 left it green:
    // the one spec whose entire job was to catch that regression could not.
    // Hence the explicit guard below that the dump is non-empty.
    const data = (store as any).data as Map<string, { value: string }>;
    assert.ok(data instanceof Map && data.size > 0,
      'the spec is not reading the real store — it would pass vacuously');

    const dump = JSON.stringify([...data.entries()]);
    assert.ok(dump.length > 20, 'nothing was actually inspected');

    assert.ok(!dump.includes(debugCode),
      'the code appears in the store in clear');

    // The exact previous implementation, and the generic shape of it.
    const b64 = Buffer.from(`+233244000111:${debugCode}`).toString('base64');
    assert.ok(!dump.includes(b64),
      'the code is stored base64-encoded, which is not hashing');

    // Anything base64-ish in the store must not decode to reveal the code.
    for (const [, entry] of data.entries()) {
      const hash = (() => {
        try { return JSON.parse(entry.value).hash as string; } catch { return null; }
      })();
      if (!hash) continue;
      for (const enc of ['base64', 'base64url'] as const) {
        const decoded = Buffer.from(hash, enc).toString('utf8');
        assert.ok(!decoded.includes(debugCode),
          `the stored hash decodes (${enc}) to reveal the code: ${decoded}`);
      }
    }
  });

  test('a correct code still verifies', async () => {
    // The hash change must not break the happy path.
    const { svc } = harness();
    const { debugCode } = await svc.request(ctx({ phone: '0244000222' })) as any;
    const r = await svc.verify('0244000222', debugCode);
    assert.equal(r.verified, true);
  });

  test('the hash is bound to the PHONE NUMBER', async () => {
    // Otherwise a hash lifted from one account replays against another that
    // happens to hold the same six digits.
    const { svc } = harness();
    const { debugCode } = await svc.request(ctx({ phone: '0244000333' })) as any;
    await svc.request(ctx({ phone: '0244000444', deviceId: 'device-b' }));
    await assert.rejects(
      () => svc.verify('0244000444', debugCode),
      ValidationError,
    );
  });

  test('production REFUSES to run without a pepper', async () => {
    // An unkeyed hash over a million six-digit codes is enumerable
    // instantly, so the pepper is the whole defence. Refusing beats
    // silently downgrading.
    const previousEnv = process.env.NODE_ENV;
    const previousPepper = process.env.OTP_PEPPER;
    process.env.NODE_ENV = 'production';
    delete process.env.OTP_PEPPER;
    try {
      const { svc } = harness();
      await assert.rejects(
        () => svc.request(ctx({ phone: '0244000555' })), /OTP_PEPPER/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousPepper !== undefined) process.env.OTP_PEPPER = previousPepper;
    }
  });

  test('a configured pepper changes the stored hash', async () => {
    // Two deployments with different peppers must not produce interchangeable
    // hashes.
    const a = new OtpService(
      new InMemoryCounterStore(), new InMemorySmsProvider(),
      DEFAULT_OTP_LIMITS, { exposeCodeForTests: true, pepper: 'pepper-a' },
    );
    const b = new OtpService(
      new InMemoryCounterStore(), new InMemorySmsProvider(),
      DEFAULT_OTP_LIMITS, { exposeCodeForTests: true, pepper: 'pepper-b' },
    );
    const ha = (a as any).hash('123456', '+233244000666');
    const hb = (b as any).hash('123456', '+233244000666');
    assert.notEqual(ha, hb);
  });
});
