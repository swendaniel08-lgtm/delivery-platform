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
