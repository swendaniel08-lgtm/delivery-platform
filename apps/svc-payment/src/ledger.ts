/**
 * Ledger posting service — the only way money moves in Besonc.
 *
 * The DB constraint (001_ledger.sql) is the last line of defence; this is the
 * first. Every posting is idempotent on `reference`, so a retried webhook or a
 * redelivered queue message can never double-credit a vendor.
 *
 * MASTER_PLAN §3.4 / §3.5.
 */

import { add, type Pesewas } from '../../../libs/money/src/money.ts';
import { ConflictError, ValidationError } from '../../../libs/platform/src/errors.ts';

export type AccountType =
  | 'PLATFORM_REVENUE' | 'PLATFORM_HOLDING' | 'PLATFORM_CASH_HOLDING'
  | 'PLATFORM_FEES_EXPENSE' | 'PLATFORM_PROMO_EXPENSE'
  | 'CUSTOMER_WALLET' | 'VENDOR_WALLET' | 'RIDER_WALLET'
  | 'RIDER_COD_OBLIGATION' | 'PAYSTACK_INFLOW' | 'PAYSTACK_OUTFLOW';

export interface AccountRef {
  type: AccountType;
  /** NULL for platform singleton accounts. */
  ownerId?: string;
}

export interface EntryInput {
  account: AccountRef;
  direction: 'debit' | 'credit';
  amount: Pesewas;
}

export interface PostingInput {
  /** Idempotency key, e.g. `order:{id}:settlement`. */
  reference: string;
  type: string;
  orderId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  entries: EntryInput[];
}

export interface PostedTransaction {
  id: string;
  reference: string;
  /** true when this reference already existed — no new rows were written. */
  idempotentReplay: boolean;
}

/** Database port. Implemented by PgLedgerRepository; faked in tests. */
export interface LedgerRepository {
  /** Runs `fn` inside a single DB transaction. */
  withTransaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
}

export interface LedgerTx {
  findTransactionByReference(reference: string): Promise<{ id: string } | null>;
  ensureAccount(ref: AccountRef): Promise<{ id: string }>;
  insertTransaction(input: {
    reference: string; type: string; orderId?: string;
    description?: string; metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
  insertEntry(input: {
    transactionId: string; accountId: string;
    direction: 'debit' | 'credit'; amount: Pesewas;
  }): Promise<void>;
  applyBalanceDelta(accountId: string, deltaPesewas: Pesewas): Promise<void>;
  getBalance(ref: AccountRef): Promise<Pesewas>;
}

/** Which side increases each account type. */
const NORMAL_BALANCE: Record<AccountType, 'debit' | 'credit'> = {
  PLATFORM_REVENUE: 'credit',
  PLATFORM_HOLDING: 'credit',
  PLATFORM_CASH_HOLDING: 'credit',
  PLATFORM_FEES_EXPENSE: 'debit',
  PLATFORM_PROMO_EXPENSE: 'debit',
  CUSTOMER_WALLET: 'credit',
  VENDOR_WALLET: 'credit',
  RIDER_WALLET: 'credit',
  RIDER_COD_OBLIGATION: 'debit',
  PAYSTACK_INFLOW: 'debit',
  PAYSTACK_OUTFLOW: 'credit',
};

export function normalBalanceOf(t: AccountType): 'debit' | 'credit' {
  return NORMAL_BALANCE[t];
}

/** Signed balance delta: +ve when the entry increases the account. */
export function balanceDelta(t: AccountType, direction: 'debit' | 'credit', amount: Pesewas): Pesewas {
  return NORMAL_BALANCE[t] === direction ? amount : -amount;
}

export class LedgerService {
  constructor(private readonly repo: LedgerRepository) {}

  /**
   * Post a balanced transaction. Rejects unbalanced input BEFORE touching the
   * database, so we get a clean error rather than a constraint violation.
   */
  async post(input: PostingInput): Promise<PostedTransaction> {
    this.assertBalanced(input);

    return this.repo.withTransaction(async (tx) => {
      const existing = await tx.findTransactionByReference(input.reference);
      if (existing) {
        return { id: existing.id, reference: input.reference, idempotentReplay: true };
      }

      const trx = await tx.insertTransaction({
        reference: input.reference,
        type: input.type,
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...(input.description ? { description: input.description } : {}),
        metadata: input.metadata ?? {},
      });

      for (const e of input.entries) {
        const account = await tx.ensureAccount(e.account);
        await tx.insertEntry({
          transactionId: trx.id,
          accountId: account.id,
          direction: e.direction,
          amount: e.amount,
        });
        await tx.applyBalanceDelta(account.id, balanceDelta(e.account.type, e.direction, e.amount));
      }

      return { id: trx.id, reference: input.reference, idempotentReplay: false };
    });
  }

  private assertBalanced(input: PostingInput): void {
    if (input.entries.length < 2) {
      throw new ValidationError({ entries: ['double-entry requires at least 2 entries'] });
    }
    let debits = 0n;
    let credits = 0n;
    for (const e of input.entries) {
      if (e.amount <= 0n) {
        throw new ValidationError({ amount: [`entry amounts must be positive, got ${e.amount}`] });
      }
      if (e.direction === 'debit') debits = add(debits, e.amount);
      else credits = add(credits, e.amount);
    }
    if (debits !== credits) {
      throw new ValidationError({
        entries: [`unbalanced: debits=${debits} credits=${credits} difference=${debits - credits}`],
      });
    }
  }

  balance(ref: AccountRef): Promise<Pesewas> {
    return this.repo.withTransaction((tx) => tx.getBalance(ref));
  }

  /* ---------------------------------------------------------------- */
  /* Canonical postings — MASTER_PLAN §3.4 and §3.5                    */
  /* ---------------------------------------------------------------- */

  /** Money arrives from Paystack and is held pending delivery. */
  capture(orderId: string, total: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `order:${orderId}:capture`,
      type: 'capture',
      orderId,
      description: 'Customer payment captured',
      entries: [
        { account: { type: 'PAYSTACK_INFLOW' }, direction: 'debit', amount: total },
        { account: { type: 'PLATFORM_HOLDING' }, direction: 'credit', amount: total },
      ],
    });
  }

  /** Paystack's cut is a real cost — booked, never silently netted. */
  pspFee(orderId: string, fee: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `order:${orderId}:psp_fee`,
      type: 'psp_fee',
      orderId,
      description: 'Paystack processing fee',
      entries: [
        { account: { type: 'PLATFORM_FEES_EXPENSE' }, direction: 'debit', amount: fee },
        { account: { type: 'PAYSTACK_INFLOW' }, direction: 'credit', amount: fee },
      ],
    });
  }

  /** Order delivered: release the hold to vendor, rider and platform. */
  settlePrepaid(input: {
    orderId: string; vendorId: string; riderId: string;
    total: Pesewas; vendorAmount: Pesewas; riderAmount: Pesewas; platformAmount: Pesewas;
  }): Promise<PostedTransaction> {
    this.assertSplit(input.total, [input.vendorAmount, input.riderAmount, input.platformAmount]);
    return this.post({
      reference: `order:${input.orderId}:settlement`,
      type: 'settlement',
      orderId: input.orderId,
      description: 'Order delivered — settlement',
      entries: [
        { account: { type: 'PLATFORM_HOLDING' }, direction: 'debit', amount: input.total },
        { account: { type: 'VENDOR_WALLET', ownerId: input.vendorId }, direction: 'credit', amount: input.vendorAmount },
        { account: { type: 'RIDER_WALLET', ownerId: input.riderId }, direction: 'credit', amount: input.riderAmount },
        { account: { type: 'PLATFORM_REVENUE' }, direction: 'credit', amount: input.platformAmount },
      ],
    });
  }

  /**
   * COD: the rider now physically holds our cash.
   * Booked at DELIVERY, not at order placement (issue #2).
   */
  codObligation(orderId: string, riderId: string, total: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `order:${orderId}:cod_obligation`,
      type: 'cod_obligation',
      orderId,
      description: 'Cash collected by rider',
      entries: [
        { account: { type: 'RIDER_COD_OBLIGATION', ownerId: riderId }, direction: 'debit', amount: total },
        { account: { type: 'PLATFORM_CASH_HOLDING' }, direction: 'credit', amount: total },
      ],
    });
  }

  /** COD settlement draws on cash holding rather than the Paystack hold. */
  settleCod(input: {
    orderId: string; vendorId: string; riderId: string;
    total: Pesewas; vendorAmount: Pesewas; riderAmount: Pesewas; platformAmount: Pesewas;
  }): Promise<PostedTransaction> {
    this.assertSplit(input.total, [input.vendorAmount, input.riderAmount, input.platformAmount]);
    return this.post({
      reference: `order:${input.orderId}:settlement`,
      type: 'settlement_cod',
      orderId: input.orderId,
      description: 'COD order delivered — settlement',
      entries: [
        { account: { type: 'PLATFORM_CASH_HOLDING' }, direction: 'debit', amount: input.total },
        { account: { type: 'VENDOR_WALLET', ownerId: input.vendorId }, direction: 'credit', amount: input.vendorAmount },
        { account: { type: 'RIDER_WALLET', ownerId: input.riderId }, direction: 'credit', amount: input.riderAmount },
        { account: { type: 'PLATFORM_REVENUE' }, direction: 'credit', amount: input.platformAmount },
      ],
    });
  }

  /** Rider pays the collected cash back in via mobile money. */
  codRemittance(riderId: string, remittanceId: string, amount: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `cod_remittance:${remittanceId}`,
      type: 'cod_remittance',
      description: 'Rider remitted cash',
      entries: [
        { account: { type: 'PAYSTACK_INFLOW' }, direction: 'debit', amount },
        { account: { type: 'RIDER_COD_OBLIGATION', ownerId: riderId }, direction: 'credit', amount },
      ],
    });
  }

  /** Refund to the customer's in-app wallet (instant, no PSP fee). */
  refundToWallet(orderId: string, customerId: string, amount: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `order:${orderId}:refund_wallet`,
      type: 'refund_wallet',
      orderId,
      description: 'Refund to Besonc wallet',
      entries: [
        { account: { type: 'PLATFORM_HOLDING' }, direction: 'debit', amount },
        { account: { type: 'CUSTOMER_WALLET', ownerId: customerId }, direction: 'credit', amount },
      ],
    });
  }

  /** Payout of a wallet balance to MoMo/bank via Paystack Transfers. */
  payout(payoutId: string, account: AccountRef, amount: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `payout:${payoutId}`,
      type: 'payout',
      description: 'Wallet withdrawal',
      entries: [
        { account, direction: 'debit', amount },
        { account: { type: 'PAYSTACK_OUTFLOW' }, direction: 'credit', amount },
      ],
    });
  }

  /**
   * Reverse a failed payout. Never edit or delete — the ledger is append-only,
   * so a reversal is a new, mirrored transaction.
   */
  reversePayout(payoutId: string, account: AccountRef, amount: Pesewas): Promise<PostedTransaction> {
    return this.post({
      reference: `payout:${payoutId}:reversal`,
      type: 'payout_reversal',
      description: 'Payout failed — funds returned to wallet',
      entries: [
        { account: { type: 'PAYSTACK_OUTFLOW' }, direction: 'debit', amount },
        { account, direction: 'credit', amount },
      ],
    });
  }

  private assertSplit(total: Pesewas, parts: Pesewas[]): void {
    const sum = add(...parts);
    if (sum !== total) {
      throw new ConflictError(`settlement split ${sum} does not equal total ${total}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Withdrawal guard — MASTER_PLAN §3.5                                 */
/* ------------------------------------------------------------------ */

export const WITHDRAWAL_RULES = {
  minimumPesewas: 2_000,  // GHS 20
  feePesewas: 100,        // GHS 1 flat
  vendorHoldHours: 24,    // dispute window
} as const;

export interface WithdrawalCheck {
  allowed: boolean;
  reason?: string;
  maxWithdrawablePesewas: Pesewas;
}

/**
 * A rider's withdrawable balance is wallet MINUS unremitted cash.
 * Without this a rider can collect COD, immediately cash out their earnings,
 * and disappear with the float.
 */
export function riderWithdrawable(
  walletBalance: Pesewas,
  codObligation: Pesewas,
  requested: Pesewas,
): WithdrawalCheck {
  const available = walletBalance - codObligation;
  const max = available > 0n ? available : 0n;

  if (requested < BigInt(WITHDRAWAL_RULES.minimumPesewas)) {
    return { allowed: false, reason: 'Minimum withdrawal is GHS 20', maxWithdrawablePesewas: max };
  }
  if (codObligation > 0n && available < requested) {
    return {
      allowed: false,
      reason: `You must remit GHS ${(Number(codObligation) / 100).toFixed(2)} in cash before withdrawing this amount`,
      maxWithdrawablePesewas: max,
    };
  }
  if (requested > max) {
    return { allowed: false, reason: 'Insufficient balance', maxWithdrawablePesewas: max };
  }
  return { allowed: true, maxWithdrawablePesewas: max };
}

export function vendorWithdrawable(
  walletBalance: Pesewas,
  heldPesewas: Pesewas,
  requested: Pesewas,
): WithdrawalCheck {
  const available = walletBalance - heldPesewas;
  const max = available > 0n ? available : 0n;
  if (requested < BigInt(WITHDRAWAL_RULES.minimumPesewas)) {
    return { allowed: false, reason: 'Minimum withdrawal is GHS 20', maxWithdrawablePesewas: max };
  }
  if (requested > max) {
    return {
      allowed: false,
      reason: 'Some earnings are still within the 24-hour dispute hold',
      maxWithdrawablePesewas: max,
    };
  }
  return { allowed: true, maxWithdrawablePesewas: max };
}
