/**
 * Notification templates. PDF §9.
 *
 * Every state transition produces exactly one notification per recipient.
 * Templates live here rather than being scattered through services, so the
 * copy can be reviewed in one place and localised later.
 *
 * Ghana specifics: SMS is charged per 160-character segment, so anything
 * going out over SMS is length-checked in tests. Emoji are avoided in SMS
 * because they force UCS-2 encoding and halve the segment size to 70 chars.
 */

export type Channel = 'push' | 'sms' | 'in_app';
export type Recipient = 'customer' | 'vendor' | 'rider' | 'parcel_recipient';

export interface NotificationSpec {
  recipient: Recipient;
  channels: Channel[];
  title: string;
  body: string;
  /** Loud, persistent alert until acknowledged (PDF §9: new vendor orders). */
  critical?: boolean;
  /** Deep link the app opens when tapped. */
  deepLink?: string;
}

export interface TemplateContext {
  humanRef: string;
  vendorName?: string;
  riderName?: string;
  customerName?: string;
  etaMinutes?: number;
  amountCedis?: string;
  trackingUrl?: string;
  reason?: string;
}

type TemplateFn = (ctx: TemplateContext) => NotificationSpec[];

/**
 * event type → notifications to send.
 * Returning an array because one event often notifies several parties.
 */
export const TEMPLATES: Record<string, TemplateFn> = {
  'order.placed': (c) => [
    {
      recipient: 'vendor',
      channels: ['push', 'in_app'],
      critical: true, // PDF §9: loud until acknowledged
      title: 'New order!',
      body: `Order ${c.humanRef} is waiting. Accept within 3 minutes.`,
      deepLink: `besonc://vendor/orders/${c.humanRef}`,
    },
    {
      recipient: 'customer',
      channels: ['push'],
      title: 'Order placed',
      body: `We've sent order ${c.humanRef} to ${c.vendorName ?? 'the vendor'}.`,
      deepLink: `besonc://orders/${c.humanRef}`,
    },
  ],

  'order.vendor_accepted': (c) => [{
    recipient: 'customer',
    channels: ['push'],
    title: 'Order accepted',
    body: `${c.vendorName ?? 'The vendor'} accepted order ${c.humanRef}.`,
    deepLink: `besonc://orders/${c.humanRef}`,
  }],

  'order.vendor_rejected': (c) => [{
    recipient: 'customer',
    channels: ['push', 'sms'],
    title: 'Order could not be accepted',
    body: `Order ${c.humanRef} was declined${c.reason ? `: ${c.reason}` : ''}. You have been refunded in full.`,
  }],

  'order.preparing': (c) => [{
    recipient: 'customer',
    channels: ['push'],
    title: 'Being prepared',
    body: `Your order ${c.humanRef} is being prepared.`,
  }],

  'order.ready_for_pickup': (c) => [{
    recipient: 'rider',
    channels: ['push'],
    critical: true,
    title: 'Order ready',
    body: `Order ${c.humanRef} is ready at ${c.vendorName ?? 'the vendor'}.`,
  }],

  'order.rider_assigned': (c) => [
    {
      recipient: 'customer',
      channels: ['push'],
      title: 'Rider assigned',
      body: `${c.riderName ?? 'Your rider'} will deliver order ${c.humanRef}.`,
    },
    {
      recipient: 'vendor',
      channels: ['push', 'in_app'],
      title: 'Rider on the way',
      body: `${c.riderName ?? 'A rider'} will collect order ${c.humanRef}.`,
    },
  ],

  'order.rider_at_vendor': (c) => [{
    recipient: 'vendor',
    channels: ['push', 'in_app'],
    critical: true,
    title: 'Rider has arrived',
    body: `Hand over order ${c.humanRef}.`,
  }],

  'order.picked_up': (c) => [{
    recipient: 'customer',
    channels: ['push'],
    title: 'On the way',
    body: c.etaMinutes
      ? `Your order is on the way — about ${c.etaMinutes} minutes.`
      : 'Your order is on the way.',
    deepLink: `besonc://orders/${c.humanRef}/track`,
  }],

  'order.arrived': (c) => [{
    recipient: 'customer',
    channels: ['push'],
    critical: true,
    title: 'Your rider is here',
    body: `${c.riderName ?? 'Your rider'} has arrived with order ${c.humanRef}.`,
  }],

  'order.delivered': (c) => [{
    recipient: 'customer',
    channels: ['push'],
    title: 'Delivered',
    body: `Order ${c.humanRef} has been delivered. Enjoy!`,
  }],

  'order.cancelled': (c) => [{
    recipient: 'customer',
    channels: ['push', 'sms'],
    title: 'Order cancelled',
    body: `Order ${c.humanRef} was cancelled${c.reason ? `: ${c.reason}` : ''}.`,
  }],

  // PDF §3: the parcel recipient may not have the app at all
  'messaging.recipient_sms': (c) => [{
    recipient: 'parcel_recipient',
    channels: ['sms'],
    title: 'Parcel on the way',
    body: `A parcel is on its way to you. Track it here: ${c.trackingUrl ?? 'besonc.app'}`,
  }],

  'payment.cod.remittance_due': (c) => [{
    recipient: 'rider',
    channels: ['push', 'sms'],
    critical: true,
    title: 'Cash remittance due',
    body: `Please remit GHS ${c.amountCedis ?? '0.00'} today to keep taking orders.`,
  }],

  'dispatch.offer.broadcast': (c) => [{
    recipient: 'rider',
    channels: ['push'],
    critical: true,
    title: 'New delivery available',
    body: `Pickup from ${c.vendorName ?? 'a vendor'}. Earn GHS ${c.amountCedis ?? '0.00'}.`,
  }],
};

export function render(eventType: string, ctx: TemplateContext): NotificationSpec[] {
  const fn = TEMPLATES[eventType];
  return fn ? fn(ctx) : [];
}

/** SMS segment count. GSM-7 is 160 chars; 153 per segment once concatenated. */
export function smsSegments(body: string): number {
  // Any non-GSM-7 character forces UCS-2: 70 chars, 67 when concatenated.
  const gsm7 = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r]*$/;
  const isGsm = gsm7.test(body);
  const single = isGsm ? 160 : 70;
  const multi = isGsm ? 153 : 67;
  if (body.length <= single) return 1;
  return Math.ceil(body.length / multi);
}
