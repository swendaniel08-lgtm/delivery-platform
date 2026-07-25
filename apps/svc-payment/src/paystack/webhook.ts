/**
 * Paystack webhook pipeline. Closes issue #6.
 *
 * The spec had the client's success callback confirming payment. That is
 * forgeable: anyone can POST "I paid" to our API. The SIGNED WEBHOOK is the
 * only source of truth; the client callback merely triggers a poll.
 *
 * Contract (MASTER_PLAN §3.3):
 *   1. verify x-paystack-signature = HMAC-SHA512(raw body, secret key)
 *   2. persist the raw event
 *   3. return 200 within 30 s — Paystack retries otherwise
 *   4. process asynchronously and idempotently, keyed on the Paystack event
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../../../libs/platform/src/errors.ts';
import type { Pesewas } from '../../../../libs/money/src/money.ts';

export type PaystackEventType =
  | 'charge.success'
  | 'refund.pending' | 'refund.processing' | 'refund.processed' | 'refund.failed'
  | 'transfer.success' | 'transfer.failed' | 'transfer.reversed'
  | 'charge.dispute.create' | 'charge.dispute.remind' | 'charge.dispute.resolve';

export interface PaystackEvent {
  event: PaystackEventType | string;
  data: {
    id?: number;
    reference?: string;
    status?: string;
    amount?: number;
    fees?: number | null;
    currency?: string;
    transfer_code?: string;
    [k: string]: unknown;
  };
}

/**
 * Constant-time HMAC-SHA512 check against the RAW body.
 * Parsing then re-serialising the JSON changes the bytes and breaks this —
 * the raw buffer must be preserved by the HTTP layer.
 */
export function verifySignature(rawBody: string | Buffer, signature: string, secretKey: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Stable identity for an event, used for deduplication. */
export function eventKey(evt: PaystackEvent): string {
  const id = evt.data.id ?? evt.data.transfer_code ?? evt.data.reference ?? 'unknown';
  return `${evt.event}:${id}`;
}

/* ------------------------------------------------------------------ */
/* Storage ports                                                       */
/* ------------------------------------------------------------------ */

export interface WebhookStore {
  /** Returns false when this event was already recorded (duplicate). */
  recordIfNew(key: string, rawBody: string): Promise<boolean>;
  markProcessed(key: string): Promise<void>;
  markFailed(key: string, error: string): Promise<void>;
}

export class InMemoryWebhookStore implements WebhookStore {
  seen = new Map<string, { raw: string; processed: boolean; error?: string }>();
  async recordIfNew(key: string, rawBody: string) {
    if (this.seen.has(key)) return false;
    this.seen.set(key, { raw: rawBody, processed: false });
    return true;
  }
  async markProcessed(key: string) {
    const e = this.seen.get(key); if (e) e.processed = true;
  }
  async markFailed(key: string, error: string) {
    const e = this.seen.get(key); if (e) e.error = error;
  }
}

/** What the payment service must do in response to each event. */
export interface WebhookHandlers {
  onChargeSuccess(input: {
    reference: string; amount: Pesewas; feePesewas: Pesewas; gatewayId: string;
  }): Promise<void>;
  onRefundStateChange(input: { reference: string; status: string }): Promise<void>;
  onTransferSettled(input: {
    reference: string; transferCode: string; status: 'success' | 'failed' | 'reversed';
  }): Promise<void>;
  onDispute(input: { reference: string; event: string }): Promise<void>;
}

export interface WebhookOutcome {
  accepted: boolean;
  duplicate: boolean;
  handled: boolean;
  reason?: string;
}

export class PaystackWebhookProcessor {
  constructor(
    private readonly secretKey: string,
    private readonly store: WebhookStore,
    private readonly handlers: WebhookHandlers,
  ) {}

  /**
   * Called by the HTTP layer. Throws UnauthorizedError on a bad signature —
   * everything else returns 200 so Paystack stops retrying.
   */
  async handle(rawBody: string, signature: string): Promise<WebhookOutcome> {
    if (!verifySignature(rawBody, signature, this.secretKey)) {
      throw new UnauthorizedError('Invalid Paystack signature');
    }

    let evt: PaystackEvent;
    try {
      evt = JSON.parse(rawBody) as PaystackEvent;
    } catch {
      return { accepted: true, duplicate: false, handled: false, reason: 'unparseable body' };
    }

    const key = eventKey(evt);
    const isNew = await this.store.recordIfNew(key, rawBody);
    if (!isNew) {
      return { accepted: true, duplicate: true, handled: false, reason: 'already processed' };
    }

    try {
      const handled = await this.dispatch(evt);
      await this.store.markProcessed(key);
      return { accepted: true, duplicate: false, handled };
    } catch (err) {
      await this.store.markFailed(key, (err as Error).message);
      // Still 200: a failed handler goes to our own retry queue, not
      // Paystack's. Their retries would just replay the same failure.
      return { accepted: true, duplicate: false, handled: false, reason: (err as Error).message };
    }
  }

  private async dispatch(evt: PaystackEvent): Promise<boolean> {
    switch (evt.event) {
      case 'charge.success': {
        if (evt.data.currency && evt.data.currency !== 'GHS') {
          throw new Error(`unexpected currency ${evt.data.currency}`);
        }
        await this.handlers.onChargeSuccess({
          reference: String(evt.data.reference),
          amount: BigInt(evt.data.amount ?? 0),
          feePesewas: BigInt(evt.data.fees ?? 0),
          gatewayId: String(evt.data.id ?? ''),
        });
        return true;
      }
      case 'refund.pending':
      case 'refund.processing':
      case 'refund.processed':
      case 'refund.failed':
        await this.handlers.onRefundStateChange({
          reference: String(evt.data.reference),
          status: evt.event.split('.')[1]!,
        });
        return true;

      case 'transfer.success':
      case 'transfer.failed':
      case 'transfer.reversed':
        await this.handlers.onTransferSettled({
          reference: String(evt.data.reference),
          transferCode: String(evt.data.transfer_code ?? ''),
          status: evt.event.split('.')[1] as 'success' | 'failed' | 'reversed',
        });
        return true;

      case 'charge.dispute.create':
      case 'charge.dispute.remind':
      case 'charge.dispute.resolve':
        await this.handlers.onDispute({
          reference: String(evt.data.reference ?? ''),
          event: evt.event,
        });
        return true;

      default:
        return false; // unknown events are accepted and ignored
    }
  }
}

/* ------------------------------------------------------------------ */
/* Payout saga — closes issue #13                                      */
/* ------------------------------------------------------------------ */

export type PayoutState =
  | 'pending' | 'queued' | 'success' | 'failed' | 'reversed' | 'needs_attention';

export interface PayoutTransition {
  from: PayoutState;
  event: 'submitted' | 'transfer.success' | 'transfer.failed' | 'transfer.reversed' | 'retry_exhausted';
  to: PayoutState;
  /** Return funds to the wallet — the ledger reversal. */
  compensate: boolean;
  /** Surface in the admin manual-resolution queue. */
  alertAdmin: boolean;
}

const PAYOUT_TRANSITIONS: PayoutTransition[] = [
  { from: 'pending', event: 'submitted',          to: 'queued',           compensate: false, alertAdmin: false },
  { from: 'queued',  event: 'transfer.success',   to: 'success',          compensate: false, alertAdmin: false },
  { from: 'queued',  event: 'transfer.failed',    to: 'failed',           compensate: true,  alertAdmin: true },
  { from: 'queued',  event: 'transfer.reversed',  to: 'reversed',         compensate: true,  alertAdmin: true },
  // Paystack can reverse a transfer that already reported success.
  { from: 'success', event: 'transfer.reversed',  to: 'reversed',         compensate: true,  alertAdmin: true },
  { from: 'failed',  event: 'retry_exhausted',    to: 'needs_attention',  compensate: false, alertAdmin: true },
];

export class PayoutSagaError extends Error {}

export function payoutTransition(from: PayoutState, event: PayoutTransition['event']): PayoutTransition {
  const t = PAYOUT_TRANSITIONS.find((x) => x.from === from && x.event === event);
  if (!t) {
    throw new PayoutSagaError(`illegal payout transition: ${from} --${event}-->`);
  }
  return t;
}

/** Terminal states never transition again — replayed webhooks are inert. */
export function isTerminalPayout(s: PayoutState): boolean {
  return s === 'success' || s === 'reversed' || s === 'needs_attention';
}
