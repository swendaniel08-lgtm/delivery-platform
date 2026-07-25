/**
 * Postgres implementation of LedgerRepository.
 * Every posting runs in ONE database transaction, so the deferred
 * balance-constraint trigger fires at COMMIT and an unbalanced posting
 * takes the whole thing down with it.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  AccountRef, LedgerRepository, LedgerTx,
} from './ledger.ts';
import { normalBalanceOf } from './ledger.ts';
import type { Pesewas } from '../../../libs/money/src/money.ts';

class PgLedgerTx implements LedgerTx {
  constructor(private readonly c: PoolClient) {}

  async findTransactionByReference(reference: string) {
    const r = await this.c.query<{ id: string }>(
      'SELECT id FROM ledger_transactions WHERE reference = $1', [reference],
    );
    return r.rows[0] ?? null;
  }

  async ensureAccount(ref: AccountRef) {
    const owner = ref.ownerId ?? null;
    const sel = owner === null
      ? 'SELECT id FROM ledger_accounts WHERE account_type = $1 AND owner_id IS NULL'
      : 'SELECT id FROM ledger_accounts WHERE account_type = $1 AND owner_id = $2';
    const params = owner === null ? [ref.type] : [ref.type, owner];

    const found = await this.c.query<{ id: string }>(sel, params);
    if (found.rows[0]) return found.rows[0];

    const created = await this.c.query<{ id: string }>(
      `INSERT INTO ledger_accounts (account_type, owner_id, normal_balance)
       VALUES ($1, $2, $3) RETURNING id`,
      [ref.type, owner, normalBalanceOf(ref.type)],
    );
    const id = created.rows[0]!.id;
    await this.c.query(
      'INSERT INTO account_balances (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [id],
    );
    return { id };
  }

  async insertTransaction(input: {
    reference: string; type: string; orderId?: string;
    description?: string; metadata: Record<string, unknown>;
  }) {
    const r = await this.c.query<{ id: string }>(
      `INSERT INTO ledger_transactions (reference, type, order_id, description, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.reference, input.type, input.orderId ?? null,
       input.description ?? null, JSON.stringify(input.metadata)],
    );
    return r.rows[0]!;
  }

  async insertEntry(input: {
    transactionId: string; accountId: string;
    direction: 'debit' | 'credit'; amount: Pesewas;
  }) {
    await this.c.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_pesewas)
       VALUES ($1, $2, $3, $4)`,
      [input.transactionId, input.accountId, input.direction, input.amount.toString()],
    );
  }

  async applyBalanceDelta(accountId: string, delta: Pesewas) {
    await this.c.query(
      `UPDATE account_balances
          SET balance_pesewas   = balance_pesewas + $2::BIGINT,
              available_pesewas = available_pesewas + $2::BIGINT,
              version = version + 1,
              updated_at = now()
        WHERE account_id = $1`,
      [accountId, delta.toString()],
    );
  }

  async getBalance(ref: AccountRef): Promise<Pesewas> {
    const owner = ref.ownerId ?? null;
    const sql = owner === null
      ? `SELECT b.balance_pesewas FROM account_balances b
           JOIN ledger_accounts a ON a.id = b.account_id
          WHERE a.account_type = $1 AND a.owner_id IS NULL`
      : `SELECT b.balance_pesewas FROM account_balances b
           JOIN ledger_accounts a ON a.id = b.account_id
          WHERE a.account_type = $1 AND a.owner_id = $2`;
    const r = await this.c.query<{ balance_pesewas: string }>(
      sql, owner === null ? [ref.type] : [ref.type, owner],
    );
    return BigInt(r.rows[0]?.balance_pesewas ?? '0');
  }
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async withTransaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgLedgerTx(client));
      await client.query('COMMIT');   // deferred balance trigger fires here
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
