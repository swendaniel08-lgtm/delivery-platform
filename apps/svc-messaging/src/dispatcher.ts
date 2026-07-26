/**
 * Notification dispatcher.
 *
 * Consumes domain events and delivers them. Two properties matter:
 *
 *   1. IDEMPOTENT — the outbox relay guarantees at-least-once delivery, so
 *      the same event WILL arrive twice. A customer must not get two
 *      "your rider is here" pushes, and a rider must not be charged twice
 *      for a COD reminder SMS.
 *
 *   2. FALLBACK for critical messages — if push fails for a message that
 *      carries money or blocks the flow (COD reminders, OTP, parcel
 *      recipient), fall back to SMS. Silent failure is not acceptable there.
 */

import { render, smsSegments, type Channel, type NotificationSpec, type TemplateContext } from './templates.ts';
import type { SmsProvider } from '../../svc-identity/src/sms/provider.ts';
import { UpstreamError } from '../../../libs/platform/src/errors.ts';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  critical: boolean;
  deepLink?: string;
}

export interface PushProvider {
  readonly name: string;
  send(msg: PushMessage): Promise<{ messageId: string }>;
}

/** FCM/APNs in production. */
export class InMemoryPushProvider implements PushProvider {
  readonly name = 'in-memory-push';
  sent: PushMessage[] = [];
  constructor(private readonly failWith?: Error) {}
  async send(msg: PushMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push(msg);
    return { messageId: `push-${this.sent.length}` };
  }
}

export interface DeliveryTarget {
  userId: string;
  pushTokens: string[];
  phone: string;
}

/** Dedupe store — Redis in production. */
export interface DedupeStore {
  /** false when this key was already seen. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export class InMemoryDedupeStore implements DedupeStore {
  seen = new Set<string>();
  async claim(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export interface DeliveryAttempt {
  channel: Channel;
  ok: boolean;
  provider?: string;
  error?: string;
  /** SMS cost driver. */
  segments?: number;
  /** The provider says this token is permanently dead; it has been pruned. */
  deadToken?: boolean;
}

export interface DispatchOutcome {
  eventId: string;
  duplicate: boolean;
  notifications: Array<{
    recipient: string;
    attempts: DeliveryAttempt[];
    delivered: boolean;
  }>;
}

export interface ResolveTargets {
  (recipient: NotificationSpec['recipient']): Promise<DeliveryTarget | null>;
}

export class NotificationDispatcher {
  constructor(
    private readonly push: PushProvider,
    private readonly sms: SmsProvider,
    private readonly dedupe: DedupeStore,
    private readonly opts: {
      dedupeTtlSeconds?: number;
      /**
       * Called when the push provider tells us a token is permanently dead
       * (the app was uninstalled). This is the ONLY signal we ever get, so
       * if we do not act on it the row lives forever and we pay a round trip
       * on every order for a phone that no longer exists.
       */
      onDeadToken?: (token: string) => Promise<void> | void;
    } = {},
  ) {}

  /**
   * Handle one domain event.
   * `eventId` is the outbox event id — the idempotency key.
   */
  async handle(input: {
    eventId: string;
    eventType: string;
    context: TemplateContext;
    resolve: ResolveTargets;
  }): Promise<DispatchOutcome> {
    const fresh = await this.dedupe.claim(
      `notify:${input.eventId}`, this.opts.dedupeTtlSeconds ?? 86_400,
    );
    if (!fresh) {
      return { eventId: input.eventId, duplicate: true, notifications: [] };
    }

    const specs = render(input.eventType, input.context);
    const notifications: DispatchOutcome['notifications'] = [];

    for (const spec of specs) {
      const target = await input.resolve(spec.recipient);
      if (!target) {
        notifications.push({
          recipient: spec.recipient,
          attempts: [{ channel: 'push', ok: false, error: 'no target' }],
          delivered: false,
        });
        continue;
      }
      const attempts = await this.deliver(spec, target);
      notifications.push({
        recipient: spec.recipient,
        attempts,
        delivered: attempts.some((a) => a.ok),
      });
    }

    return { eventId: input.eventId, duplicate: false, notifications };
  }

  private async deliver(spec: NotificationSpec, target: DeliveryTarget): Promise<DeliveryAttempt[]> {
    const attempts: DeliveryAttempt[] = [];
    let pushSucceeded = false;

    if (spec.channels.includes('push') && target.pushTokens.length > 0) {
      for (const token of target.pushTokens) {
        try {
          await this.push.send({
            token, title: spec.title, body: spec.body,
            critical: !!spec.critical,
            ...(spec.deepLink ? { deepLink: spec.deepLink } : {}),
          });
          attempts.push({ channel: 'push', ok: true, provider: this.push.name });
          pushSucceeded = true;
        } catch (err) {
          const e = err as Error;
          attempts.push({
            channel: 'push', ok: false, provider: this.push.name, error: e.message,
            ...(e.name === 'PushTokenInvalidError' ? { deadToken: true } : {}),
          });
          if (e.name === 'PushTokenInvalidError' && this.opts.onDeadToken) {
            // Pruning must never take down the notification path: a failure
            // to clean up is a cost problem, a thrown error here would be a
            // delivery problem.
            try { await this.opts.onDeadToken(token); }
            catch { /* best effort */ }
          }
        }
      }
    }

    // SMS when the template asks for it, OR as a fallback when a CRITICAL
    // push failed. Non-critical messages are not worth the SMS cost.
    const smsRequested = spec.channels.includes('sms');
    const needsFallback = !!spec.critical && !pushSucceeded && !smsRequested;

    if (smsRequested || needsFallback) {
      try {
        const res = await this.sms.send({ to: target.phone, content: spec.body });
        attempts.push({
          channel: 'sms', ok: true, provider: res.provider,
          segments: smsSegments(spec.body),
        });
      } catch (err) {
        attempts.push({ channel: 'sms', ok: false, error: (err as Error).message });
      }
    }

    if (spec.channels.includes('in_app')) {
      attempts.push({ channel: 'in_app', ok: true });
    }

    if (attempts.length === 0) {
      attempts.push({ channel: 'push', ok: false, error: 'no deliverable channel' });
    }
    return attempts;
  }
}

/* ------------------------------------------------------------------ */
/* Chat — PDF §9                                                       */
/* ------------------------------------------------------------------ */

export type ChatParty = 'customer' | 'rider' | 'vendor';

export interface ChatWindow {
  orderId: string;
  /** customer↔rider opens at assignment; customer↔vendor at placement. */
  pair: 'customer_rider' | 'customer_vendor';
  openedAt: Date;
  /** Set when the order reaches a terminal state. */
  deliveredAt: Date | null;
}

/** PDF §9: chat closes 30 minutes after delivery. */
export const CHAT_GRACE_MINUTES = 30;

export interface ChatAccess {
  allowed: boolean;
  reason?: string;
}

export function canChat(
  window: ChatWindow, sender: ChatParty, now: Date = new Date(),
): ChatAccess {
  const parties = window.pair === 'customer_rider'
    ? ['customer', 'rider'] : ['customer', 'vendor'];
  if (!parties.includes(sender)) {
    return { allowed: false, reason: 'not a participant in this conversation' };
  }
  if (window.deliveredAt) {
    const minutes = (now.getTime() - window.deliveredAt.getTime()) / 60_000;
    if (minutes > CHAT_GRACE_MINUTES) {
      return { allowed: false, reason: 'this chat has closed — please contact support' };
    }
  }
  return { allowed: true };
}

export interface ChatMessage {
  orderId: string;
  from: ChatParty;
  body?: string;
  imageUrl?: string;
}

export class ChatValidationError extends Error {}

/**
 * Messages are trimmed and length-capped. Phone numbers are NOT stripped —
 * riders legitimately share directions — but the message is stored so a
 * dispute can be reconstructed.
 */
export function validateMessage(msg: ChatMessage): { body?: string; imageUrl?: string } {
  const body = msg.body?.trim();
  if (!body && !msg.imageUrl) {
    throw new ChatValidationError('message must contain text or an image');
  }
  if (body && body.length > 1000) {
    throw new ChatValidationError('message is too long (max 1000 characters)');
  }
  return {
    ...(body ? { body } : {}),
    ...(msg.imageUrl ? { imageUrl: msg.imageUrl } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Consented calling — issue #3 v1                                     */
/* ------------------------------------------------------------------ */

export interface CallAccess {
  allowed: boolean;
  /** Only populated when allowed; otherwise the number is never exposed. */
  phone?: string;
  reason?: string;
}

/**
 * Paystack has no number-masking product (issue #3), so v1 exposes the real
 * number only inside the delivery window, and only between the two people on
 * that order. Phase 2 replaces this with Infobip masking.
 */
export function requestCallNumber(input: {
  window: ChatWindow;
  requester: ChatParty;
  counterpartyPhone: string;
  now?: Date;
}): CallAccess {
  const access = canChat(input.window, input.requester, input.now ?? new Date());
  if (!access.allowed) {
    return { allowed: false, ...(access.reason ? { reason: access.reason } : {}) };
  }
  return { allowed: true, phone: input.counterpartyPhone };
}
