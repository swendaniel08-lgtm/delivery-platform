/**
 * Paystack client — collections and payouts for Ghana.
 *
 * Verified against the live API surface (MASTER_PLAN §3.3):
 *   POST /charge          currency GHS + mobile_money { phone, provider }
 *                         provider ∈ mtn | vod | atl
 *   POST /transaction/initialize   card / hosted checkout
 *   POST /refund          transaction + optional amount
 *   POST /transferrecipient, POST /transfer   payouts to MoMo/bank
 *
 * Two rules that are non-negotiable:
 *   1. HTTP 200 from the API means the CALL succeeded, not the money moved.
 *      Terminal state comes from `data.status` or, preferably, the webhook.
 *   2. We never see a PAN or a MoMo PIN — that keeps PCI scope with Paystack.
 */

import { UpstreamError, ValidationError } from '../../../../libs/platform/src/errors.ts';
import type { Pesewas } from '../../../../libs/money/src/money.ts';

export type MomoProvider = 'mtn' | 'vod' | 'atl';

/** Maps a Ghana MSISDN prefix to Paystack's provider code. */
export function momoProviderFor(e164: string): MomoProvider {
  const n = e164.replace(/^\+233/, '');
  const p = n.slice(0, 2);
  if (['24', '54', '55', '59', '25'].includes(p)) return 'mtn';
  if (['20', '50'].includes(p)) return 'vod';
  if (['26', '27', '56', '57'].includes(p)) return 'atl';
  throw new ValidationError({ phone: [`no mobile money provider for ${e164}`] });
}

/**
 * Deterministic reference so a retry can never double-charge.
 * Paystack rejects a duplicate reference, which is exactly the behaviour we want.
 */
export function chargeReference(orderId: string, attempt: number): string {
  return `ord_${orderId.replace(/-/g, '')}_a${attempt}`;
}

export type ChargeStatus =
  | 'pending'        // awaiting the customer's handset prompt
  | 'send_otp'       // Paystack wants an OTP submitted
  | 'success'
  | 'failed'
  | 'abandoned';

export interface ChargeResult {
  reference: string;
  status: ChargeStatus;
  /** Paystack's own transaction id, once known. */
  gatewayId?: string;
  displayText?: string;
}

export interface TransferResult {
  reference: string;
  transferCode: string;
  /** NB: 'pending'/'otp' are NOT terminal. Wait for the webhook. */
  status: 'pending' | 'otp' | 'success' | 'failed' | 'reversed';
}

export interface RefundResult {
  reference: string;
  status: 'pending' | 'processing' | 'processed' | 'failed';
}

/** HTTP port so tests never hit the network. */
export interface PaystackTransport {
  post<T>(path: string, body: unknown): Promise<{ status: boolean; message: string; data: T }>;
  get<T>(path: string): Promise<{ status: boolean; message: string; data: T }>;
}

/**
 * Paystack rejects reserved TLDs — `.test`, `.local`, `.invalid` — with a bare
 * "Invalid Email Address Passed" and no indication of which field is wrong.
 *
 * Found the first time we ran against a real sandbox key: our own probe used
 * `customer@besonc.test` and was refused, while the address production
 * actually sends (`<uuid>@customers.besonc.app`) was accepted. Worth guarding
 * because the failure is silent at build time, arrives only from the network,
 * and reads like a credentials problem rather than a data one.
 */
const RESERVED_TLDS = ['.test', '.local', '.invalid', '.example', '.localhost'];

export function assertPaystackEmail(email: string): void {
  const lower = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(lower)) {
    throw new ValidationError({
      email: [`"${email}" is not a valid email address for Paystack`],
    });
  }
  const reserved = RESERVED_TLDS.find((t) => lower.endsWith(t));
  if (reserved) {
    throw new ValidationError({
      email: [
        `Paystack rejects the reserved TLD "${reserved}". It answers `
        + '"Invalid Email Address Passed" with no field name, which reads '
        + 'like a bad key. Use a real domain — production synthesises '
        + '<userId>@customers.besonc.app.',
      ],
    });
  }
}

export class HttpPaystackTransport implements PaystackTransport {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = 'https://api.paystack.co',
    private readonly timeoutMs = 15_000,
  ) {
    if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is required');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
      const json = (await res.json()) as { status: boolean; message: string; data: T };
      if (!res.ok) {
        throw new UpstreamError('paystack', `${res.status}: ${json?.message ?? 'request failed'}`);
      }
      return json;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError('paystack', (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  post<T>(path: string, body: unknown) { return this.call<T>('POST', path, body); }
  get<T>(path: string) { return this.call<T>('GET', path); }
}

export class PaystackClient {
  constructor(private readonly transport: PaystackTransport) {}

  /** Mobile money charge. Async — the customer approves on their handset. */
  async chargeMobileMoney(input: {
    orderId: string;
    attempt: number;
    amount: Pesewas;
    email: string;
    phone: string;
    provider?: MomoProvider;
  }): Promise<ChargeResult> {
    if (input.amount <= 0n) {
      throw new ValidationError({ amount: ['must be greater than zero'] });
    }
    assertPaystackEmail(input.email);
    const reference = chargeReference(input.orderId, input.attempt);
    const provider = input.provider ?? momoProviderFor(input.phone);

    const res = await this.transport.post<{
      reference: string; status: string; id?: number; display_text?: string;
    }>('/charge', {
      // Paystack takes the minor unit — pesewas for GHS. Our native unit.
      amount: input.amount.toString(),
      email: input.email,
      currency: 'GHS',
      reference,
      mobile_money: { phone: input.phone, provider },
    });

    return {
      reference,
      status: normaliseChargeStatus(res.data.status),
      ...(res.data.id ? { gatewayId: String(res.data.id) } : {}),
      ...(res.data.display_text ? { displayText: res.data.display_text } : {}),
    };
  }

  /** Card / hosted checkout. Returns a URL the app opens in a webview. */
  async initializeCard(input: {
    orderId: string; attempt: number; amount: Pesewas; email: string; callbackUrl?: string;
  }): Promise<{ reference: string; authorizationUrl: string }> {
    const reference = chargeReference(input.orderId, input.attempt);
    const res = await this.transport.post<{ authorization_url: string; reference: string }>(
      '/transaction/initialize',
      {
        amount: input.amount.toString(),
        email: input.email,
        currency: 'GHS',
        reference,
        channels: ['card'],
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      },
    );
    return { reference, authorizationUrl: res.data.authorization_url };
  }

  /** Source of truth when a webhook is missed. */
  async verify(reference: string): Promise<ChargeResult & { amount: Pesewas; feePesewas: Pesewas }> {
    const res = await this.transport.get<{
      reference: string; status: string; id: number; amount: number; fees: number | null;
    }>(`/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      reference: res.data.reference,
      status: normaliseChargeStatus(res.data.status),
      gatewayId: String(res.data.id),
      amount: BigInt(res.data.amount),
      feePesewas: BigInt(res.data.fees ?? 0),
    };
  }

  async refund(input: { chargeReference: string; amount?: Pesewas }): Promise<RefundResult> {
    const res = await this.transport.post<{ status: string }>('/refund', {
      transaction: input.chargeReference,
      ...(input.amount ? { amount: input.amount.toString() } : {}),
    });
    return { reference: input.chargeReference, status: normaliseRefundStatus(res.data.status) };
  }

  /** Recipients are created once per vendor/rider and cached by us. */
  async createMomoRecipient(input: {
    name: string; phone: string; provider?: MomoProvider;
  }): Promise<{ recipientCode: string }> {
    const provider = input.provider ?? momoProviderFor(input.phone);
    const res = await this.transport.post<{ recipient_code: string }>('/transferrecipient', {
      type: 'mobile_money',
      name: input.name,
      account_number: input.phone,
      bank_code: provider,
      currency: 'GHS',
    });
    return { recipientCode: res.data.recipient_code };
  }

  async transfer(input: {
    payoutId: string; recipientCode: string; amount: Pesewas; reason: string;
  }): Promise<TransferResult> {
    const reference = `payout_${input.payoutId.replace(/-/g, '')}`;
    const res = await this.transport.post<{ transfer_code: string; status: string }>('/transfer', {
      source: 'balance',
      amount: input.amount.toString(),
      recipient: input.recipientCode,
      reason: input.reason,
      currency: 'GHS',
      reference,
    });
    return {
      reference,
      transferCode: res.data.transfer_code,
      status: normaliseTransferStatus(res.data.status),
    };
  }
}

function normaliseChargeStatus(s: string): ChargeStatus {
  switch (s) {
    case 'success': return 'success';
    case 'failed': case 'reversed': return 'failed';
    case 'abandoned': return 'abandoned';
    case 'send_otp': case 'open_url': case 'send_pin': return 'send_otp';
    default: return 'pending';
  }
}

function normaliseRefundStatus(s: string): RefundResult['status'] {
  switch (s) {
    case 'processed': case 'success': return 'processed';
    case 'failed': return 'failed';
    case 'processing': return 'processing';
    default: return 'pending';
  }
}

function normaliseTransferStatus(s: string): TransferResult['status'] {
  switch (s) {
    case 'success': return 'success';
    case 'failed': return 'failed';
    case 'reversed': return 'reversed';
    case 'otp': return 'otp';
    default: return 'pending';
  }
}
