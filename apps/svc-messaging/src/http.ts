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

export interface ChatStore {
  window(orderId: string, pair: ChatWindow['pair']): Promise<ChatWindow | null>;
  append(msg: {
    orderId: string; pair: string; from: string;
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
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

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
    const pair = pairFor(c.role, q.pair);
    const window = await this.chat.window(orderId, pair);
    if (!window) throw new NotFoundError('Conversation');

    const access = canChat(window, partyFor(c.role));
    if (!access.allowed) throw new ForbiddenError(access.reason);

    return { orderId, pair, messages: await this.chat.history(orderId, pair) };
  }

  @Post('chat/:orderId')
  async send(
    @Param('orderId') orderId: string, @Body() body: any,
    @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    const pair = pairFor(c.role, body?.pair);
    const window = await this.chat.window(orderId, pair);
    if (!window) throw new NotFoundError('Conversation');

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
      orderId, pair, from: partyFor(c.role), ...clean,
    });
    return { orderId, pair, from: partyFor(c.role), ...clean, ...saved };
  }
}

/** Which conversation this role belongs to. */
function pairFor(role: string, requested?: string): ChatWindow['pair'] {
  if (role === 'rider') return 'customer_rider';
  if (role === 'vendor_owner' || role === 'vendor_staff') return 'customer_vendor';
  // A customer is in both, so they must say which.
  if (requested === 'customer_vendor' || requested === 'customer_rider') {
    return requested;
  }
  return 'customer_rider';
}

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
        { provide: CHAT_STORE, useValue: deps.chatStore ?? new InMemoryChatStore() },
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
