/**
 * admin-svc HTTP surface.
 *
 * Every mutating route goes through `AuditedActionRunner`, which refuses the
 * action unless the principal is permitted AND — for the destructive ones —
 * a written reason is supplied. The audit row is written in the same call.
 *
 * That ordering is the whole point: an admin refunding GHS 2,000 or
 * suspending a vendor must leave a trail that cannot be edited afterwards
 * (the `audit_log` table is append-only, enforced in SQL).
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Query, Req, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import { formatCedis } from '../../../libs/money/src/money.ts';
import type { Principal, AdminRole } from '../../../libs/auth/src/abilities.ts';
import {
  AuditedActionRunner, InMemoryAuditSink, evaluateAlarms, buildTask,
  REASON_REQUIRED_ACTIONS, MIN_REASON_LENGTH, TASK_PRIORITY,
  type AuditSink, type AuditEntry, type DashboardMetrics, type TaskKind, permissionFor,
} from './audit.ts';

export const RUNNER = Symbol('AUDIT_RUNNER');
export const AUDIT_SINK = Symbol('AUDIT_SINK');
export const METRICS_SOURCE = Symbol('METRICS_SOURCE');
export const VERIFY_TOKEN = Symbol('ADMIN_VERIFY_TOKEN');

export interface Claims { sub: string; role: string; zones?: string[] }

/** The seven staff roles (libs/auth). Anything else cannot reach admin-svc. */
const STAFF_ROLES = new Set<string>([
  'super_admin', 'ops_manager', 'dispatcher', 'finance',
  'support', 'catalogue_editor', 'read_only',
]);
export type VerifyToken = (token: string) => Claims;

/** Where dashboard numbers come from. Real implementation queries replicas. */
export interface MetricsSource {
  snapshot(): Promise<DashboardMetrics>;
  recentAudit(limit: number): Promise<AuditEntry[]>;
}

export class InMemoryMetricsSource implements MetricsSource {
  metrics: DashboardMetrics = {
    ordersToday: 0, revenuePesewas: 0n, activeRiders: 0, activeVendors: 0,
    cancellationRatePct: 0, unremittedCodPesewas: 0n, openTasks: 0,
    ledgerHealthy: true,
  };
  audit: AuditEntry[] = [];
  async snapshot() { return this.metrics; }
  async recentAudit(limit: number) { return this.audit.slice(-limit).reverse(); }
}

/**
 * Append-only audit sink.
 *
 * There is deliberately no update or delete method. If the interface cannot
 * express "edit an audit row", no future handler can accidentally do it.
 */
export class PgAuditSink implements AuditSink {
  constructor(private readonly pool: Pool) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log
         (actor_user_id, actor_role, action, entity_type, entity_id,
          before_state, after_state, amount_pesewas, reason, ip, user_agent,
          correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)`,
      [
        entry.actorUserId, entry.actorRole, entry.action,
        entry.entityType, entry.entityId,
        entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
        entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
        entry.amountPesewas === undefined ? null : entry.amountPesewas.toString(),
        entry.reason ?? null, entry.ip ?? null, entry.userAgent ?? null,
        entry.correlationId ?? null,
      ],
    );
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

@Controller('admin')
export class AdminController {
  constructor(
    @Inject(RUNNER) private readonly runner: AuditedActionRunner,
    @Inject(METRICS_SOURCE) private readonly metrics: MetricsSource,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private principal(auth?: string): Principal {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    let c: Claims;
    try { c = this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
    // Only the seven staff roles may reach this service at all. The
    // fine-grained decision (may THIS role refund?) is made per-action by
    // `can()`; this is just the front door.
    if (!STAFF_ROLES.has(c.role)) throw new ForbiddenError('Staff only');
    return {
      id: c.sub,
      role: c.role as Principal['role'],
      ...(c.zones ? { zones: c.zones } : {}),
    } as Principal;
  }

  /** The operations dashboard. */
  @Get('dashboard')
  async dashboard(@Headers('authorization') auth?: string) {
    this.principal(auth);
    const m = await this.metrics.snapshot();
    const alarms = evaluateAlarms(m);

    return {
      metrics: {
        ordersToday: m.ordersToday,
        revenueDisplay: formatCedis(m.revenuePesewas),
        activeRiders: m.activeRiders,
        activeVendors: m.activeVendors,
        cancellationRatePct: m.cancellationRatePct,
        unremittedCodDisplay: formatCedis(m.unremittedCodPesewas),
        openTasks: m.openTasks,
        ledgerHealthy: m.ledgerHealthy,
      },
      alarms,
      // The dashboard renders this banner across the top. Payouts really are
      // halted when the ledger drifts — see reconciliation.shouldHaltPayouts.
      payoutsHalted: !m.ledgerHealthy,
    };
  }

  @Get('alarms')
  async alarms(@Headers('authorization') auth?: string) {
    this.principal(auth);
    return { alarms: evaluateAlarms(await this.metrics.snapshot()) };
  }

  /**
   * The audit trail. Read-only by construction — there is no route that
   * writes here directly, and no route at all that edits or deletes.
   */
  @Get('audit')
  async audit(@Query() q: any, @Headers('authorization') auth?: string) {
    const p = this.principal(auth);
    // Support agents can act, but reading everyone ELSE's actions is a
    // separate and higher privilege — an audit log a junior agent can browse
    // is a list of which colleagues to imitate.
    if (p.role !== 'super_admin' && p.role !== 'ops_manager' && p.role !== 'finance') {
      throw new ForbiddenError('Only a senior administrator may read the audit log');
    }
    const limit = Math.min(Number(q.limit ?? 50), 200);
    return { entries: await this.metrics.recentAudit(limit) };
  }

  /**
   * Perform an audited administrative action.
   *
   * One endpoint rather than twenty, because the interesting logic is
   * identical every time: authorise, require a reason, mutate, record. The
   * `action` names the operation and the ability gate decides.
   */
  @Post('actions')
  async act(
    @Body() body: any, @Req() req: any,
    @Headers('authorization') auth?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const principal = this.principal(auth);
    // NOT 'ability' or 'subject'. Those are DERIVED from the action below.
    // Accepting them from the body let a read_only admin authorise a refund
    // by naming a harmless permission next to it.
    requireFields(body, ['action', 'entityType', 'entityId']);

    // The permission is decided by the server, from the action name.
    let permission;
    try {
      permission = permissionFor(String(body.action));
    } catch {
      // An unregistered action is refused rather than defaulted: a new
      // action must be a deliberate entry in the table, not something that
      // inherits whatever happens to be permissive.
      throw new ValidationError({
        action: [`unknown action: ${String(body.action)}`],
      });
    }

    // Surface the requirement BEFORE attempting anything, so the UI can
    // show the reason box rather than bouncing the admin off an error.
    if (REASON_REQUIRED_ACTIONS.has(body.action)
        && (body.reason ?? '').trim().length < MIN_REASON_LENGTH) {
      throw new ValidationError({
        reason: [`a reason of at least ${MIN_REASON_LENGTH} characters is required `
          + `for ${body.action}`],
      });
    }

    const result = await this.runner.run(
      {
        principal,
        action: String(body.action),
        ability: permission.ability,
        subject: permission.subject,
        entityType: String(body.entityType),
        entityId: String(body.entityId),
        ...(body.record ? { record: body.record } : {}),
        ...(body.reason ? { reason: String(body.reason) } : {}),
        ...(body.amountPesewas !== undefined
          ? { amountPesewas: BigInt(body.amountPesewas) } : {}),
        ip: req?.headers?.['x-client-ip'] ?? req?.ip,
        ...(userAgent ? { userAgent } : {}),
        ...(req?.correlationId ? { correlationId: req.correlationId } : {}),
      },
      // The actual mutation belongs to the owning service; admin-svc
      // records the decision and lets the caller carry it out. Keeping the
      // audit write and the mutation separate is a deliberate trade: we
      // would rather log an action that failed than perform one silently.
      async () => ({ result: { recorded: true } }),
    );

    return { action: body.action, entityId: body.entityId, ...result };
  }

  /** Queue a task for manual resolution. */
  @Post('tasks')
  async createTask(@Body() body: any, @Headers('authorization') auth?: string) {
    this.principal(auth);
    requireFields(body, ['kind', 'entityType', 'entityId']);

    if (!(body.kind in TASK_PRIORITY)) {
      throw new ValidationError({
        kind: [`must be one of ${Object.keys(TASK_PRIORITY).join(', ')}`],
      });
    }
    return buildTask({
      kind: body.kind as TaskKind,
      entityType: String(body.entityType),
      entityId: String(body.entityId),
      ...(body.amountPesewas !== undefined
        ? { amountPesewas: BigInt(body.amountPesewas) } : {}),
    });
  }

  /** Priorities, so the queue UI sorts the same way the backend does. */
  @Get('tasks/priorities')
  priorities(@Headers('authorization') auth?: string) {
    this.principal(auth);
    return { priorities: TASK_PRIORITY };
  }
}

/* ------------------------------------------------------------------ */

export interface AdminDeps {
  pool?: Pool | null;
  sink?: AuditSink;
  metrics?: MetricsSource;
  verifyToken?: VerifyToken;
}

@Module({})
export class AdminHttpModule {
  static forRoot(deps: AdminDeps = {}): DynamicModule {
    const pool = deps.pool ?? null;
    const sink = deps.sink ?? (pool ? new PgAuditSink(pool) : new InMemoryAuditSink());

    return {
      module: AdminHttpModule,
      imports: [HealthModule.forRoot(pool)],
      controllers: [AdminController],
      providers: [
        { provide: AUDIT_SINK, useValue: sink },
        { provide: RUNNER, useValue: new AuditedActionRunner(sink) },
        { provide: METRICS_SOURCE, useValue: deps.metrics ?? new InMemoryMetricsSource() },
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
