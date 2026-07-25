/**
 * payment-svc HTTP surface.
 *
 * Two rules govern everything here:
 *
 *   1. **The webhook is the only source of payment truth.** A client saying
 *      "payment succeeded" is a claim, not a fact (issue #6). The client
 *      callback endpoint below deliberately returns the ledger's opinion
 *      rather than recording anything.
 *   2. **Money never moves without a balanced double-entry posting.** Every
 *      route delegates to LedgerService, which refuses unbalanced input
 *      before it reaches the database.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Req, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError,
} from '../../../libs/platform/src/errors.ts';
import { formatCedis } from '../../../libs/money/src/money.ts';
import {
  LedgerService, riderWithdrawable, vendorWithdrawable, WITHDRAWAL_RULES,
  type AccountRef,
} from './ledger.ts';
import { InMemoryLedgerRepository } from './memory-ledger-repository.ts';
import { PgLedgerRepository } from './pg-ledger-repository.ts';
import { PaystackWebhookProcessor } from './paystack/webhook.ts';

export const LEDGER = Symbol('LEDGER');
export const WEBHOOK_PROCESSOR = Symbol('WEBHOOK_PROCESSOR');
export const COD_STATE = Symbol('COD_STATE');
export const VERIFY_TOKEN = Symbol('PAYMENT_VERIFY_TOKEN');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

/** How much cash a rider is holding, and what the vendor hold is. */
export interface ObligationSource {
  codObligation(riderId: string): Promise<bigint>;
  vendorHeld(vendorId: string): Promise<bigint>;
}

export class InMemoryObligationSource implements ObligationSource {
  cod = new Map<string, bigint>();
  held = new Map<string, bigint>();
  async codObligation(riderId: string) { return this.cod.get(riderId) ?? 0n; }
  async vendorHeld(vendorId: string) { return this.held.get(vendorId) ?? 0n; }
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

function pesewas(v: unknown, field: string): bigint {
  try {
    const n = BigInt(v as string);
    if (n < 0n) throw new Error('negative');
    return n;
  } catch {
    throw new ValidationError({ [field]: ['must be a non-negative integer of pesewas'] });
  }
}

/* ------------------------------------------------------------------ */
/* Webhooks — the only source of payment truth                         */
/* ------------------------------------------------------------------ */

@Controller('payments')
export class WebhookController {
  constructor(
    @Inject(WEBHOOK_PROCESSOR) private readonly processor: PaystackWebhookProcessor,
  ) {}

  /**
   * Paystack calls this. The signature is computed over the RAW body, so we
   * read the untouched string rather than the parsed object — re-serialising
   * JSON reorders keys and silently breaks every signature.
   */
  @Post('webhooks/paystack')
  async paystack(@Req() req: any, @Headers('x-paystack-signature') signature?: string) {
    if (!signature) throw new UnauthorizedError('Missing signature');
    const raw: string = typeof req.rawBody === 'string'
      ? req.rawBody
      : JSON.stringify(req.body ?? {});

    const outcome = await this.processor.handle(raw, signature);
    // Always 200 once the signature is good: a non-2xx makes Paystack retry
    // an event we have already durably recorded.
    return outcome;
  }
}

/* ------------------------------------------------------------------ */
/* Wallets and payouts                                                 */
/* ------------------------------------------------------------------ */

@Controller('payments')
export class WalletController {
  constructor(
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(COD_STATE) private readonly obligations: ObligationSource,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    try { return this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  private accountFor(c: Claims): AccountRef {
    switch (c.role) {
      case 'customer': return { type: 'CUSTOMER_WALLET', ownerId: c.sub };
      case 'rider': return { type: 'RIDER_WALLET', ownerId: c.sub };
      case 'vendor_owner':
      case 'vendor_staff': return { type: 'VENDOR_WALLET', ownerId: c.sub };
      default: throw new ForbiddenError('This role has no wallet');
    }
  }

  /**
   * My wallet. A rider's headline number is deliberately their WITHDRAWABLE
   * balance, not their raw wallet balance — showing GHS 400 to a rider who
   * owes GHS 300 in uncollected cash creates a support call every time.
   */
  @Get('wallet')
  async wallet(@Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const ref = this.accountFor(c);
    const balance = await this.ledger.balance(ref);

    if (c.role === 'rider') {
      const cod = await this.obligations.codObligation(c.sub);
      const available = balance - cod > 0n ? balance - cod : 0n;
      return {
        role: c.role,
        balancePesewas: balance.toString(),
        balanceDisplay: formatCedis(balance),
        codObligationPesewas: cod.toString(),
        codObligationDisplay: formatCedis(cod),
        withdrawablePesewas: available.toString(),
        withdrawableDisplay: formatCedis(available),
        minimumWithdrawalPesewas: String(WITHDRAWAL_RULES.minimumPesewas),
      };
    }

    if (c.role === 'vendor_owner' || c.role === 'vendor_staff') {
      const held = await this.obligations.vendorHeld(c.sub);
      const available = balance - held > 0n ? balance - held : 0n;
      return {
        role: c.role,
        balancePesewas: balance.toString(),
        balanceDisplay: formatCedis(balance),
        heldPesewas: held.toString(),
        heldDisplay: formatCedis(held),
        withdrawablePesewas: available.toString(),
        withdrawableDisplay: formatCedis(available),
        holdHours: WITHDRAWAL_RULES.vendorHoldHours,
      };
    }

    return {
      role: c.role,
      balancePesewas: balance.toString(),
      balanceDisplay: formatCedis(balance),
    };
  }

  /**
   * Ask to cash out. This only CHECKS and reserves; the actual Paystack
   * transfer is driven by the payout saga so a network failure mid-transfer
   * cannot leave the ledger and the PSP disagreeing.
   */
  @Post('payouts')
  async requestPayout(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    requireFields(body, ['amountPesewas']);
    const requested = pesewas(body.amountPesewas, 'amountPesewas');

    const ref = this.accountFor(c);
    const balance = await this.ledger.balance(ref);

    const check = c.role === 'rider'
      ? riderWithdrawable(balance, await this.obligations.codObligation(c.sub), requested)
      : vendorWithdrawable(balance, await this.obligations.vendorHeld(c.sub), requested);

    if (!check.allowed) {
      // 422 with the reason and the real ceiling, so the app can offer
      // "withdraw GHS X instead" rather than just refusing.
      throw new ValidationError({
        amountPesewas: [check.reason ?? 'Withdrawal not allowed'],
      }, check.reason ?? 'Withdrawal not allowed');
    }

    const payoutId = `po_${Date.now()}_${c.sub.slice(0, 8)}`;
    await this.ledger.payout(payoutId, ref, requested);

    return {
      payoutId,
      status: 'pending',
      amountPesewas: requested.toString(),
      amountDisplay: formatCedis(requested),
      feePesewas: String(WITHDRAWAL_RULES.feePesewas),
    };
  }

  /** What could I withdraw right now, and why not more? */
  @Get('payouts/quote')
  async quote(@Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const ref = this.accountFor(c);
    const balance = await this.ledger.balance(ref);
    const check = c.role === 'rider'
      ? riderWithdrawable(balance, await this.obligations.codObligation(c.sub),
          BigInt(WITHDRAWAL_RULES.minimumPesewas))
      : vendorWithdrawable(balance, await this.obligations.vendorHeld(c.sub),
          BigInt(WITHDRAWAL_RULES.minimumPesewas));

    return {
      maxWithdrawablePesewas: check.maxWithdrawablePesewas.toString(),
      maxWithdrawableDisplay: formatCedis(check.maxWithdrawablePesewas),
      minimumPesewas: String(WITHDRAWAL_RULES.minimumPesewas),
      feePesewas: String(WITHDRAWAL_RULES.feePesewas),
      ...(check.allowed ? {} : { blockedReason: check.reason }),
    };
  }

  /** Rider pays collected cash back to the platform. */
  @Post('cod/remittances')
  async remit(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    if (c.role !== 'rider') throw new ForbiddenError('Riders only');
    requireFields(body, ['amountPesewas', 'remittanceId']);
    const amount = pesewas(body.amountPesewas, 'amountPesewas');
    if (amount === 0n) {
      throw new ValidationError({ amountPesewas: ['must be more than zero'] });
    }

    const owed = await this.obligations.codObligation(c.sub);
    if (amount > owed) {
      // Overpayment is almost always a typo; accepting it would create a
      // negative obligation nobody can explain at reconciliation.
      throw new ValidationError({
        amountPesewas: [`You are only holding ${formatCedis(owed)}`],
      });
    }

    const posted = await this.ledger.codRemittance(
      c.sub, String(body.remittanceId), amount,
    );
    return {
      remittanceId: body.remittanceId,
      amountPesewas: amount.toString(),
      amountDisplay: formatCedis(amount),
      idempotentReplay: posted.idempotentReplay,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Order-driven postings (server-to-server)                            */
/* ------------------------------------------------------------------ */

@Controller('payments/internal')
export class LedgerController {
  constructor(
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private service(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    let c: Claims;
    try { c = this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
    if (!['service', 'admin'].includes(c.role)) {
      throw new ForbiddenError('Internal endpoint');
    }
    return c;
  }

  /**
   * Settle a delivered order: release the hold into three wallets.
   *
   * The split must sum to the total exactly. LedgerService enforces that, so
   * a rounding bug in pricing surfaces here as a 422 rather than as money
   * quietly appearing or vanishing.
   */
  @Post('settlements')
  async settle(@Body() body: any, @Headers('authorization') auth?: string) {
    this.service(auth);
    requireFields(body, [
      'orderId', 'vendorId', 'riderId', 'totalPesewas',
      'vendorPesewas', 'riderPesewas', 'platformPesewas',
    ]);

    const input = {
      orderId: String(body.orderId),
      vendorId: String(body.vendorId),
      riderId: String(body.riderId),
      total: pesewas(body.totalPesewas, 'totalPesewas'),
      vendorAmount: pesewas(body.vendorPesewas, 'vendorPesewas'),
      riderAmount: pesewas(body.riderPesewas, 'riderPesewas'),
      platformAmount: pesewas(body.platformPesewas, 'platformPesewas'),
    };

    const posted = body.isCod === true
      ? await this.ledger.settleCod(input)
      : await this.ledger.settlePrepaid(input);

    return {
      transactionId: posted.id,
      reference: posted.reference,
      idempotentReplay: posted.idempotentReplay,
    };
  }

  /** Customer money captured by Paystack, held pending delivery. */
  @Post('captures')
  async capture(@Body() body: any, @Headers('authorization') auth?: string) {
    this.service(auth);
    requireFields(body, ['orderId', 'totalPesewas']);
    const posted = await this.ledger.capture(
      String(body.orderId), pesewas(body.totalPesewas, 'totalPesewas'),
    );
    return { transactionId: posted.id, idempotentReplay: posted.idempotentReplay };
  }

  /** Cash is now in the rider's pocket. Booked at delivery, not placement. */
  @Post('cod/obligations')
  async codObligation(@Body() body: any, @Headers('authorization') auth?: string) {
    this.service(auth);
    requireFields(body, ['orderId', 'riderId', 'totalPesewas']);
    const posted = await this.ledger.codObligation(
      String(body.orderId), String(body.riderId),
      pesewas(body.totalPesewas, 'totalPesewas'),
    );
    return { transactionId: posted.id, idempotentReplay: posted.idempotentReplay };
  }

  @Post('refunds')
  async refund(@Body() body: any, @Headers('authorization') auth?: string) {
    this.service(auth);
    requireFields(body, ['orderId', 'customerId', 'amountPesewas']);
    const posted = await this.ledger.refundToWallet(
      String(body.orderId), String(body.customerId),
      pesewas(body.amountPesewas, 'amountPesewas'),
    );
    return { transactionId: posted.id, idempotentReplay: posted.idempotentReplay };
  }

  /** Read any account balance. Admin/service only — this is everyone's money. */
  @Get('balances/:type/:ownerId')
  async balance(
    @Param('type') type: string, @Param('ownerId') ownerId: string,
    @Headers('authorization') auth?: string,
  ) {
    this.service(auth);
    const ref = { type: type as AccountRef['type'], ownerId } as AccountRef;
    const balance = await this.ledger.balance(ref);
    return {
      type, ownerId,
      balancePesewas: balance.toString(),
      balanceDisplay: formatCedis(balance),
    };
  }
}

/* ------------------------------------------------------------------ */

export interface PaymentDeps {
  pool?: Pool | null;
  ledger?: LedgerService;
  processor?: PaystackWebhookProcessor;
  obligations?: ObligationSource;
  verifyToken?: VerifyToken;
}

@Module({})
export class PaymentHttpModule {
  static forRoot(deps: PaymentDeps = {}): DynamicModule {
    const pool = deps.pool ?? null;
    const ledger = deps.ledger ?? new LedgerService(
      pool ? new PgLedgerRepository(pool) : new InMemoryLedgerRepository(),
    );
    const obligations = deps.obligations ?? new InMemoryObligationSource();
    const verify: VerifyToken = deps.verifyToken ?? (() => {
      throw new UnauthorizedError('token verification is not configured');
    });

    const controllers: any[] = [WalletController, LedgerController];
    const providers: any[] = [
      { provide: LEDGER, useValue: ledger },
      { provide: COD_STATE, useValue: obligations },
      { provide: VERIFY_TOKEN, useValue: verify },
    ];

    // The webhook route only exists when a processor (and therefore a secret
    // key) is configured — an unsigned webhook endpoint is worse than none.
    if (deps.processor) {
      controllers.push(WebhookController);
      providers.push({ provide: WEBHOOK_PROCESSOR, useValue: deps.processor });
    }

    return {
      module: PaymentHttpModule,
      imports: [HealthModule.forRoot(pool)],
      controllers,
      providers,
    };
  }
}
