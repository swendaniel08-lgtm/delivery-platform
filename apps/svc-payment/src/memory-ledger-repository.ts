/**
 * In-memory LedgerRepository.
 *
 * Not a toy: it enforces the same invariants the SQL schema does — reference
 * uniqueness (idempotency), account auto-creation, and signed balance
 * application — so the HTTP specs exercise real ledger behaviour without a
 * database. The Postgres implementation remains the production one and is
 * covered separately by `ledger-service.spec` against real PostgreSQL.
 */

import type { Pesewas } from '../../../libs/money/src/money.ts';
import type { AccountRef, LedgerRepository, LedgerTx } from './ledger.ts';

function accountKey(ref: AccountRef): string {
  return ref.ownerId ? `${ref.type}:${ref.ownerId}` : ref.type;
}

export class InMemoryLedgerRepository implements LedgerRepository {
  accounts = new Map<string, { id: string; balance: Pesewas }>();
  transactions = new Map<string, { id: string; reference: string; type: string }>();
  entries: Array<{
    transactionId: string; accountId: string;
    direction: 'debit' | 'credit'; amount: Pesewas;
  }> = [];

  private seq = 0;
  private nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /**
   * There is no real isolation here — the whole store is a single-threaded
   * Map. That is honest for a test double: Node runs one callback at a time,
   * so a `withTransaction` body cannot interleave with another.
   */
  async withTransaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const self = this;
    const tx: LedgerTx = {
      async findTransactionByReference(reference: string) {
        for (const t of self.transactions.values()) {
          if (t.reference === reference) return { id: t.id };
        }
        return null;
      },
      async ensureAccount(ref: AccountRef) {
        const key = accountKey(ref);
        const existing = self.accounts.get(key);
        if (existing) return { id: existing.id };
        const created = { id: self.nextId('acct'), balance: 0n };
        self.accounts.set(key, created);
        return { id: created.id };
      },
      async insertTransaction(input) {
        const t = { id: self.nextId('txn'), reference: input.reference, type: input.type };
        self.transactions.set(t.id, t);
        return { id: t.id };
      },
      async insertEntry(input) {
        self.entries.push(input);
      },
      async applyBalanceDelta(accountId: string, delta: Pesewas) {
        for (const a of self.accounts.values()) {
          if (a.id === accountId) { a.balance += delta; return; }
        }
        throw new Error(`no such account ${accountId}`);
      },
      async getBalance(ref: AccountRef) {
        return self.accounts.get(accountKey(ref))?.balance ?? 0n;
      },
    };
    return fn(tx);
  }

  /** Test helper: every debit must equal every credit, always. */
  totals(): { debits: Pesewas; credits: Pesewas } {
    let debits = 0n;
    let credits = 0n;
    for (const e of this.entries) {
      if (e.direction === 'debit') debits += e.amount;
      else credits += e.amount;
    }
    return { debits, credits };
  }

  balanceOf(ref: AccountRef): Pesewas {
    return this.accounts.get(accountKey(ref))?.balance ?? 0n;
  }
}
