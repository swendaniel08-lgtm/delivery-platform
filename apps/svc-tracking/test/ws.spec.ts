/**
 * ws.spec — WebSocket transport against a REAL ws server over a real socket.
 * Auth on connect, authorisation per room, chat rules, flood control, reaping.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';

import {
  TrackingWebSocketServer, wsRoleOf, chatPartyOf,
  CLIENT_MSG_LIMIT, type OrderLookup, type ChatSink, type ServerMessage,
} from '../src/ws/server.ts';
import { TrackingHub, type OrderParticipants } from '../src/tracking.ts';
import {
  TokenService, InMemorySessionStore, DEFAULT_TOKEN_CONFIG,
} from '../../svc-identity/src/token/token-service.ts';
import type { ChatWindow } from '../../svc-messaging/src/dispatcher.ts';

const CUSTOMER = 'cust-1';
const OTHER_CUSTOMER = 'cust-2';
const RIDER = 'rider-1';
const VENDOR = 'vendor-1';
const ORDER = 'order-1';

let http: Server;
let wss: WebSocketServer;
let server: TrackingWebSocketServer;
let tokens: TokenService;
let hub: TrackingHub;
let persisted: any[] = [];
let port = 0;

const participants: OrderParticipants = {
  customerId: CUSTOMER, vendorOwnerId: VENDOR, riderId: RIDER, terminal: false,
};

const lookup: OrderLookup = {
  async participants(orderId) { return orderId === ORDER ? participants : null; },
  async chatWindow(orderId) {
    if (orderId !== ORDER) return null;
    const w: ChatWindow = {
      orderId, pair: 'customer_rider', openedAt: new Date(), deliveredAt: null,
    };
    return w;
  },
};

const chatSink: ChatSink = { async persist(m) { persisted.push(m); } };

before(async () => {
  tokens = new TokenService(
    { accessSecret: 'acc', refreshSecret: 'ref', ...DEFAULT_TOKEN_CONFIG },
    new InMemorySessionStore(),
  );
  hub = new TrackingHub(0);   // no throttle in tests
  server = new TrackingWebSocketServer(tokens, hub, lookup, chatSink, { heartbeatMs: 60_000 });

  http = createServer();
  wss = new WebSocketServer({ server: http });
  server.attach(wss);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as any).port;
});

after(async () => {
  server.close();
  wss.close();
  await new Promise<void>((r) => http.close(() => r()));
});

async function tokenFor(userId: string, role: any): Promise<string> {
  return (await tokens.issue({ userId, role })).accessToken;
}

/** Connect and collect messages. */
function connect(token?: string): Promise<{
  ws: WebSocket; messages: ServerMessage[];
  next(pred?: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  closed: Promise<{ code: number }>;
}> {
  const url = `ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`;
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  let closeInfo: { code: number } | null = null;
  const closed = new Promise<{ code: number }>((res) => {
    ws.on('close', (code) => { closeInfo = { code }; res({ code }); });
  });
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({
      ws, messages, closed,
      async next(pred = () => true, ms = 2000) {
        const start = Date.now();
        while (Date.now() - start < ms) {
          const hit = messages.find(pred);
          if (hit) { messages.splice(messages.indexOf(hit), 1); return hit; }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('timed out waiting for a message');
      },
    }));
    ws.on('error', () => {});
    ws.on('close', (code) => reject(new Error(`closed before open: ${code}`)));
  });
}

describe('authentication on connect', () => {
  test('a socket with no token is closed with 4401', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const code = await new Promise<number>((r) => ws.on('close', r));
    assert.equal(code, 4401);
  });

  test('an invalid token is closed, never left pending', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=not.a.token`);
    const code = await new Promise<number>((r) => ws.on('close', r));
    assert.equal(code, 4401);
  });

  test('a valid token connects', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await c.next((m) => m.type === 'pong')).type, 'pong');
    c.ws.close();
  });
});

describe('authorisation per room', () => {
  test('the customer on the order may subscribe', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    const m = await c.next((x) => x.type === 'subscribed');
    assert.equal((m as any).orderId, ORDER);
    c.ws.close();
  });

  test('a DIFFERENT customer is refused — a valid token is not enough', async () => {
    const c = await connect(await tokenFor(OTHER_CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    const m = await c.next((x) => x.type === 'error') as any;
    assert.equal(m.code, 'forbidden');
    c.ws.close();
  });

  test('an unknown order returns not_found', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: 'nope' }));
    assert.equal((await c.next((x) => x.type === 'error') as any).code, 'not_found');
    c.ws.close();
  });

  test('the vendor on the order may watch', async () => {
    const c = await connect(await tokenFor(VENDOR, 'vendor_owner'));
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    assert.equal((await c.next((x) => x.type === 'subscribed')).type, 'subscribed');
    c.ws.close();
  });

  test('a socket cannot hoard rooms', async () => {
    const s = new TrackingWebSocketServer(tokens, hub, lookup, chatSink, { maxRooms: 1 });
    const conn: any = {
      principal: { sub: CUSTOMER, role: 'customer' }, rooms: new Set(['x']),
      msgTimes: [], alive: true,
      socket: { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) },
    };
    const sent: any[] = [];
    await s.onMessage(conn, Buffer.from(JSON.stringify({ type: 'subscribe', orderId: ORDER })));
    assert.equal(sent[0].code, 'too_many_rooms');
  });
});

describe('live position fanout', () => {
  test('a subscriber receives positions; a non-subscriber does not', async () => {
    const watcher = await connect(await tokenFor(CUSTOMER, 'customer'));
    watcher.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    await watcher.next((m) => m.type === 'subscribed');

    const bystander = await connect(await tokenFor(OTHER_CUSTOMER, 'customer'));

    hub.broadcast(ORDER, {
      position: { lat: 5.556, lng: -0.182 }, etaSeconds: 300, state: 'in_transit',
    });

    const got = await watcher.next((m: any) => m.etaSeconds === 300) as any;
    assert.equal(got.orderId, ORDER);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bystander.messages.length, 0, 'positions must not leak');

    watcher.ws.close(); bystander.ws.close();
  });

  test('unsubscribing stops delivery', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    await c.next((m) => m.type === 'subscribed');
    c.ws.send(JSON.stringify({ type: 'unsubscribe', orderId: ORDER }));
    await c.next((m) => m.type === 'unsubscribed');

    hub.broadcast(ORDER, { position: { lat: 1, lng: 1 }, etaSeconds: 99, state: 'x' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.messages.filter((m: any) => m.etaSeconds === 99).length, 0);
    c.ws.close();
  });

  test('a disconnect removes the subscription — no leak', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    await c.next((m) => m.type === 'subscribed');
    assert.ok(hub.subscriberCount(ORDER) > 0);

    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub.subscriberCount(ORDER), 0, 'the hub must not retain dead sockets');
  });
});

describe('chat over the socket', () => {
  test('customer and rider exchange messages in the same room', async () => {
    persisted = [];
    const cust = await connect(await tokenFor(CUSTOMER, 'customer'));
    const rider = await connect(await tokenFor(RIDER, 'rider'));
    for (const c of [cust, rider]) {
      c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
      await c.next((m) => m.type === 'subscribed');
    }

    rider.ws.send(JSON.stringify({
      type: 'chat', orderId: ORDER, body: "I'm at the MTN mast, which direction?",
    }));

    const heard = await cust.next((m) => m.type === 'chat') as any;
    assert.equal(heard.from, 'rider');
    assert.match(heard.body, /MTN mast/);
    assert.equal(persisted.length, 1, 'messages must be stored for disputes');
    assert.equal(persisted[0].fromUserId, RIDER);

    cust.ws.close(); rider.ws.close();
  });

  test('an empty message is rejected', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'chat', orderId: ORDER, body: '   ' }));
    assert.equal((await c.next((m) => m.type === 'error') as any).code, 'invalid_message');
    c.ws.close();
  });

  test('an image-only message is valid — errand receipts', async () => {
    persisted = [];
    const c = await connect(await tokenFor(RIDER, 'rider'));
    // must be in the room to receive the broadcast echo of your own message
    c.ws.send(JSON.stringify({ type: 'subscribe', orderId: ORDER }));
    await c.next((m) => m.type === 'subscribed');
    c.ws.send(JSON.stringify({
      type: 'chat', orderId: ORDER, imageUrl: 'https://cdn/receipt.jpg',
    }));
    await c.next((m) => m.type === 'chat');
    assert.equal(persisted[0].imageUrl, 'https://cdn/receipt.jpg');
    c.ws.close();
  });

  test('an admin observes but cannot post as a party', async () => {
    const c = await connect(await tokenFor('admin-1', 'admin'));
    c.ws.send(JSON.stringify({ type: 'chat', orderId: ORDER, body: 'hello' }));
    assert.equal((await c.next((m) => m.type === 'error') as any).code, 'forbidden');
    c.ws.close();
  });
});

describe('robustness', () => {
  test('malformed JSON does not kill the connection', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send('this is not json');
    assert.equal((await c.next((m) => m.type === 'error') as any).code, 'bad_json');
    c.ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await c.next((m) => m.type === 'pong')).type, 'pong');
    c.ws.close();
  });

  test('an unknown message type is reported, not ignored', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    c.ws.send(JSON.stringify({ type: 'launch_missiles' }));
    assert.equal((await c.next((m) => m.type === 'error') as any).code, 'unknown_type');
    c.ws.close();
  });

  test('a flooding client is throttled, not allowed to exhaust the process', async () => {
    const c = await connect(await tokenFor(CUSTOMER, 'customer'));
    for (let i = 0; i < CLIENT_MSG_LIMIT + 10; i++) {
      c.ws.send(JSON.stringify({ type: 'ping' }));
    }
    const err = await c.next((m: any) => m.type === 'error' && m.code === 'rate_limited') as any;
    assert.equal(err.code, 'rate_limited');
    c.ws.close();
  });
});

describe('role mapping', () => {
  test('websocket roles collapse correctly', () => {
    assert.equal(wsRoleOf({ role: 'vendor_staff' } as any), 'vendor');
    assert.equal(wsRoleOf({ role: 'admin' } as any), 'admin');
    assert.equal(wsRoleOf({ role: 'rider' } as any), 'rider');
  });

  test('chat parties map from token roles', () => {
    assert.equal(chatPartyOf({ role: 'rider' } as any), 'rider');
    assert.equal(chatPartyOf({ role: 'vendor_staff' } as any), 'vendor');
    assert.equal(chatPartyOf({ role: 'admin' } as any), null);
  });
});
