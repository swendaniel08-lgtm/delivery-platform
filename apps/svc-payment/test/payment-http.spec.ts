/**
 * payment-http.spec — wallets, payouts, settlement and webhooks over HTTP.
 *
 * Two invariants are asserted repeatedly because they are the ones that cost
 * real money if they ever slip:
 *   • total debits always equal total credits
 *   • a rider can never withdraw cash they are still holding for us
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createService, type RunningService } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  PaymentHttpModule, InMemoryObligationSource, type Claims,
} from '../src/http.ts';
import { InMemoryLedgerRepository } from '../src/memory-ledger-repository.ts';
import { LedgerService } from '../src/ledger.ts';
import {
  PaystackWebhookProcessor, InMemoryWebhookStore, type WebhookHandlers,
} from '../src/paystack/webhook.ts';

const SECRET = 'sk_test_besonc';

let svc: RunningService;
let BASE = '';
let repo: InMemoryLedgerRepository;
let ledger: LedgerService;
let obligations: InMemoryObligationSource;
let webhookCalls: string[];

const token = (sub: string, role: string) => `${sub}:${role}`;
const verifyToken = (t: string): Claims => {
  const [sub, role] = t.split(':');
  if (!sub || !role) throw new Error('bad token');
  return { sub, role };
};
const as = (sub: string, role: string) => ({
  authorization: `Bearer ${token(sub, role)}`, 'content-type': 'application/json',
});
const asService = () => as('order-svc', 'service');

/** The canonical order: 81.50 total → 59.50 vendor / 8.00 rider / 14.00 platform. */
const CANONICAL = {
  totalPesewas: '8150',
  vendorPesewas: '5950',
  riderPesewas: '800',
  platformPesewas: '1400',
};

before(async () => {
  repo = new InMemoryLedgerRepository();
  ledger = new LedgerService(repo);
  obligations = new InMemoryObligationSource();
  webhookCalls = [];

  const handlers: WebhookHandlers = {
    async onChargeSuccess(i) { webhookCalls.push(`charge:${i.reference}:${i.amount}`); },
    async onRefundStateChange(i) { webhookCalls.push(`refund:${i.reference}:${i.status}`); },
    async onTransferSettled(i) { webhookCalls.push(`transfer:${i.reference}:${i.status}`); },
    async onDispute(i) { webhookCalls.push(`dispute:${i.reference}`); },
  };
  const processor = new PaystackWebhookProcessor(
    SECRET, new InMemoryWebhookStore(), handlers,
  );

  svc = await createService({
    name: 'svc-payment', port: 4535, host: '127.0.0.1',
    // The signature is over the literal bytes Paystack sent.
    rawBodyRoutes: ['/payments/webhooks'],
    module: PaymentHttpModule.forRoot({ ledger, obligations, processor, verifyToken }),
  });
  BASE = svc.url;
});
after(async () => { await svc?.stop(); });

beforeEach(() => {
  obligations.cod.clear();
  obligations.held.clear();
  webhookCalls.length = 0;
});

const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b),
  });
const get = (p: string, h: Record<string, string> = {}) => fetch(`${BASE}${p}`, { headers: h });

/** Assert the fundamental accounting identity across the whole ledger. */
function assertBalanced(context: string) {
  const { debits, credits } = repo.totals();
  assert.equal(debits, credits, `ledger unbalanced after ${context}`);
}

/* ------------------------------------------------------------------ */

describe('settlement', () => {
  test('the canonical GHS 81.50 order settles into three wallets', async () => {
    await post('/payments/internal/captures',
      { orderId: 'o-set-1', totalPesewas: '8150' }, asService());

    const r = await post('/payments/internal/settlements', {
      orderId: 'o-set-1', vendorId: 'v1', riderId: 'r1', ...CANONICAL,
    }, asService());
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.idempotentReplay, false);
    assert.equal(repo.balanceOf({ type: 'VENDOR_WALLET', ownerId: 'v1' }), 5950n);
    assert.equal(repo.balanceOf({ type: 'RIDER_WALLET', ownerId: 'r1' }), 800n);
    assert.equal(repo.balanceOf({ type: 'PLATFORM_REVENUE' }), 1400n);
    assertBalanced('canonical settlement');
  });

  test('a split that does not sum to the total is refused', async () => {
    const r = await post('/payments/internal/settlements', {
      orderId: 'o-set-2', vendorId: 'v1', riderId: 'r1',
      totalPesewas: '8150',
      vendorPesewas: '4250', riderPesewas: '800', platformPesewas: '1050', // the PDF's broken example
    }, asService());

    // 409, not 422: the request is well-formed, but it conflicts with the
    // accounting identity. The established contract is ConflictError
    // (see ledger-service.spec) and the HTTP layer must not soften it.
    assert.equal(r.status, 409,
      'a pricing rounding bug must surface here, not as money appearing from nowhere');
    const b = await r.json() as any;
    assert.match(b.detail ?? b.title, /does not equal total/);
    assertBalanced('rejected split');
  });

  test('replaying a settlement is idempotent, not a double payout', async () => {
    await post('/payments/internal/captures',
      { orderId: 'o-set-3', totalPesewas: '8150' }, asService());
    await post('/payments/internal/settlements',
      { orderId: 'o-set-3', vendorId: 'v3', riderId: 'r3', ...CANONICAL }, asService());

    const again = await post('/payments/internal/settlements',
      { orderId: 'o-set-3', vendorId: 'v3', riderId: 'r3', ...CANONICAL }, asService());
    const b = await again.json() as any;

    assert.equal(b.idempotentReplay, true, 'a retried message must not pay twice');
    assert.equal(repo.balanceOf({ type: 'VENDOR_WALLET', ownerId: 'v3' }), 5950n);
    assertBalanced('replayed settlement');
  });

  test('a COD settlement draws on cash holding, not the Paystack hold', async () => {
    await post('/payments/internal/cod/obligations',
      { orderId: 'o-cod-1', riderId: 'r-cod', totalPesewas: '8150' }, asService());
    // The rider is now holding our GHS 81.50 in cash.
    assert.equal(repo.balanceOf({ type: 'RIDER_COD_OBLIGATION', ownerId: 'r-cod' }), 8150n);

    await post('/payments/internal/settlements', {
      orderId: 'o-cod-1', vendorId: 'v-cod', riderId: 'r-cod', isCod: true, ...CANONICAL,
    }, asService());

    assert.equal(repo.balanceOf({ type: 'VENDOR_WALLET', ownerId: 'v-cod' }), 5950n);
    assertBalanced('cod settlement');
  });

  test('internal endpoints reject a customer token', async () => {
    const r = await post('/payments/internal/settlements',
      { orderId: 'x', vendorId: 'v', riderId: 'r', ...CANONICAL }, as('c1', 'customer'));
    assert.equal(r.status, 403);
  });

  test('internal endpoints reject an anonymous caller', async () => {
    const r = await post('/payments/internal/captures',
      { orderId: 'x', totalPesewas: '100' });
    assert.equal(r.status, 401);
  });

  test('a negative amount is refused', async () => {
    const r = await post('/payments/internal/captures',
      { orderId: 'o-neg', totalPesewas: '-500' }, asService());
    assert.equal(r.status, 422);
  });

  test('a decimal amount is refused — money is integer pesewas', async () => {
    const r = await post('/payments/internal/captures',
      { orderId: 'o-dec', totalPesewas: '81.50' }, asService());
    assert.equal(r.status, 422, 'GHS 81.50 must be sent as 8150');
  });
});

describe('wallet', () => {
  test('a rider sees withdrawable, not raw, balance', async () => {
    await post('/payments/internal/captures',
      { orderId: 'o-w1', totalPesewas: '8150' }, asService());
    await post('/payments/internal/settlements',
      { orderId: 'o-w1', vendorId: 'v-w', riderId: 'r-w', ...CANONICAL }, asService());
    obligations.cod.set('r-w', 500n);

    const b = await (await get('/payments/wallet', as('r-w', 'rider'))).json() as any;

    assert.equal(b.balancePesewas, '800');
    assert.equal(b.codObligationPesewas, '500');
    assert.equal(b.withdrawablePesewas, '300', 'wallet minus cash still owed');
    assert.equal(b.withdrawableDisplay, 'GHS 3.00');
  });

  test('a rider holding more cash than they have earned shows zero, never negative',
    async () => {
      obligations.cod.set('r-broke', 50_000n);
      const b = await (await get('/payments/wallet', as('r-broke', 'rider'))).json() as any;
      assert.equal(b.withdrawablePesewas, '0');
    });

  test('a vendor sees the 24-hour dispute hold', async () => {
    obligations.held.set('v-hold', 2000n);
    const b = await (await get('/payments/wallet', as('v-hold', 'vendor_owner'))).json() as any;
    assert.equal(b.heldPesewas, '2000');
    assert.equal(b.holdHours, 24);
  });

  test('money is formatted consistently for display', async () => {
    const b = await (await get('/payments/wallet', as('c-fmt', 'customer'))).json() as any;
    assert.equal(b.balanceDisplay, 'GHS 0.00');
  });

  test('a wallet needs a token', async () => {
    assert.equal((await get('/payments/wallet')).status, 401);
  });

  test('an admin has no wallet of their own', async () => {
    assert.equal((await get('/payments/wallet', as('a1', 'admin'))).status, 403);
  });
});

describe('payouts', () => {
  test('a rider with a clean balance can cash out', async () => {
    await post('/payments/internal/captures',
      { orderId: 'o-p1', totalPesewas: '8150' }, asService());
    await post('/payments/internal/settlements', {
      orderId: 'o-p1', vendorId: 'v-p', riderId: 'r-p',
      totalPesewas: '8150', vendorPesewas: '2150', riderPesewas: '5000', platformPesewas: '1000',
    }, asService());

    const r = await post('/payments/payouts', { amountPesewas: '5000' }, as('r-p', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.status, 'pending');
    assert.equal(b.amountDisplay, 'GHS 50.00');
    assert.equal(repo.balanceOf({ type: 'RIDER_WALLET', ownerId: 'r-p' }), 0n,
      'the wallet is debited when the payout is reserved');
    assertBalanced('rider payout');
  });

  test('THE CASH TRAP: a rider cannot cash out while holding our money', async () => {
    await post('/payments/internal/captures',
      { orderId: 'o-p2', totalPesewas: '8150' }, asService());
    await post('/payments/internal/settlements', {
      orderId: 'o-p2', vendorId: 'v-p2', riderId: 'r-trap',
      totalPesewas: '8150', vendorPesewas: '2150', riderPesewas: '5000', platformPesewas: '1000',
    }, asService());
    // They are holding GHS 300 of collected cash.
    obligations.cod.set('r-trap', 30_000n);

    const r = await post('/payments/payouts', { amountPesewas: '5000' }, as('r-trap', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 422);
    assert.match(JSON.stringify(b), /remit/i,
      'without this a rider collects cash, cashes out, and disappears');
    assert.equal(repo.balanceOf({ type: 'RIDER_WALLET', ownerId: 'r-trap' }), 5000n,
      'nothing moved');
    assertBalanced('blocked payout');
  });

  test('below the GHS 20 minimum is refused', async () => {
    const r = await post('/payments/payouts', { amountPesewas: '500' }, as('r-min', 'rider'));
    assert.equal(r.status, 422);
  });

  test('more than the balance is refused', async () => {
    const r = await post('/payments/payouts', { amountPesewas: '999999' }, as('r-poor', 'rider'));
    assert.equal(r.status, 422);
  });

  test('the quote tells the app the ceiling before the user types', async () => {
    obligations.cod.set('r-q', 1000n);
    const b = await (await get('/payments/payouts/quote', as('r-q', 'rider'))).json() as any;
    assert.equal(b.minimumPesewas, '2000');
    assert.equal(b.feePesewas, '100');
    assert.ok('maxWithdrawablePesewas' in b);
  });

  test('a vendor within the dispute hold cannot withdraw held funds', async () => {
    await post('/payments/internal/captures',
      { orderId: 'o-p3', totalPesewas: '8150' }, asService());
    await post('/payments/internal/settlements',
      { orderId: 'o-p3', vendorId: 'v-held', riderId: 'r-x', ...CANONICAL }, asService());
    obligations.held.set('v-held', 5950n);   // all of it still in the 24h window

    const r = await post('/payments/payouts', { amountPesewas: '5000' },
      as('v-held', 'vendor_owner'));
    assert.equal(r.status, 422);
  });
});

describe('COD remittance', () => {
  test('a rider remits collected cash and the obligation is discharged', async () => {
    await post('/payments/internal/cod/obligations',
      { orderId: 'o-r1', riderId: 'r-remit', totalPesewas: '8150' }, asService());
    obligations.cod.set('r-remit', 8150n);

    const r = await post('/payments/cod/remittances',
      { remittanceId: 'rem-1', amountPesewas: '8150' }, as('r-remit', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.amountDisplay, 'GHS 81.50');
    assert.equal(repo.balanceOf({ type: 'RIDER_COD_OBLIGATION', ownerId: 'r-remit' }), 0n);
    assertBalanced('remittance');
  });

  test('remitting more than is held is refused', async () => {
    obligations.cod.set('r-over', 1000n);
    const r = await post('/payments/cod/remittances',
      { remittanceId: 'rem-2', amountPesewas: '5000' }, as('r-over', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 422);
    assert.match(JSON.stringify(b), /GHS 10\.00/,
      'the message says what they actually owe');
  });

  test('a duplicate remittance id is idempotent', async () => {
    obligations.cod.set('r-dup', 5000n);
    await post('/payments/cod/remittances',
      { remittanceId: 'rem-dup', amountPesewas: '2000' }, as('r-dup', 'rider'));
    const again = await post('/payments/cod/remittances',
      { remittanceId: 'rem-dup', amountPesewas: '2000' }, as('r-dup', 'rider'));
    const b = await again.json() as any;

    assert.equal(b.idempotentReplay, true, 'a double-tap must not discharge twice');
    assertBalanced('duplicate remittance');
  });

  test('zero is refused', async () => {
    obligations.cod.set('r-zero', 1000n);
    const r = await post('/payments/cod/remittances',
      { remittanceId: 'rem-0', amountPesewas: '0' }, as('r-zero', 'rider'));
    assert.equal(r.status, 422);
  });

  test('only riders remit cash', async () => {
    const r = await post('/payments/cod/remittances',
      { remittanceId: 'rem-x', amountPesewas: '1000' }, as('c1', 'customer'));
    assert.equal(r.status, 403);
  });
});

describe('Paystack webhook', () => {
  const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');

  // Paystack dedupes on the gateway event id, so each fixture needs its own.
  // Reusing one id makes later tests silently collide with earlier ones.
  let gatewayId = 0;
  const chargeBody = (reference: string, amount = 8150) => JSON.stringify({
    event: 'charge.success',
    data: {
      id: (gatewayId += 1), reference, amount,
      fees: 150, currency: 'GHS', status: 'success',
    },
  });

  test('a correctly signed charge is processed', async () => {
    const body = chargeBody('order:o-wh-1:capture');
    const r = await fetch(`${BASE}/payments/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) },
      body,
    });
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.accepted, true);
    assert.equal(b.handled, true);
    assert.equal(webhookCalls.length, 1);
    assert.match(webhookCalls[0]!, /charge:order:o-wh-1:capture:8150/);
  });

  test('AN UNSIGNED WEBHOOK IS REJECTED — this is the payment truth boundary',
    async () => {
      const body = chargeBody('order:forged:capture', 10_000_000);
      const r = await fetch(`${BASE}/payments/webhooks/paystack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(r.status, 401);
      assert.equal(webhookCalls.length, 0, 'no handler ran for a forged event');
    });

  test('a wrong signature is rejected', async () => {
    const body = chargeBody('order:o-wh-2:capture');
    const r = await fetch(`${BASE}/payments/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': sign(body).replace(/^./, '0'),
      },
      body,
    });
    assert.equal(r.status, 401);
    assert.equal(webhookCalls.length, 0);
  });

  test('a replayed event is acknowledged but not re-handled', async () => {
    const body = chargeBody('order:o-wh-3:capture');
    const headers = {
      'content-type': 'application/json', 'x-paystack-signature': sign(body),
    };
    await fetch(`${BASE}/payments/webhooks/paystack`, { method: 'POST', headers, body });
    const second = await fetch(`${BASE}/payments/webhooks/paystack`,
      { method: 'POST', headers, body });
    const b = await second.json() as any;

    assert.equal(second.status, 201, 'a non-2xx would make Paystack retry forever');
    assert.equal(b.duplicate, true);
    assert.equal(webhookCalls.length, 1, 'the handler ran exactly once');
  });

  test('a non-GHS charge is refused by the handler but still acknowledged', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 9001, reference: 'order:o-usd:capture', amount: 100, currency: 'USD' },
    });
    const r = await fetch(`${BASE}/payments/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) },
      body,
    });
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.handled, false);
    assert.match(b.reason, /currency/);
  });

  test('the signature is verified over the LITERAL bytes, not a re-serialisation',
    async () => {
      // Paystack does not promise key order or whitespace. This body is
      // valid JSON whose re-serialisation differs from the original, so it
      // only verifies if we kept the raw bytes.
      const body = '{\n  "data" : {"amount":8150,"reference":"order:o-raw:capture",'
        + '"currency":"GHS","id":7},\n  "event"   :   "charge.success"\n}';
      assert.notEqual(body, JSON.stringify(JSON.parse(body)),
        'the test body must actually differ from its re-serialisation');

      const r = await fetch(`${BASE}/payments/webhooks/paystack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) },
        body,
      });
      const b = await r.json() as any;

      assert.equal(r.status, 201);
      assert.equal(b.handled, true, 'a real Paystack delivery would 401 without raw bytes');
      assert.match(webhookCalls[0]!, /charge:order:o-raw:capture:8150/);
    });

  test('garbage in a signed body does not crash the service', async () => {
    const body = 'not json at all';
    const r = await fetch(`${BASE}/payments/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) },
      body,
    });
    assert.equal(r.status, 201);
  });
});

describe('ledger integrity', () => {
  test('after every operation in this suite, debits still equal credits', () => {
    assertBalanced('the entire suite');
    const { debits } = repo.totals();
    assert.ok(debits > 0n, 'the suite actually moved money');
  });
});
