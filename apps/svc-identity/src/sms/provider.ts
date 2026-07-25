/**
 * SmsProvider — MASTER_PLAN issue #4.
 *
 * Hubtel is primary, Arkesel is automatic failover. OTP delivery failure means
 * zero signups, so we never depend on a single provider.
 *
 * Real credentials arrive via env; no code change required.
 */

import { UpstreamError } from '../../../../libs/platform/src/errors.ts';

export interface SmsMessage {
  /** E.164, e.g. +233551234987 */
  to: string;
  content: string;
  /** Correlation id for tracing across services. */
  correlationId?: string;
}

export interface SmsResult {
  provider: string;
  messageId: string;
  /** Cost in pesewas where the provider reports it. */
  costPesewas?: bigint;
}

export interface SmsProvider {
  readonly name: string;
  send(msg: SmsMessage): Promise<SmsResult>;
}

/* ------------------------------------------------------------------ */
/* Ghana phone number normalisation                                    */
/* ------------------------------------------------------------------ */

export class InvalidPhoneError extends Error {}

/**
 * Accepts 0551234987, 233551234987, +233551234987, with spaces/dashes.
 * Returns strict E.164. Ghana mobile prefixes are 2/3/5 after the country code.
 */
export function normaliseGhanaPhone(input: string): string {
  const digits = input.replace(/[\s\-()]/g, '');
  let national: string;

  if (digits.startsWith('+233')) national = digits.slice(4);
  else if (digits.startsWith('233')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;

  if (!/^\d{9}$/.test(national)) {
    throw new InvalidPhoneError(`not a valid Ghana mobile number: ${input}`);
  }
  // MTN 24/54/55/59, Telecel 20/50, AirtelTigo 26/27/56/57, Glo 23
  if (!/^[2356]/.test(national)) {
    throw new InvalidPhoneError(`unrecognised Ghana mobile prefix: ${input}`);
  }
  return `+233${national}`;
}

/** Which MoMo network a number belongs to — used by payment-svc later. */
export function detectNetwork(e164: string): 'mtn' | 'vod' | 'atl' | 'unknown' {
  const n = e164.replace('+233', '');
  const p = n.slice(0, 2);
  if (['24', '54', '55', '59', '25'].includes(p)) return 'mtn';
  if (['20', '50'].includes(p)) return 'vod';
  if (['26', '27', '56', '57'].includes(p)) return 'atl';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* Hubtel (primary)                                                     */
/* ------------------------------------------------------------------ */

export interface HubtelConfig {
  clientId: string;
  clientSecret: string;
  senderId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class HubtelSmsProvider implements SmsProvider {
  readonly name = 'hubtel';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: HubtelConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://smsc.hubtel.com/v1/messages/send';
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  async send(msg: SmsMessage): Promise<SmsResult> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('clientid', this.cfg.clientId);
    url.searchParams.set('clientsecret', this.cfg.clientSecret);
    url.searchParams.set('from', this.cfg.senderId);
    url.searchParams.set('to', msg.to);
    url.searchParams.set('content', msg.content);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: ctl.signal });
      if (!res.ok) {
        throw new UpstreamError('hubtel', `hubtel responded ${res.status}`);
      }
      const body = (await res.json()) as { messageId?: string; status?: number };
      if (body.status !== undefined && body.status !== 0) {
        throw new UpstreamError('hubtel', `hubtel status ${body.status}`);
      }
      return { provider: this.name, messageId: body.messageId ?? 'unknown' };
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError('hubtel', (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Arkesel (failover)                                                   */
/* ------------------------------------------------------------------ */

export interface ArkeselConfig {
  apiKey: string;
  senderId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class ArkeselSmsProvider implements SmsProvider {
  readonly name = 'arkesel';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ArkeselConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://sms.arkesel.com/api/v2/sms/send';
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  async send(msg: SmsMessage): Promise<SmsResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'api-key': this.cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: this.cfg.senderId,
          message: msg.content,
          recipients: [msg.to.replace('+', '')],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new UpstreamError('arkesel', `arkesel responded ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return { provider: this.name, messageId: body.data?.[0]?.id ?? 'unknown' };
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError('arkesel', (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Failover wrapper                                                     */
/* ------------------------------------------------------------------ */

export interface SmsSendLog {
  provider: string;
  ok: boolean;
  error?: string;
}

/**
 * Tries providers in order. Returns on the first success.
 * Throws only when every provider fails.
 */
export class FailoverSmsProvider implements SmsProvider {
  readonly name = 'failover';

  constructor(
    private readonly providers: SmsProvider[],
    private readonly onAttempt?: (log: SmsSendLog) => void,
  ) {
    if (providers.length === 0) throw new Error('at least one SMS provider required');
  }

  async send(msg: SmsMessage): Promise<SmsResult> {
    const failures: string[] = [];
    for (const p of this.providers) {
      try {
        const result = await p.send(msg);
        this.onAttempt?.({ provider: p.name, ok: true });
        return result;
      } catch (err) {
        const reason = (err as Error).message;
        failures.push(`${p.name}: ${reason}`);
        this.onAttempt?.({ provider: p.name, ok: false, error: reason });
      }
    }
    throw new UpstreamError('sms', `all SMS providers failed — ${failures.join('; ')}`);
  }
}

/** Dev/test provider. Captures messages instead of sending them. */
export class InMemorySmsProvider implements SmsProvider {
  readonly name = 'in-memory';
  readonly sent: SmsMessage[] = [];
  constructor(private readonly failWith?: Error) {}

  async send(msg: SmsMessage): Promise<SmsResult> {
    if (this.failWith) throw this.failWith;
    this.sent.push(msg);
    return { provider: this.name, messageId: `mem-${this.sent.length}` };
  }
}
