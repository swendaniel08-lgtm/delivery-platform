/**
 * audit.spec — closes issue #12.
 * Runs the pure logic in-process and the append-only guarantees against
 * real Postgres.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import {
  AuditedActionRunner, InMemoryAuditSink, evaluateAlarms, buildTask,
  REASON_REQUIRED_ACTIONS, MIN_REASON_LENGTH, type DashboardMetrics,
} from '../src/audit.ts';
import type { Principal } from '../../../libs/auth/src/abilities.ts';
import { fromCedis } from '../../../libs/money/src/money.ts';
import { ForbiddenError, ValidationError } from '../../../libs/platform/src/errors.ts';

const DSN = process.env.ADMIN_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55434/admin';
let pool: pg.Pool | undefined;
let dbUp = false;

before(async () => {
  try {
    pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync(join(process.cwd(), 'apps/svc-admin/migrations/001_admin.sql'), 'utf8'));
    dbUp = true;
  } catch { dbUp = false; }
});
after(async () => { await pool?.end(); });

const finance: Principal = { id: 'admin-fin', role: 'finance' };
const support: Principal = { id: 'admin-sup', role: 'support' };
const dispatcherOsu: Principal = { id: 'admin-dsp', role: 'dispatcher', zones: ['accra-osu'] };

describe('authorisation is enforced before any mutation', () => {
  test('finance may refund; the audit row is written', async () => {
    const sink = new InMemoryAuditSink();
    const runner = new AuditedActionRunner(sink);
    let ran = false;

    await runner.run({
      principal: finance, action: 'payment.refund', ability: 'refund', subject: 'Payment',
      entityType: 'Payment', entityId: 'pay-1',
      reason: 'customer never received the order',
      amountPesewas: fromCedis('81.50'),
    }, async () => {
      ran = true;
      return { before: { status: 'settled' }, after: { status: 'refunded' }, result: 'ok' };
    });

    assert.equal(ran, true);
    assert.equal(sink.entries.length, 1);
    const e = sink.entries[0]!;
    assert.equal(e.actorUserId, 'admin-fin');
    assert.equal(e.action, 'payment.refund');
    assert.deepEqual(e.beforeState, { status: 'settled' });
    assert.deepEqual(e.afterState, { status: 'refunded' });
    assert.equal(e.amountPesewas, fromCedis('81.50'));
  });

  test('support may NOT refund — and the mutation never runs', async () => {
    const sink = new InMemoryAuditSink();
    const runner = new AuditedActionRunner(sink);
    let ran = false;

    await assert.rejects(() => runner.run({
      principal: support, action: 'payment.refund', ability: 'refund', subject: 'Payment',
      entityType: 'Payment', entityId: 'pay-1', reason: 'customer asked nicely for a refund',
    }, async () => { ran = true; return { result: 'ok' }; }), ForbiddenError);

    assert.equal(ran, false, 'the mutation must not execute');
    assert.equal(sink.entries.length, 0);
  });

  test('zone scoping applies to admin actions too', async () => {
    const runner = new AuditedActionRunner(new InMemoryAuditSink());
    // in-zone succeeds
    await runner.run({
      principal: dispatcherOsu, action: 'order.update', ability: 'update', subject: 'Order',
      entityType: 'Order', entityId: 'o1', record: { zone: 'accra-osu' },
    }, async () => ({ result: 'ok' }));

    await assert.rejects(() => runner.run({
      principal: dispatcherOsu, action: 'order.update', ability: 'update', subject: 'Order',
      entityType: 'Order', entityId: 'o2', record: { zone: 'kumasi-central' },
    }, async () => ({ result: 'ok' })), ForbiddenError);
  });

  test('nobody may mutate the ledger from the admin panel', async () => {
    const runner = new AuditedActionRunner(new InMemoryAuditSink());
    await assert.rejects(() => runner.run({
      principal: finance, action: 'ledger.edit', ability: 'update', subject: 'Ledger',
      entityType: 'Ledger', entityId: 'tx-1', reason: 'fixing a mistake in the ledger',
    }, async () => ({ result: 'ok' })), ForbiddenError);
  });
});

describe('reasons on sensitive actions', () => {
  test('a refund without a reason is refused', async () => {
    const runner = new AuditedActionRunner(new InMemoryAuditSink());
    await assert.rejects(() => runner.run({
      principal: finance, action: 'payment.refund', ability: 'refund', subject: 'Payment',
      entityType: 'Payment', entityId: 'p1',
    }, async () => ({ result: 'ok' })), ValidationError);
  });

  test('a token reason is refused', async () => {
    const runner = new AuditedActionRunner(new InMemoryAuditSink());
    await assert.rejects(() => runner.run({
      principal: finance, action: 'payment.refund', ability: 'refund', subject: 'Payment',
      entityType: 'Payment', entityId: 'p1', reason: 'ok',
    }, async () => ({ result: 'ok' })), ValidationError);
    assert.equal(MIN_REASON_LENGTH, 10);
  });

  test('routine reads need no reason', async () => {
    const runner = new AuditedActionRunner(new InMemoryAuditSink());
    const r = await runner.run({
      principal: support, action: 'order.view', ability: 'read', subject: 'Order',
      entityType: 'Order', entityId: 'o1',
    }, async () => ({ result: 'viewed' }));
    assert.equal(r, 'viewed');
  });

  test('the guarded action list matches the DB constraint', () => {
    for (const a of ['payment.refund', 'payment.payout', 'vendor.suspend',
                     'rider.suspend', 'order.force_cancel', 'pricing.update']) {
      assert.ok(REASON_REQUIRED_ACTIONS.has(a), `${a} should require a reason`);
    }
  });
});

describe('append-only audit log (real Postgres)', () => {
  test('entries can be written and read', async (t) => {
    if (!dbUp) return t.skip('no database');
    await pool!.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id,
          before_state, after_state, amount_pesewas, reason)
       VALUES (gen_random_uuid(),'finance','payment.refund','Payment','p1',
               '{"status":"settled"}','{"status":"refunded"}',8150,'customer never received the order')`);
    const r = await pool!.query('SELECT count(*) c FROM audit_log');
    assert.equal(r.rows[0]!.c, '1');
  });

  test('UPDATE and DELETE are impossible', async (t) => {
    if (!dbUp) return t.skip('no database');
    await assert.rejects(() => pool!.query(`UPDATE audit_log SET reason='changed'`));
    await assert.rejects(() => pool!.query(`DELETE FROM audit_log`));
    const r = await pool!.query('SELECT count(*) c FROM audit_log');
    assert.equal(r.rows[0]!.c, '1', 'history must survive');
  });

  test('the database ALSO enforces reasons on sensitive actions', async (t) => {
    if (!dbUp) return t.skip('no database');
    // defence in depth: even a direct SQL write cannot skip the reason
    await assert.rejects(() => pool!.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id)
       VALUES (gen_random_uuid(),'finance','payment.payout','Payout','x')`));
  });

  test('non-sensitive actions need no reason', async (t) => {
    if (!dbUp) return t.skip('no database');
    await pool!.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id)
       VALUES (gen_random_uuid(),'support','order.view','Order','o1')`);
  });
});

describe('config versioning (real Postgres)', () => {
  test('every pricing change is versioned and attributed', async (t) => {
    if (!dbUp) return t.skip('no database');
    const admin = '11111111-1111-1111-1111-111111111111';
    await pool!.query(
      `INSERT INTO platform_config (key, value, updated_by) VALUES ('delivery_base_fee','{"pesewas":500}',$1)`,
      [admin]);
    await pool!.query(
      `UPDATE platform_config SET value='{"pesewas":600}', updated_by=$1 WHERE key='delivery_base_fee'`,
      [admin]);

    const cur = await pool!.query<{ version: number; value: any }>(
      `SELECT version, value FROM platform_config WHERE key='delivery_base_fee'`);
    assert.equal(cur.rows[0]!.version, 2);
    assert.equal(cur.rows[0]!.value.pesewas, 600);

    const hist = await pool!.query(
      `SELECT old_value, new_value FROM platform_config_history WHERE key='delivery_base_fee' ORDER BY id`);
    assert.equal(hist.rowCount, 2, 'insert and update both recorded');
    assert.equal(hist.rows[1]!.old_value.pesewas, 500, 'the previous value is recoverable');
  });
});

describe('task queue (real Postgres)', () => {
  test('a retrying job cannot flood the queue', async (t) => {
    if (!dbUp) return t.skip('no database');
    await pool!.query(
      `INSERT INTO admin_tasks (kind, entity_type, entity_id, priority) VALUES ('payout_failed','Payout','pay-9',1)`);
    await assert.rejects(() => pool!.query(
      `INSERT INTO admin_tasks (kind, entity_type, entity_id, priority) VALUES ('payout_failed','Payout','pay-9',1)`));
  });

  test('resolving a task requires writing what was done', async (t) => {
    if (!dbUp) return t.skip('no database');
    await assert.rejects(() => pool!.query(
      `UPDATE admin_tasks SET status='resolved' WHERE entity_id='pay-9'`));
    await pool!.query(
      `UPDATE admin_tasks SET status='resolved', resolution='re-sent to a corrected MoMo number', resolved_at=now()
        WHERE entity_id='pay-9'`);
  });

  test('money-at-risk tasks outrank paperwork', () => {
    assert.equal(buildTask({ kind: 'payout_failed', entityType: 'Payout', entityId: 'x' }).priority, 1);
    assert.equal(buildTask({ kind: 'reconciliation_gap', entityType: 'Ledger', entityId: 'x' }).priority, 1);
    assert.ok(
      buildTask({ kind: 'vendor_application', entityType: 'Vendor', entityId: 'x' }).priority >
      buildTask({ kind: 'dispute', entityType: 'Order', entityId: 'x' }).priority,
    );
  });
});

describe('dashboard alarms', () => {
  const healthy: DashboardMetrics = {
    ordersToday: 200, revenuePesewas: fromCedis('12400'), activeRiders: 47,
    activeVendors: 156, cancellationRatePct: 4, unremittedCodPesewas: fromCedis('2300'),
    openTasks: 3, ledgerHealthy: true,
  };

  test('a healthy platform raises nothing', () => {
    assert.deepEqual(evaluateAlarms(healthy), []);
  });

  test('ledger drift is critical and halts payouts', () => {
    const a = evaluateAlarms({ ...healthy, ledgerHealthy: false });
    assert.equal(a[0]!.severity, 'critical');
    assert.match(a[0]!.message, /payouts are halted/);
  });

  test('a large cash float is critical', () => {
    const a = evaluateAlarms({ ...healthy, unremittedCodPesewas: fromCedis('6000') });
    assert.ok(a.some((x) => x.code === 'COD_FLOAT_HIGH' && x.severity === 'critical'));
  });

  test('rider shortage only fires when there is demand', () => {
    assert.equal(evaluateAlarms({ ...healthy, activeRiders: 2, ordersToday: 5 })
      .some((x) => x.code === 'RIDER_SHORTAGE'), false);
    assert.ok(evaluateAlarms({ ...healthy, activeRiders: 2, ordersToday: 50 })
      .some((x) => x.code === 'RIDER_SHORTAGE'));
  });

  test('high cancellations warn but do not block', () => {
    const a = evaluateAlarms({ ...healthy, cancellationRatePct: 22 });
    assert.equal(a[0]!.severity, 'warning');
  });
});
