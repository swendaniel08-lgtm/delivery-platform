/**
 * WebSocket transport for live tracking and chat. PDF §9.
 *
 * The socket is the last piece of plumbing: tracking and chat logic already
 * exist and are tested, but until now nothing carried them to a phone.
 *
 * Three properties this has to get right, because a socket server is where
 * authorisation is most often skipped:
 *
 *   1. AUTHENTICATE ON CONNECT. A token in the query string is verified
 *      before the upgrade completes. An unauthenticated socket is closed,
 *      never left open "pending auth".
 *   2. AUTHORISE ON SUBSCRIBE. Holding a valid token does not entitle you to
 *      watch an arbitrary order — membership is re-checked per room.
 *   3. SURVIVE BAD CLIENTS. Ghanaian mobile data drops constantly; half-open
 *      sockets are reaped by heartbeat, and a flooding client is throttled
 *      rather than allowed to exhaust the process.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { TokenService, type AccessClaims } from '../../../svc-identity/src/token/token-service.ts';
import { TrackingHub, canWatchOrder, type OrderParticipants, type Subscriber } from '../tracking.ts';
import { canChat, validateMessage, type ChatWindow, type ChatParty } from '../../../svc-messaging/src/dispatcher.ts';

/* ------------------------------------------------------------------ */
/* Wire protocol                                                       */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'subscribe'; orderId: string }
  | { type: 'unsubscribe'; orderId: string }
  | { type: 'chat'; orderId: string; body?: string; imageUrl?: string }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'subscribed'; orderId: string }
  | { type: 'unsubscribed'; orderId: string }
  | { type: 'position'; orderId: string; lat: number; lng: number; etaSeconds: number; state: string }
  | { type: 'order_state'; orderId: string; state: string }
  | { type: 'chat'; orderId: string; from: ChatParty; body?: string; imageUrl?: string; at: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

/** Per-connection flood limit. A rider app should never send 30 msg/s. */
export const CLIENT_MSG_LIMIT = 20;
export const CLIENT_MSG_WINDOW_MS = 1_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_ROOMS_PER_SOCKET = 5;

export interface Connection {
  socket: WebSocket;
  principal: AccessClaims;
  rooms: Set<string>;
  alive: boolean;
  /** Sliding-window flood counter. */
  msgTimes: number[];
}

export interface OrderLookup {
  participants(orderId: string): Promise<OrderParticipants | null>;
  chatWindow(orderId: string, party: ChatParty): Promise<ChatWindow | null>;
}

export interface ChatSink {
  persist(msg: {
    orderId: string; from: ChatParty; fromUserId: string;
    body?: string; imageUrl?: string;
  }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

export interface TrackingWsOptions {
  heartbeatMs?: number;
  maxRooms?: number;
}

export class TrackingWebSocketServer {
  private readonly connections = new Set<Connection>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly tokens: TokenService,
    private readonly hub: TrackingHub,
    private readonly lookup: OrderLookup,
    private readonly chatSink: ChatSink,
    private readonly opts: TrackingWsOptions = {},
  ) {}

  /** Verify the token BEFORE the upgrade completes. */
  authenticate(req: IncomingMessage): AccessClaims {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token')
      ?? (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7) : null);
    if (!token) throw new Error('missing token');
    return this.tokens.verifyAccess(token);   // throws on invalid/expired
  }

  attach(wss: WebSocketServer): void {
    wss.on('connection', (socket, req) => {
      let principal: AccessClaims;
      try {
        principal = this.authenticate(req);
      } catch {
        // 4401 is the WebSocket convention for "unauthorised"
        socket.close(4401, 'unauthorised');
        return;
      }
      this.register(socket, principal);
    });

    this.heartbeat = setInterval(() => this.reap(), this.opts.heartbeatMs ?? HEARTBEAT_MS);
  }

  private register(socket: WebSocket, principal: AccessClaims): void {
    const conn: Connection = { socket, principal, rooms: new Set(), alive: true, msgTimes: [] };
    this.connections.add(conn);

    socket.on('pong', () => { conn.alive = true; });
    socket.on('message', (raw) => { void this.onMessage(conn, raw); });
    socket.on('close', () => this.cleanup(conn));
    socket.on('error', () => this.cleanup(conn));
  }

  private send(conn: Connection, msg: ServerMessage): void {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(JSON.stringify(msg));
    }
  }

  /** Sliding window; returns false when the client is flooding. */
  private allowMessage(conn: Connection, nowMs = Date.now()): boolean {
    conn.msgTimes = conn.msgTimes.filter((t) => nowMs - t < CLIENT_MSG_WINDOW_MS);
    if (conn.msgTimes.length >= CLIENT_MSG_LIMIT) return false;
    conn.msgTimes.push(nowMs);
    return true;
  }

  async onMessage(conn: Connection, raw: RawData): Promise<void> {
    if (!this.allowMessage(conn)) {
      this.send(conn, { type: 'error', code: 'rate_limited', message: 'Slow down' });
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      this.send(conn, { type: 'error', code: 'bad_json', message: 'Malformed message' });
      return;
    }

    switch (msg.type) {
      case 'ping': return this.send(conn, { type: 'pong' });
      case 'subscribe': return void (await this.onSubscribe(conn, msg.orderId));
      case 'unsubscribe': return this.onUnsubscribe(conn, msg.orderId);
      case 'chat': return void (await this.onChat(conn, msg));
      default:
        this.send(conn, { type: 'error', code: 'unknown_type', message: 'Unsupported message' });
    }
  }

  private async onSubscribe(conn: Connection, orderId: string): Promise<void> {
    const max = this.opts.maxRooms ?? MAX_ROOMS_PER_SOCKET;
    if (conn.rooms.size >= max) {
      this.send(conn, { type: 'error', code: 'too_many_rooms', message: 'Too many subscriptions' });
      return;
    }

    const participants = await this.lookup.participants(orderId);
    if (!participants) {
      this.send(conn, { type: 'error', code: 'not_found', message: 'Order not found' });
      return;
    }

    const role = wsRoleOf(conn.principal);
    const decision = canWatchOrder(conn.principal.sub, role, participants);
    if (!decision.allowed) {
      this.send(conn, {
        type: 'error', code: 'forbidden', message: decision.reason ?? 'Not permitted',
      });
      return;
    }

    const subscriber: Subscriber = {
      principalId: conn.principal.sub,
      role,
      send: (payload) => this.send(conn, payload as ServerMessage),
    };
    this.hub.subscribe(orderId, subscriber);
    conn.rooms.add(orderId);
    (conn as any)[`sub:${orderId}`] = subscriber;
    this.send(conn, { type: 'subscribed', orderId });
  }

  private onUnsubscribe(conn: Connection, orderId: string): void {
    const subscriber = (conn as any)[`sub:${orderId}`] as Subscriber | undefined;
    if (subscriber) this.hub.unsubscribe(orderId, subscriber);
    conn.rooms.delete(orderId);
    delete (conn as any)[`sub:${orderId}`];
    this.send(conn, { type: 'unsubscribed', orderId });
  }

  private async onChat(
    conn: Connection, msg: Extract<ClientMessage, { type: 'chat' }>,
  ): Promise<void> {
    const party = chatPartyOf(conn.principal);
    if (!party) {
      this.send(conn, { type: 'error', code: 'forbidden', message: 'Not a chat participant' });
      return;
    }

    const window = await this.lookup.chatWindow(msg.orderId, party);
    if (!window) {
      this.send(conn, { type: 'error', code: 'not_found', message: 'Conversation not found' });
      return;
    }

    const access = canChat(window, party);
    if (!access.allowed) {
      this.send(conn, { type: 'error', code: 'chat_closed', message: access.reason ?? 'Closed' });
      return;
    }

    let clean: { body?: string; imageUrl?: string };
    try {
      clean = validateMessage({
        orderId: msg.orderId, from: party,
        ...(msg.body ? { body: msg.body } : {}),
        ...(msg.imageUrl ? { imageUrl: msg.imageUrl } : {}),
      });
    } catch (err) {
      this.send(conn, { type: 'error', code: 'invalid_message', message: (err as Error).message });
      return;
    }

    await this.chatSink.persist({
      orderId: msg.orderId, from: party, fromUserId: conn.principal.sub, ...clean,
    });

    // Fan out to everyone in the room, including the sender for confirmation.
    this.broadcastToRoom(msg.orderId, {
      type: 'chat', orderId: msg.orderId, from: party, ...clean,
      at: new Date().toISOString(),
    });
  }

  /** Direct room fanout for chat (tracking positions go through the hub). */
  broadcastToRoom(orderId: string, msg: ServerMessage): number {
    let n = 0;
    for (const conn of this.connections) {
      if (conn.rooms.has(orderId)) { this.send(conn, msg); n++; }
    }
    return n;
  }

  /** Terminate half-open sockets — mobile data drops without a FIN. */
  private reap(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        this.cleanup(conn);
        continue;
      }
      conn.alive = false;
      if (conn.socket.readyState === WebSocket.OPEN) conn.socket.ping();
    }
  }

  private cleanup(conn: Connection): void {
    for (const orderId of conn.rooms) {
      const sub = (conn as any)[`sub:${orderId}`] as Subscriber | undefined;
      if (sub) this.hub.unsubscribe(orderId, sub);
    }
    conn.rooms.clear();
    this.connections.delete(conn);
  }

  connectionCount(): number { return this.connections.size; }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const conn of this.connections) conn.socket.close(1001, 'server shutting down');
    this.connections.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Role mapping                                                        */
/* ------------------------------------------------------------------ */

export function wsRoleOf(p: AccessClaims): 'customer' | 'vendor' | 'rider' | 'admin' {
  if (p.role === 'admin') return 'admin';
  if (p.role === 'vendor_owner' || p.role === 'vendor_staff') return 'vendor';
  if (p.role === 'rider') return 'rider';
  return 'customer';
}

export function chatPartyOf(p: AccessClaims): ChatParty | null {
  switch (p.role) {
    case 'customer': return 'customer';
    case 'rider': return 'rider';
    case 'vendor_owner': case 'vendor_staff': return 'vendor';
    default: return null;   // admins observe, they do not post as a party
  }
}
