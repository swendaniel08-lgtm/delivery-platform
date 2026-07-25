/**
 * OTP issuing + verification with layered rate limiting.
 *
 * Closes issue #14. SMS pumping (fraudsters triggering OTPs to premium-rate
 * ranges) is a direct cash loss in Ghana, so limits are enforced on three
 * axes — phone, IP and device — plus a global circuit breaker.
 *
 * MASTER_PLAN §PART II item 14.
 */

import { RateLimitError, ValidationError } from '../../../../libs/platform/src/errors.ts';
import {
  type SmsProvider,
  normaliseGhanaPhone,
  InvalidPhoneError,
} from '../sms/provider.ts';

/* ---------------------------------------------------------------- */
/* Storage ports (Redis in production, in-memory in tests)           */
/* ---------------------------------------------------------------- */

export interface CounterStore {
  /** Increment a key and return the new value; sets TTL on first write. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Seconds remaining on the key, or 0 when absent. */
  ttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class InMemoryCounterStore implements CounterStore {
  private data = new Map<string, { value: string; expiresAt: number }>();
  constructor(private nowMs: () => number = Date.now) {}

  private sweep(key: string) {
    const e = this.data.get(key);
    if (e && e.expiresAt <= this.nowMs()) this.data.delete(key);
  }
  async incr(key: string, ttlSeconds: number): Promise<number> {
    this.sweep(key);
    const cur = this.data.get(key);
    if (!cur) {
      this.data.set(key, { value: '1', expiresAt: this.nowMs() + ttlSeconds * 1000 });
      return 1;
    }
    const next = Number(cur.value) + 1;
    cur.value = String(next);
    return next;
  }
  async ttl(key: string): Promise<number> {
    this.sweep(key);
    const e = this.data.get(key);
    return e ? Math.max(0, Math.ceil((e.expiresAt - this.nowMs()) / 1000)) : 0;
  }
  async get(key: string): Promise<string | null> {
    this.sweep(key);
    return this.data.get(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.nowMs() + ttlSeconds * 1000 });
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/* ---------------------------------------------------------------- */
/* Config                                                            */
/* ---------------------------------------------------------------- */

export interface OtpLimits {
  perPhoneHour: number;
  perPhoneDay: number;
  perIpHour: number;
  perDeviceHour: number;
  /** Platform-wide hourly ceiling — the SMS-spend circuit breaker. */
  globalHour: number;
  /** Wrong-code attempts before the code is burned. */
  maxVerifyAttempts: number;
  codeTtlSeconds: number;
  /** Minimum gap between sends to the same phone. */
  resendCooldownSeconds: number;
}

export const DEFAULT_OTP_LIMITS: OtpLimits = {
  perPhoneHour: 3,
  perPhoneDay: 10,
  perIpHour: 20,
  perDeviceHour: 5,
  globalHour: 5_000,
  maxVerifyAttempts: 5,
  codeTtlSeconds: 300,
  resendCooldownSeconds: 60,
};

export interface OtpRequestContext {
  phone: string;
  ip: string;
  deviceId: string;
}

export interface OtpIssueResult {
  phone: string;
  expiresInSeconds: number;
  provider: string;
  /** Only populated when `exposeCodeForTests` is on. Never in production. */
  debugCode?: string;
}

/* ---------------------------------------------------------------- */
/* Service                                                           */
/* ---------------------------------------------------------------- */

export class OtpService {
  constructor(
    private readonly store: CounterStore,
    private readonly sms: SmsProvider,
    private readonly limits: OtpLimits = DEFAULT_OTP_LIMITS,
    private readonly opts: {
      hashCode?: (code: string, phone: string) => string;
      generateCode?: () => string;
      exposeCodeForTests?: boolean;
    } = {},
  ) {}

  private hash(code: string, phone: string): string {
    return this.opts.hashCode
      ? this.opts.hashCode(code, phone)
      : // placeholder; swapped for argon2 when the service is wired to Nest
        Buffer.from(`${phone}:${code}`).toString('base64');
  }

  private generate(): string {
    if (this.opts.generateCode) return this.opts.generateCode();
    // 6 digits, uniform, from a CSPRNG
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return String(buf[0]! % 1_000_000).padStart(6, '0');
  }

  /** Throws RateLimitError when any limit is exceeded. */
  private async enforceLimits(phone: string, ctx: OtpRequestContext): Promise<void> {
    const cooldownKey = `otp:cooldown:${phone}`;
    const remaining = await this.store.ttl(cooldownKey);
    if (remaining > 0) {
      throw new RateLimitError(
        remaining,
        `Please wait ${remaining}s before requesting another code`,
      );
    }

    const checks: Array<[string, number, number, string]> = [
      [`otp:phone:h:${phone}`, 3600, this.limits.perPhoneHour, 'Too many codes requested for this number'],
      [`otp:phone:d:${phone}`, 86400, this.limits.perPhoneDay, 'Daily code limit reached for this number'],
      [`otp:ip:h:${ctx.ip}`, 3600, this.limits.perIpHour, 'Too many requests from this network'],
      [`otp:device:h:${ctx.deviceId}`, 3600, this.limits.perDeviceHour, 'Too many requests from this device'],
      [`otp:global:h`, 3600, this.limits.globalHour, 'Service temporarily unavailable'],
    ];

    for (const [key, ttl, max, message] of checks) {
      const count = await this.store.incr(key, ttl);
      if (count > max) {
        const retryAfter = (await this.store.ttl(key)) || ttl;
        throw new RateLimitError(retryAfter, message);
      }
    }
  }

  async request(ctx: OtpRequestContext): Promise<OtpIssueResult> {
    let phone: string;
    try {
      phone = normaliseGhanaPhone(ctx.phone);
    } catch (err) {
      if (err instanceof InvalidPhoneError) {
        throw new ValidationError({ phone: [err.message] });
      }
      throw err;
    }

    await this.enforceLimits(phone, ctx);

    const code = this.generate();
    await this.store.set(
      `otp:code:${phone}`,
      JSON.stringify({ hash: this.hash(code, phone), attempts: 0 }),
      this.limits.codeTtlSeconds,
    );
    await this.store.set(`otp:cooldown:${phone}`, '1', this.limits.resendCooldownSeconds);

    const result = await this.sms.send({
      to: phone,
      content: `${code} is your Besonc verification code. It expires in 5 minutes. Do not share it with anyone.`,
    });

    return {
      phone,
      expiresInSeconds: this.limits.codeTtlSeconds,
      provider: result.provider,
      ...(this.opts.exposeCodeForTests ? { debugCode: code } : {}),
    };
  }

  /**
   * Constant-time-ish verification. The code is burned on success and after
   * `maxVerifyAttempts` failures, so a code can never be brute-forced.
   */
  async verify(rawPhone: string, code: string): Promise<{ phone: string; verified: true }> {
    const phone = normaliseGhanaPhone(rawPhone);
    const key = `otp:code:${phone}`;
    const stored = await this.store.get(key);
    if (!stored) {
      throw new ValidationError({ code: ['Code expired or not requested'] });
    }

    const state = JSON.parse(stored) as { hash: string; attempts: number };
    const expected = state.hash;
    const actual = this.hash(code, phone);

    if (!timingSafeEqual(expected, actual)) {
      const attempts = state.attempts + 1;
      if (attempts >= this.limits.maxVerifyAttempts) {
        await this.store.del(key);
        throw new ValidationError({ code: ['Too many incorrect attempts. Request a new code.'] });
      }
      const ttl = (await this.store.ttl(key)) || this.limits.codeTtlSeconds;
      await this.store.set(key, JSON.stringify({ ...state, attempts }), ttl);
      throw new ValidationError({
        code: [`Incorrect code. ${this.limits.maxVerifyAttempts - attempts} attempt(s) remaining.`],
      });
    }

    await this.store.del(key);
    await this.store.del(`otp:cooldown:${phone}`);
    return { phone, verified: true };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
