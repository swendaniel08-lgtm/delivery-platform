/**
 * messaging-svc HTTP surface.
 *
 * Two jobs:
 *   • turn a domain event into notifications (push, SMS, in-app)
 *   • carry the customer↔rider and customer↔vendor chats
 *
 * The notification path is idempotent on the OUTBOX EVENT ID, not on a
 * timestamp or a hash of the body. The relay guarantees at-least-once
 * delivery, so the same "your order is on the way" will arrive here twice
 * during any broker retry — and a customer who gets two SMS for one event
 * has been charged twice as much to annoy.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Query, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import { PgChatStore } from './pg-chat-store.ts';
import { PgParticipants } from './pg-participants.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import {
  NotificationDispatcher, canChat, validateMessage, ChatValidationError,
  type DeliveryTarget, type ChatWindow, type ChatParty,
} from './dispatcher.ts';
import { render, TEMPLATES, smsSegments, type TemplateContext } from './templates.ts';

export const DISPATCHER = Symbol('DISPATCHER');
export const DIRECTORY = Symbol('DIRECTORY');
export const CHAT_STORE = Symbol('CHAT_STORE');
export const PARTICIPANTS = Symbol('PARTICIPANTS');
export const VERIFY_TOKEN = Symbol('MESSAGING_VERIFY_TOKEN');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

/** Resolves "the customer on order X" to a device token and phone number. */
export interface Directory {
  targetFor(orderId: string, recipient: string): Promise<DeliveryTarget | null>;
}

export class InMemoryDirectory implements Directory {
  targets = new Map<string, DeliveryTarget>();
  async targetFor(orderId: string, recipient: string) {
    return this.targets.get(`${orderId}:${recipient}`) ?? null;
  }
}

/**
 * Who is actually on an order.
 *
 * SECURITY: this is the ownership check for chat. `canChat` only ever
 * validated the party TYPE ("a customer may talk to a rider") and the
 * 30-minute window — never the party IDENTITY. Any authenticated customer
 * could therefore read any order's transcript by guessing an order id, and
 * those transcripts contain exactly the things people put in delivery
 * instructions: gate codes, flat numbers, when the house is empty.
 *
 * Verified by exploit against a running service before this was added.
 */
export interface OrderParticipantLookup {
  /** Null when the order does not exist. */
  participants(orderId: string): Promise<{
    customerId: string;
    riderId: string | null;
    vendorId: string | null;
  } | null>;
}

/**
 * Dev/test double. Returns null for unknown orders, which the controller
 * treats as "not found" — the same answer a stranger gets for a real order
 * they are not on.
 */
export class InMemoryParticipants implements OrderParticipantLookup {
  orders = new Map<string, {
    customerId: string; riderId: string | null; vendorId: string | null;
  }>();
  async participants(orderId: string) { return this.orders.get(orderId) ?? null; }
}

export interface ChatStore {
  window(orderId: string, pair: ChatWindow['pair']): Promise<ChatWindow | null>;
  /**
   * Open the conversation if it is not open yet, and return it.
   *
   * Chat threads are created LAZILY, on first use. The alternative — opening
   * one eagerly when an order is placed — means creating two dead threads for
   * every order nobody messages about, which is most of them.
   *
   * Idempotent: two participants can tap "message" at the same instant.
   */
  ensureWindow(
    orderId: string, pair: ChatWindow['pair'], customerId: string,
  ): Promise<ChatWindow>;
  append(msg: {
    orderId: string; pair: string; from: string;
    /** The authenticated subject. Required: the transcript is evidence. */
    fromUserId?: string;
    body?: string; imageUrl?: string;
  }): Promise<{ id: string; sentAt: string }>;
  history(orderId: string, pair: string): Promise<Array<Record<string, unknown>>>;
}

export class InMemoryChatStore implements ChatStore {
  windows = new Map<string, ChatWindow>();
  messages: Array<Record<string, unknown>> = [];
  private seq = 0;

  async window(orderId: string, pair: ChatWindow['pair']) {
    return this.windows.get(`${orderId}:${pair}`) ?? null;
  }
  async ensureWindow(orderId: string, pair: ChatWindow['pair']) {
    const key = `${orderId}:${pair}`;
    const existing = this.windows.get(key);
    if (existing) return existing;
    const fresh: ChatWindow = {
      orderId, pair, openedAt: new Date(), deliveredAt: null,
    };
    this.windows.set(key, fresh);
    return fresh;
  }
  async append(msg: any) {
    this.seq += 1;
    const row = { id: String(this.seq), sentAt: new Date().toISOString(), ...msg };
    this.messages.push(row);
    return { id: row.id, sentAt: row.sentAt };
  }
  async history(orderId: string, pair: string) {
    return this.messages.filter((m) => m.orderId === orderId && m.pair === pair);
  }
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

/* ------------------------------------------------------------------ */

@Controller('messaging')
export class MessagingController {
  constructor(
    @Inject(DISPATCHER) private readonly dispatcher: NotificationDispatcher,
    @Inject(DIRECTORY) private readonly directory: Directory,
    @Inject(CHAT_STORE) private readonly chat: ChatStore,
    @Inject(PARTICIPANTS) private readonly people: OrderParticipantLookup,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  /**
   * Is this principal actually on this order?
   *
   * Returns the pair they belong to, or throws NotFound.
   *
   * 404 rather than 403 throughout: telling a stranger "this order exists but
   * is not yours" confirms the id is real, which is most of what an enumerator
   * wants. A stranger and a nonexistent order get the same answer.
   */
  private async requireParticipant(
    orderId: string, c: Claims, requestedPair?: string,
  ): Promise<'customer_rider' | 'customer_vendor'> {
    const order = await this.people.participants(orderId);
    if (!order) throw new NotFoundError('Conversation');

    switch (c.role) {
      case 'customer':
        if (order.customerId !== c.sub) throw new NotFoundError('Conversation');
        // A customer belongs to BOTH threads, so they choose; anyone else is
        // pinned to the one thread their role can be in.
        return requestedPair === 'customer_vendor'
          ? 'customer_vendor' : 'customer_rider';

      case 'rider':
        if (!order.riderId || order.riderId !== c.sub) {
          throw new NotFoundError('Conversation');
        }
        return 'customer_rider';

      case 'vendor_owner':
      case 'vendor_staff':
        // Vendor tokens carry the STORE id, not a personal id — a vendor is
        // on the order if their store is.
        if (!order.vendorId
            || (order.vendorId !== c.sub && order.vendorId !== (c as any).vendorId)) {
          throw new NotFoundError('Conversation');
        }
        return 'customer_vendor';

      default:
        // Admins included. Support reading a live customer conversation is a
        // separate, audited capability — not something the chat API grants.
        throw new NotFoundError('Conversation');
    }
  }

  private claims(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    try { return this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  /**
   * Consume a domain event and fan out notifications.
   *
   * Called by the relay, not by a phone. Always 201 with an outcome: a
   * duplicate is a normal, expected result of at-least-once delivery, not
   * an error to retry.
   */
  @Post('events')
  async event(@Body() body: any) {
    requireFields(body, ['eventId', 'eventType']);
    const context = (body.context ?? {}) as TemplateContext;

    const outcome = await this.dispatcher.handle({
      eventId: String(body.eventId),
      eventType: String(body.eventType),
      context,
      resolve: (recipient) =>
        this.directory.targetFor(String(context.orderId ?? body.orderId ?? ''), recipient),
    });

    return {
      eventId: outcome.eventId,
      duplicate: outcome.duplicate,
      notifications: outcome.notifications,
    };
  }

  /**
   * What WOULD this event send? Used by support to answer "why didn't my
   * customer get a text?" without actually sending one.
   */
  @Post('preview')
  async preview(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    if (c.role !== 'admin') throw new ForbiddenError('Admins only');
    requireFields(body, ['eventType']);

    const specs = render(String(body.eventType), (body.context ?? {}) as TemplateContext);
    return {
      eventType: body.eventType,
      notifications: specs.map((s) => ({
        recipient: s.recipient,
        channels: s.channels,
        title: s.title,
        body: s.body,
        // SMS is billed per 160-character segment. A template that quietly
        // grew to three segments triples the cost of every order.
        ...(s.channels.includes('sms')
          ? { smsSegments: smsSegments(s.body) } : {}),
      })),
    };
  }

  /** The templates we know about — lets admin verify a deploy shipped them. */
  @Get('templates')
  templates(@Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    if (c.role !== 'admin') throw new ForbiddenError('Admins only');
    return { eventTypes: Object.keys(TEMPLATES).sort() };
  }

  /* ---------------- chat ---------------- */

  @Get('chat/:orderId')
  async history(
    @Param('orderId') orderId: string, @Query() q: any,
    @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    // OWNERSHIP FIRST. pairFor() only ever derived a thread name from the
    // caller's ROLE — it never asked whether this caller is on this order.
    const pair = await this.requireParticipant(orderId, c, q.pair);
    const window = await this.chat.window(orderId, pair);

    // Reading a conversation nobody has started yet is not an error — it is
    // an empty conversation. Returning 404 here made the chat screen show a
    // failure banner every time a customer opened it before saying anything.
    if (!window) return { orderId, pair, messages: [], open: true };

    const access = canChat(window, partyFor(c.role));
    if (!access.allowed) throw new ForbiddenError(access.reason);

    return {
      orderId, pair, open: true,
      messages: await this.chat.history(orderId, pair),
    };
  }

  @Post('chat/:orderId')
  async send(
    @Param('orderId') orderId: string, @Body() body: any,
    @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    const pair = await this.requireParticipant(orderId, c, body?.pair);

    // Open the thread on first message rather than requiring a separate call.
    // Nothing in the platform called openThread, so EVERY chat request 404'd
    // — chat was unreachable in production and no unit test noticed, because
    // they all pre-seeded a window.
    const window = await this.chat.ensureWindow(
      orderId, pair, c.role === 'customer' ? c.sub : (body?.customerId ?? c.sub),
    );

    // The 30-minute grace period after delivery (PDF §9). Enforced here so
    // a client holding an open socket cannot keep messaging forever.
    const access = canChat(window, partyFor(c.role));
    if (!access.allowed) throw new ForbiddenError(access.reason);

    let clean: { body?: string; imageUrl?: string };
    try {
      clean = validateMessage({
        orderId, from: partyFor(c.role), body: body?.body, imageUrl: body?.imageUrl,
      });
    } catch (e) {
      if (e instanceof ChatValidationError) {
        throw new ValidationError({ body: [e.message] });
      }
      throw e;
    }

    const saved = await this.chat.append({
      orderId, pair, from: partyFor(c.role),
      // The AUTHENTICATED subject, not the party name. Without this the
      // store fell back to writing "customer" into a uuid column and every
      // send 500'd — and, worse, the transcript would not have recorded WHO
      // said what, which is the whole point of keeping it as evidence.
      fromUserId: c.sub,
      ...clean,
    });
    return { orderId, pair, from: partyFor(c.role), ...clean, ...saved };
  }
}

/** Which conversation this role belongs to. */
function partyFor(role: string): ChatParty {
  if (role === 'rider') return 'rider';
  if (role === 'vendor_owner' || role === 'vendor_staff') return 'vendor';
  return 'customer';
}

/* ------------------------------------------------------------------ */

export interface MessagingDeps {
  pool?: Pool | null;
  dispatcher: NotificationDispatcher;
  directory?: Directory;
  chatStore?: ChatStore;
  participants?: OrderParticipantLookup;
  verifyToken?: VerifyToken;
}

@Module({})
export class MessagingHttpModule {
  static forRoot(deps: MessagingDeps): DynamicModule {
    return {
      module: MessagingHttpModule,
      imports: [HealthModule.forRoot(deps.pool ?? null)],
      controllers: [MessagingController],
      providers: [
        { provide: DISPATCHER, useValue: deps.dispatcher },
        { provide: DIRECTORY, useValue: deps.directory ?? new InMemoryDirectory() },
        {
          provide: PARTICIPANTS,
          useValue: deps.participants
            ?? (deps.pool
              ? new PgParticipants(deps.pool)
              : new InMemoryParticipants()),
        },
        {
          provide: CHAT_STORE,
          // An explicit store wins; otherwise a pool means PERSIST. Before
          // this, passing a pool still silently produced the in-memory store
          // — the service looked configured for Postgres while throwing every
          // chat transcript away on restart.
          useValue: deps.chatStore
            ?? (deps.pool ? new PgChatStore(deps.pool) : new InMemoryChatStore()),
        },
        {
          provide: VERIFY_TOKEN,
          useValue: deps.verifyToken ?? (() => {
            throw new UnauthorizedError('token verification is not configured');
          }),
        },
      ],
    };
  }
}
