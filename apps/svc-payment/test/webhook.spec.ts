/**
 * webhook.spec — exit criterion for issues #6 and #13.
 *
 * Proves: forged payment confirmations are impossible, replayed webhooks
 * cannot double-credit, and failed payouts are compensated.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  PaystackWebhookProcessor, InMemoryWebhookStore, verifySignature, eventKey,
  payoutTransition, isTerminalPayout, PayoutSagaError,
  type WebhookHandlers, type PaystackEvent,
} from '../src/paystack/webhook.ts';
import {
  PaystackClient, momoProviderFor, chargeReference, type PaystackTransport,
} from '../src/paystack/client.ts';
import { LedgerService } from '../src/ledger.ts';
import { fromCedis, toCedis } from '../../../libs/money/src/money.ts';
import { UnauthorizedError, ValidationError } from '../../../libs/platform/src/errors.ts';

const SECRET = 'sk_test_besonc_secret';
const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');

function recordingHandlers() {
  const calls = { charge: [] as any[], refund: [] as any[], transfer: [] as any[], dispute: [] as any[] };
  const handlers: WebhookHandlers = {
    async onChargeSuccess(i) { calls.charge.push(i); },
    async onRefundStateChange(i) { calls.refund.push(i); },
    async onTransferSettled(i) { calls.transfer.push(i); },
    async onDispute(i) { calls.dispute.push(i); },
  };
  return { handlers, calls };
}

const chargeEvent = (ref: string, amount = 8150, id = 12345): PaystackEvent => ({
  event: 'charge.success',
  data: { id, reference: ref, status: 'success', amount, fees: 159, currency: 'GHS' },
});

describe('signature verification (closes issue #6)', () => {
  test('accepts a correctly signed body', () => {
    const body = JSON.stringify(chargeEvent('ord_1_a1'));
    assert.equal(verifySignature(body, sign(body), SECRET), true);
  });

  test('rejects a forged "I paid" event', async () => {
    const { handlers } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify(chargeEvent('ord_attacker_a1', 100_000_00));
    await assert.rejects(() => p.handle(body, 'deadbeef'), UnauthorizedError);
  });

  test('rejects a body tampered after signing', async () => {
    const { handlers, calls } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const original = JSON.stringify(chargeEvent('ord_1_a1', 100));
    const signature = sign(original);
    const tampered = JSON.stringify(chargeEvent('ord_1_a1', 10_000_000)); // inflate the amount
    await assert.rejects(() => p.handle(tampered, signature), UnauthorizedError);
    assert.equal(calls.charge.length, 0, 'handler must never run');
  });

  test('rejects a signature from a different secret', () => {
    const body = JSON.stringify(chargeEvent('ord_1_a1'));
    const wrong = createHmac('sha512', 'sk_test_other').update(body).digest('hex');
    assert.equal(verifySignature(body, wrong, SECRET), false);
  });

  test('rejects an empty signature', () => {
    assert.equal(verifySignature('{}', '', SECRET), false);
  });
});

describe('idempotency', () => {
  test('a redelivered event is handled exactly once', async () => {
    const { handlers, calls } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify(chargeEvent('ord_dup_a1'));
    const sig = sign(body);

    const first = await p.handle(body, sig);
    assert.equal(first.duplicate, false);
    assert.equal(first.handled, true);

    for (let i = 0; i < 5; i++) {
      const again = await p.handle(body, sig);
      assert.equal(again.duplicate, true);
      assert.equal(again.handled, false);
    }
    assert.equal(calls.charge.length, 1, 'must credit exactly once');
  });

  test('event key is stable and distinguishes different events', () => {
    assert.equal(eventKey(chargeEvent('a', 100, 1)), eventKey(chargeEvent('a', 100, 1)));
    assert.notEqual(eventKey(chargeEvent('a', 100, 1)), eventKey(chargeEvent('a', 100, 2)));
  });
});

describe('webhook → ledger, end to end', () => {
  test('charge.success captures exactly once even when replayed', async () => {
    // in-memory ledger repo
    const balances = new Map<string, bigint>();
    const txs = new Map<string, string>();
    let seq = 0;
    const repo = {
      async withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
        return fn({
          async findTransactionByReference(ref: string) {
            const id = txs.get(ref); return id ? { id } : null;
          },
          async ensureAccount(r: any) { return { id: `${r.type}:${r.ownerId ?? '-'}` }; },
          async insertTransaction(i: any) { const id = `t${++seq}`; txs.set(i.reference, id); return { id }; },
          async insertEntry() {},
          async applyBalanceDelta(id: string, d: bigint) {
            balances.set(id, (balances.get(id) ?? 0n) + d);
          },
          async getBalance(r: any) { return balances.get(`${r.type}:${r.ownerId ?? '-'}`) ?? 0n; },
        });
      },
    };
    const ledger = new LedgerService(repo);

    const handlers: WebhookHandlers = {
      async onChargeSuccess(i) {
        const orderId = '55555555-0000-0000-0000-00000000eeee';
        await ledger.capture(orderId, i.amount);
        if (i.feePesewas > 0n) await ledger.pspFee(orderId, i.feePesewas);
      },
      async onRefundStateChange() {},
      async onTransferSettled() {},
      async onDispute() {},
    };

    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify(chargeEvent('ord_e2e_a1', 8150));
    const sig = sign(body);

    await p.handle(body, sig);
    await p.handle(body, sig);
    await p.handle(body, sig);

    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_HOLDING' })), '81.50');
    assert.equal(toCedis(await ledger.balance({ type: 'PLATFORM_FEES_EXPENSE' })), '1.59');
  });
});

describe('event routing', () => {
  test('refund lifecycle states are routed', async () => {
    const { handlers, calls } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    for (const s of ['pending', 'processing', 'processed', 'failed']) {
      const body = JSON.stringify({ event: `refund.${s}`, data: { id: `r-${s}`, reference: 'ord_r_a1' } });
      await p.handle(body, sign(body));
    }
    assert.deepEqual(calls.refund.map((c) => c.status), ['pending', 'processing', 'processed', 'failed']);
  });

  test('disputes are routed', async () => {
    const { handlers, calls } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify({ event: 'charge.dispute.create', data: { id: 9, reference: 'ord_d_a1' } });
    await p.handle(body, sign(body));
    assert.equal(calls.dispute.length, 1);
  });

  test('unknown events are accepted but not handled', async () => {
    const { handlers } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify({ event: 'invoice.create', data: { id: 1 } });
    const out = await p.handle(body, sign(body));
    assert.equal(out.accepted, true);
    assert.equal(out.handled, false);
  });

  test('a failing handler still returns 200 — our retry queue, not theirs', async () => {
    const handlers: WebhookHandlers = {
      async onChargeSuccess() { throw new Error('ledger unavailable'); },
      async onRefundStateChange() {}, async onTransferSettled() {}, async onDispute() {},
    };
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify(chargeEvent('ord_fail_a1'));
    const out = await p.handle(body, sign(body));
    assert.equal(out.accepted, true);
    assert.equal(out.handled, false);
    assert.match(out.reason!, /ledger unavailable/);
  });

  test('a non-GHS charge is refused', async () => {
    const { handlers } = recordingHandlers();
    const p = new PaystackWebhookProcessor(SECRET, new InMemoryWebhookStore(), handlers);
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 77, reference: 'ord_ngn_a1', amount: 5000, currency: 'NGN' },
    });
    const out = await p.handle(body, sign(body));
    assert.equal(out.handled, false);
    assert.match(out.reason!, /currency/);
  });
});

describe('payout saga (closes issue #13)', () => {
  test('happy path: pending → queued → success', () => {
    assert.equal(payoutTransition('pending', 'submitted').to, 'queued');
    const t = payoutTransition('queued', 'transfer.success');
    assert.equal(t.to, 'success');
    assert.equal(t.compensate, false);
  });

  test('failed transfer compensates and alerts an admin', () => {
    const t = payoutTransition('queued', 'transfer.failed');
    assert.equal(t.to, 'failed');
    assert.equal(t.compensate, true, 'funds must return to the wallet');
    assert.equal(t.alertAdmin, true);
  });

  test('Paystack can reverse an already-successful transfer', () => {
    const t = payoutTransition('success', 'transfer.reversed');
    assert.equal(t.to, 'reversed');
    assert.equal(t.compensate, true);
  });

  test('illegal transitions are refused', () => {
    assert.throws(() => payoutTransition('success', 'submitted'), PayoutSagaError);
    assert.throws(() => payoutTransition('pending', 'transfer.success'), PayoutSagaError);
  });

  test('terminal states are inert', () => {
    assert.ok(isTerminalPayout('success'));
    assert.ok(isTerminalPayout('reversed'));
    assert.equal(isTerminalPayout('queued'), false);
  });

  test('exhausted retries land in the manual queue', () => {
    const t = payoutTransition('failed', 'retry_exhausted');
    assert.equal(t.to, 'needs_attention');
    assert.equal(t.alertAdmin, true);
  });
});

describe('Paystack client', () => {
  function fakeTransport(responses: Record<string, unknown>): PaystackTransport & { calls: any[] } {
    const calls: any[] = [];
    return {
      calls,
      async post(path, body) { calls.push({ path, body }); return { status: true, message: 'ok', data: responses[path] as any }; },
      async get(path) { calls.push({ path }); return { status: true, message: 'ok', data: responses[path] as any }; },
    };
  }

  test('maps Ghana prefixes to Paystack provider codes', () => {
    assert.equal(momoProviderFor('+233241234567'), 'mtn');
    assert.equal(momoProviderFor('+233551234567'), 'mtn');
    assert.equal(momoProviderFor('+233201234567'), 'vod');
    assert.equal(momoProviderFor('+233271234567'), 'atl');
    assert.throws(() => momoProviderFor('+233991234567'), ValidationError);
  });

  test('charge reference is deterministic per attempt — retries cannot double-charge', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.equal(chargeReference(id, 1), chargeReference(id, 1));
    assert.notEqual(chargeReference(id, 1), chargeReference(id, 2));
  });

  test('sends amount in pesewas with currency GHS', async () => {
    const t = fakeTransport({ '/charge': { reference: 'x', status: 'pay_offline', id: 1 } });
    const c = new PaystackClient(t);
    await c.chargeMobileMoney({
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', attempt: 1,
      amount: fromCedis('81.50'), email: 'k@example.com', phone: '+233551234987',
    });
    const body = t.calls[0]!.body as any;
    assert.equal(body.amount, '8150', 'must send minor units');
    assert.equal(body.currency, 'GHS');
    assert.equal(body.mobile_money.provider, 'mtn');
  });

  test('a pending charge is NOT treated as paid', async () => {
    const t = fakeTransport({ '/charge': { reference: 'x', status: 'pay_offline', id: 1 } });
    const res = await new PaystackClient(t).chargeMobileMoney({
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', attempt: 1,
      amount: fromCedis('10'), email: 'k@example.com', phone: '+233551234987',
    });
    assert.equal(res.status, 'pending');
  });

  test('zero or negative charges are rejected', async () => {
    const c = new PaystackClient(fakeTransport({}));
    await assert.rejects(() => c.chargeMobileMoney({
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', attempt: 1,
      amount: 0n, email: 'k@example.com', phone: '+233551234987',
    }), ValidationError);
  });
});
