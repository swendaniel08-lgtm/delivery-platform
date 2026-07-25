/** messaging.spec — templates, idempotent delivery, fallback, chat, calling. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { render, smsSegments, TEMPLATES } from '../src/templates.ts';
import {
  NotificationDispatcher, InMemoryPushProvider, InMemoryDedupeStore,
  canChat, validateMessage, requestCallNumber, ChatValidationError,
  CHAT_GRACE_MINUTES, type DeliveryTarget, type ChatWindow,
} from '../src/dispatcher.ts';
import { InMemorySmsProvider } from '../../svc-identity/src/sms/provider.ts';
import { UpstreamError } from '../../../libs/platform/src/errors.ts';

const target = (over: Partial<DeliveryTarget> = {}): DeliveryTarget => ({
  userId: 'u1', pushTokens: ['tok-1'], phone: '+233551234987', ...over,
});

const ctx = { humanRef: '#1234', vendorName: "Auntie Adwoa's", riderName: 'Kwame' };

function harness(opts: { pushFails?: boolean; smsFails?: boolean } = {}) {
  const push = new InMemoryPushProvider(opts.pushFails ? new Error('FCM unavailable') : undefined);
  const sms = new InMemorySmsProvider(opts.smsFails ? new UpstreamError('hubtel', 'down') : undefined);
  const dedupe = new InMemoryDedupeStore();
  const d = new NotificationDispatcher(push, sms, dedupe);
  return { d, push, sms, dedupe };
}

const resolveAll = async () => target();

describe('templates', () => {
  test('a new order alerts the vendor loudly and tells the customer', () => {
    const specs = render('order.placed', ctx);
    assert.equal(specs.length, 2);
    const vendor = specs.find((s) => s.recipient === 'vendor')!;
    assert.equal(vendor.critical, true, 'PDF §9: loud until acknowledged');
    assert.ok(vendor.deepLink?.startsWith('besonc://vendor/'));
  });

  test('arrival is critical — the customer must notice', () => {
    assert.equal(render('order.arrived', ctx)[0]!.critical, true);
  });

  test('rejections reach the customer by SMS as well as push', () => {
    const s = render('order.vendor_rejected', { ...ctx, reason: 'out of stock' })[0]!;
    assert.ok(s.channels.includes('sms'));
    assert.match(s.body, /refunded in full/);
  });

  test('the parcel recipient gets an SMS tracking link — they have no app', () => {
    const s = render('messaging.recipient_sms', { ...ctx, trackingUrl: 'https://bsnc.app/t/abc' })[0]!;
    assert.deepEqual(s.channels, ['sms']);
    assert.match(s.body, /bsnc\.app/);
  });

  test('unknown events render nothing rather than throwing', () => {
    assert.deepEqual(render('order.something_new', ctx), []);
  });

  test('every template renders without an error and produces a body', () => {
    for (const type of Object.keys(TEMPLATES)) {
      const specs = render(type, { ...ctx, amountCedis: '85.00', trackingUrl: 'x', etaMinutes: 8 });
      assert.ok(specs.length > 0, `${type} produced nothing`);
      for (const s of specs) {
        assert.ok(s.body.length > 0, `${type} has an empty body`);
        assert.ok(s.channels.length > 0, `${type} has no channel`);
      }
    }
  });
});

describe('SMS cost control', () => {
  test('segment maths matches GSM-7 and UCS-2 rules', () => {
    assert.equal(smsSegments('short'), 1);
    assert.equal(smsSegments('a'.repeat(160)), 1);
    assert.equal(smsSegments('a'.repeat(161)), 2);
    // an emoji forces UCS-2 and halves capacity
    assert.equal(smsSegments('🎉' + 'a'.repeat(80)), 2);
  });

  test('every SMS-bound template fits in ONE segment', () => {
    for (const type of Object.keys(TEMPLATES)) {
      for (const s of render(type, {
        humanRef: '#123456', vendorName: 'Auntie Adwoa Kitchen', riderName: 'Kwame Mensah',
        amountCedis: '1234.56', trackingUrl: 'https://bsnc.app/t/abcdefgh', reason: 'out of stock',
      })) {
        if (s.channels.includes('sms')) {
          assert.equal(smsSegments(s.body), 1, `${type} SMS spans multiple segments: "${s.body}"`);
        }
      }
    }
  });
});

describe('idempotent delivery', () => {
  test('a redelivered event notifies exactly once', async () => {
    const { d, push } = harness();
    const input = { eventId: 'evt-1', eventType: 'order.arrived', context: ctx, resolve: resolveAll };

    const first = await d.handle(input);
    assert.equal(first.duplicate, false);
    assert.equal(push.sent.length, 1);

    for (let i = 0; i < 5; i++) {
      const again = await d.handle(input);
      assert.equal(again.duplicate, true);
    }
    assert.equal(push.sent.length, 1, 'must not spam the customer');
  });

  test('different events for the same order both deliver', async () => {
    const { d, push } = harness();
    await d.handle({ eventId: 'e1', eventType: 'order.picked_up', context: ctx, resolve: resolveAll });
    await d.handle({ eventId: 'e2', eventType: 'order.arrived', context: ctx, resolve: resolveAll });
    assert.equal(push.sent.length, 2);
  });
});

describe('critical fallback', () => {
  test('a failed CRITICAL push falls back to SMS', async () => {
    const { d, sms } = harness({ pushFails: true });
    const out = await d.handle({
      eventId: 'e1', eventType: 'order.arrived', context: ctx, resolve: resolveAll,
    });
    assert.equal(sms.sent.length, 1, 'critical message must still reach the customer');
    assert.equal(out.notifications[0]!.delivered, true);
  });

  test('a failed NON-critical push does NOT burn an SMS', async () => {
    const { d, sms } = harness({ pushFails: true });
    const out = await d.handle({
      eventId: 'e1', eventType: 'order.preparing', context: ctx, resolve: resolveAll,
    });
    assert.equal(sms.sent.length, 0, 'not worth the SMS cost');
    assert.equal(out.notifications[0]!.delivered, false);
  });

  test('when both channels fail the outcome is honestly reported', async () => {
    const { d } = harness({ pushFails: true, smsFails: true });
    const out = await d.handle({
      eventId: 'e1', eventType: 'order.arrived', context: ctx, resolve: resolveAll,
    });
    assert.equal(out.notifications[0]!.delivered, false);
    assert.ok(out.notifications[0]!.attempts.some((a) => a.channel === 'sms' && !a.ok));
  });

  test('a missing target is reported, not thrown', async () => {
    const { d } = harness();
    const out = await d.handle({
      eventId: 'e1', eventType: 'order.arrived', context: ctx, resolve: async () => null,
    });
    assert.equal(out.notifications[0]!.delivered, false);
  });

  test('COD remittance reminders go by push AND SMS — they carry money', async () => {
    const { d, push, sms } = harness();
    await d.handle({
      eventId: 'e1', eventType: 'payment.cod.remittance_due',
      context: { ...ctx, amountCedis: '85.00' }, resolve: resolveAll,
    });
    assert.equal(push.sent.length, 1);
    assert.equal(sms.sent.length, 1);
  });

  test('multi-device users get a push per token', async () => {
    const { d, push } = harness();
    await d.handle({
      eventId: 'e1', eventType: 'order.arrived', context: ctx,
      resolve: async () => target({ pushTokens: ['a', 'b', 'c'] }),
    });
    assert.equal(push.sent.length, 3);
  });
});

describe('chat windows (PDF §9)', () => {
  const now = new Date(Date.UTC(2026, 6, 25, 12, 0, 0));
  const later = (m: number) => new Date(now.getTime() + m * 60_000);
  const openWindow: ChatWindow = {
    orderId: 'o1', pair: 'customer_rider', openedAt: now, deliveredAt: null,
  };

  test('customer and rider may chat on an active order', () => {
    assert.equal(canChat(openWindow, 'customer', now).allowed, true);
    assert.equal(canChat(openWindow, 'rider', now).allowed, true);
  });

  test('the vendor cannot join a customer↔rider conversation', () => {
    const d = canChat(openWindow, 'vendor', now);
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /not a participant/);
  });

  test('chat stays open for 30 minutes after delivery', () => {
    const delivered = { ...openWindow, deliveredAt: now };
    assert.equal(canChat(delivered, 'customer', later(20)).allowed, true);
    assert.equal(canChat(delivered, 'customer', later(31)).allowed, false);
    assert.equal(CHAT_GRACE_MINUTES, 30);
  });

  test('a closed chat points the user at support', () => {
    const delivered = { ...openWindow, deliveredAt: now };
    assert.match(canChat(delivered, 'customer', later(45)).reason!, /support/);
  });

  test('messages are validated', () => {
    assert.deepEqual(validateMessage({ orderId: 'o', from: 'customer', body: '  hi  ' }), { body: 'hi' });
    assert.throws(() => validateMessage({ orderId: 'o', from: 'customer' }), ChatValidationError);
    assert.throws(() => validateMessage({ orderId: 'o', from: 'customer', body: 'x'.repeat(1001) }), ChatValidationError);
  });

  test('an image alone is a valid message — errand receipts', () => {
    const m = validateMessage({ orderId: 'o', from: 'rider', imageUrl: 'https://cdn/receipt.jpg' });
    assert.equal(m.imageUrl, 'https://cdn/receipt.jpg');
  });
});

describe('consented calling (issue #3 v1)', () => {
  const now = new Date(Date.UTC(2026, 6, 25, 12, 0, 0));
  const w: ChatWindow = { orderId: 'o1', pair: 'customer_rider', openedAt: now, deliveredAt: null };

  test('the number is released inside the delivery window', () => {
    const r = requestCallNumber({ window: w, requester: 'rider', counterpartyPhone: '+233551234987', now });
    assert.equal(r.allowed, true);
    assert.equal(r.phone, '+233551234987');
  });

  test('the number is NEVER exposed once the window closes', () => {
    const delivered = { ...w, deliveredAt: now };
    const r = requestCallNumber({
      window: delivered, requester: 'rider', counterpartyPhone: '+233551234987',
      now: new Date(now.getTime() + 60 * 60_000),
    });
    assert.equal(r.allowed, false);
    assert.equal(r.phone, undefined, 'a leaked number cannot be un-leaked');
  });

  test('a non-participant never receives a number', () => {
    const r = requestCallNumber({ window: w, requester: 'vendor', counterpartyPhone: '+233551234987', now });
    assert.equal(r.allowed, false);
    assert.equal(r.phone, undefined);
  });
});
