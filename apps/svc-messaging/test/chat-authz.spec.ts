/**
 * Chat authorisation — who may read whose conversation.
 *
 * This file exists because of a real vulnerability, found by exploit against
 * a running service and fixed in the same session:
 *
 *   `canChat()` validated the party TYPE ("a customer may talk to a rider")
 *   and the 30-minute window — but never the party IDENTITY. Any signed-in
 *   customer could read ANY order's transcript by guessing an order id.
 *
 * Delivery chats are exactly where people put gate codes, flat numbers and
 * "leave it with the guard, I'm out until six". That is a home-access leak,
 * not a privacy nit.
 *
 * Every case below is written from the attacker's side first.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createService } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  MessagingHttpModule, InMemoryChatStore, InMemoryParticipants,
} from '../src/http.ts';
import {
  NotificationDispatcher, InMemoryPushProvider, InMemoryDedupeStore,
} from '../src/dispatcher.ts';
import { InMemorySmsProvider } from '../../svc-identity/src/sms/provider.ts';

const PORT = 4877;
const BASE = `http://127.0.0.1:${PORT}`;

const ORDER = 'ord-1';
const CUSTOMER = 'cust-1';
const RIDER = 'rider-1';
const STORE = 'store-1';

const STRANGER_CUSTOMER = 'cust-999';
const STRANGER_RIDER = 'rider-999';
const STRANGER_STORE = 'store-999';

/** Tokens are minted by the fake verifier, so no crypto is needed here. */
function token(role: string, sub: string, vendorId?: string) {
  return JSON.stringify({ role, sub, ...(vendorId ? { vendorId } : {}) });
}

let svc: Awaited<ReturnType<typeof createService>>;
let participants: InMemoryParticipants;

before(async () => {
  participants = new InMemoryParticipants();
  participants.orders.set(ORDER, {
    customerId: CUSTOMER, riderId: RIDER, vendorId: STORE,
  });

  svc = await createService({
    name: 'svc-messaging-authz', port: PORT, host: '127.0.0.1',
    module: MessagingHttpModule.forRoot({
      dispatcher: new NotificationDispatcher(
        new InMemoryPushProvider(), new InMemorySmsProvider(),
        new InMemoryDedupeStore(),
      ),
      chatStore: new InMemoryChatStore(),
      participants,
      verifyToken: (t: string) => JSON.parse(t),
    }),
  });
});

after(async () => { await svc?.stop?.(); });

const read = (orderId: string, tok: string, pair?: string) =>
  fetch(`${BASE}/messaging/chat/${orderId}${pair ? `?pair=${pair}` : ''}`, {
    headers: { authorization: `Bearer ${tok}` },
  });

const send = (orderId: string, tok: string, body = 'hello') =>
  fetch(`${BASE}/messaging/chat/${orderId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });

/* ------------------------------------------------------------------ */

describe('participants can use their own chat', () => {
  test('the order customer can send and read', async () => {
    const t = token('customer', CUSTOMER);
    assert.equal((await send(ORDER, t, 'Gate code 4417')).status, 201);

    const res = await read(ORDER, t);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.messages.some((m: any) => m.body === 'Gate code 4417'));
  });

  test('the ASSIGNED rider can read it', async () => {
    const res = await read(ORDER, token('rider', RIDER));
    assert.equal(res.status, 200);
  });

  test('the vendor reaches their own thread, not the rider one', async () => {
    // A vendor token carries the STORE id.
    const res = await read(ORDER, token('vendor_owner', 'user-x', STORE));
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).pair, 'customer_vendor');
  });

  test('a customer may choose either of their two threads', async () => {
    const t = token('customer', CUSTOMER);
    assert.equal((await read(ORDER, t)).status, 200);
    const vendorThread = await read(ORDER, t, 'customer_vendor');
    assert.equal((await vendorThread.json() as any).pair, 'customer_vendor');
  });
});

/* ------------------------------------------------------------------ */

describe('THE VULNERABILITY: strangers are refused', () => {
  test('another customer CANNOT read this order', async () => {
    // The original exploit, verbatim.
    const res = await read(ORDER, token('customer', STRANGER_CUSTOMER));
    assert.equal(res.status, 404, 'any signed-in customer could read this');

    const body = await res.text();
    assert.ok(!body.includes('4417'), 'the gate code leaked');
  });

  test('another customer CANNOT post into it', async () => {
    // Worse than reading: impersonating the customer to the rider.
    assert.equal((await send(ORDER, token('customer', STRANGER_CUSTOMER))).status, 404);
  });

  test('an UNASSIGNED rider cannot read it', async () => {
    // Every online rider must not be able to read every live delivery.
    assert.equal((await read(ORDER, token('rider', STRANGER_RIDER))).status, 404);
  });

  test('a different vendor cannot read it', async () => {
    const res = await read(ORDER, token('vendor_owner', 'user-y', STRANGER_STORE));
    assert.equal(res.status, 404);
  });

  test('an admin token does not get a free pass', async () => {
    // Support reading live customer conversations is a separate, audited
    // capability. The chat API must not quietly grant it.
    assert.equal((await read(ORDER, token('admin', 'admin-1'))).status, 404);
  });

  test('a rider cannot claim the customer thread by asking for it', async () => {
    // The pair must come from the caller's ROLE, never from their query.
    const res = await read(ORDER, token('rider', RIDER), 'customer_vendor');
    assert.equal((await res.json() as any).pair, 'customer_rider');
  });

  test('an unknown order is 404 — the same answer a stranger gets', async () => {
    // 404 not 403 everywhere: "this exists but is not yours" confirms the id
    // is real, which is most of what an enumerator wants.
    const missing = await read('ord-does-not-exist', token('customer', CUSTOMER));
    const forbidden = await read(ORDER, token('customer', STRANGER_CUSTOMER));
    assert.equal(missing.status, 404);
    assert.equal(forbidden.status, 404);
    assert.equal(
      (await missing.json() as any).title,
      (await forbidden.json() as any).title,
      'the two answers must be indistinguishable',
    );
  });

  test('no token at all is refused', async () => {
    const res = await fetch(`${BASE}/messaging/chat/${ORDER}`);
    assert.equal(res.status, 401);
  });

  test('a rider REMOVED from the order loses access', async () => {
    // Reassignment must revoke, not merely stop granting.
    participants.orders.set(ORDER, {
      customerId: CUSTOMER, riderId: 'rider-replacement', vendorId: STORE,
    });
    assert.equal((await read(ORDER, token('rider', RIDER))).status, 404);

    participants.orders.set(ORDER, {
      customerId: CUSTOMER, riderId: RIDER, vendorId: STORE,
    });
  });

  test('an order with NO rider yet refuses every rider', async () => {
    participants.orders.set('ord-2', {
      customerId: CUSTOMER, riderId: null, vendorId: STORE,
    });
    assert.equal((await read('ord-2', token('rider', RIDER))).status, 404);
    // …but the customer can still open their own thread.
    assert.equal((await read('ord-2', token('customer', CUSTOMER))).status, 200);
  });
});
