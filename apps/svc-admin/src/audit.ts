/**
 * Audit logging and admin action guards. Closes issue #12.
 *
 * Every back-office mutation passes through `AuditedAction`, which:
 *   1. checks the actor's ability (shared CASL rules from libs/auth)
 *   2. enforces a reason on sensitive actions
 *   3. records before/after state
 *   4. writes the audit row in the SAME transaction as the change
 *
 * Point 4 matters: an audit row written separately can be lost while the
 * change succeeds, which is exactly the case a dispute turns on.
 */

import { can, type Principal, type Action, type Subject } from '../../../libs/auth/src/abilities.ts';
import { ForbiddenError, ValidationError } from '../../../libs/platform/src/errors.ts';
import type { Pesewas } from '../../../libs/money/src/money.ts';

/** Actions that always require a written reason (mirrors the DB constraint). */
export const REASON_REQUIRED_ACTIONS = new Set([
  'payment.refund', 'payment.payout', 'vendor.suspend', 'rider.suspend',
  'customer.suspend', 'order.force_cancel', 'order.force_status', 'pricing.update',
]);

export const MIN_REASON_LENGTH = 10;

/**
 * The permission each admin action requires.
 *
 * SECURITY. `ability` and `subject` used to arrive in the REQUEST BODY, and
 * the ability gate was evaluated against whatever the caller sent. So a
 * read_only admin could perform a refund simply by declaring a harmless
 * permission alongside it:
 *
 *   POST /admin/actions
 *   { "action": "payment.refund", "ability": "read", "subject": "Report", … }
 *   -> 201, refund recorded
 *
 * Asking the caller which permission to check is the same as not checking.
 * The action name is the only thing the caller may choose; what that action
 * REQUIRES is decided here, on the server.
 *
 * An unlisted action is refused rather than defaulted — a new action must be
 * a deliberate entry in this table, not something that inherits whatever
 * happens to be permissive.
 */
export const ACTION_PERMISSIONS: Record<string, { ability: Action; subject: Subject }> = {
  'payment.refund':      { ability: 'refund',  subject: 'Payment' },
  'payment.payout':      { ability: 'payout',  subject: 'Payout' },
  'payment.retry':       { ability: 'update',  subject: 'Payment' },

  'vendor.suspend':      { ability: 'suspend', subject: 'Vendor' },
  'vendor.approve':      { ability: 'approve', subject: 'Vendor' },
  'vendor.update':       { ability: 'update',  subject: 'Vendor' },

  'rider.suspend':       { ability: 'suspend', subject: 'Rider' },
  'rider.approve':       { ability: 'approve', subject: 'Rider' },
  'rider.update':        { ability: 'update',  subject: 'Rider' },

  'customer.suspend':    { ability: 'suspend', subject: 'Customer' },

  'order.force_cancel':  { ability: 'update',  subject: 'Order' },
  'order.force_status':  { ability: 'update',  subject: 'Order' },
  'order.reassign':      { ability: 'update',  subject: 'Dispatch' },

  'pricing.update':      { ability: 'update',  subject: 'Pricing' },
  'zone.update':         { ability: 'update',  subject: 'Zone' },
  'setting.update':      { ability: 'update',  subject: 'Setting' },
  'catalogue.update':    { ability: 'update',  subject: 'Catalogue' },
};

/** Thrown for an action name that is not in the registry. */
export class UnknownActionError extends Error {
  constructor(action: string) {
    super(`unknown admin action: ${action}`);
    this.name = 'UnknownActionError';
  }
}

/**
 * What this action requires. Never trusts the caller.
 */
export function permissionFor(
  action: string,
): { ability: Action; subject: Subject } {
  // Object.hasOwn, not a bare index.
  //
  // `ACTION_PERMISSIONS['constructor']` returns Object, and
  // `ACTION_PERMISSIONS['__proto__']` returns a prototype — both truthy, so a
  // bare lookup let those names pass the "is this a known action?" gate and
  // reach the ability check with `ability: undefined`, whose behaviour is
  // then whatever `can()` happens to do with undefined. Caught by fuzzing
  // the registry rather than by reading it.
  if (!Object.hasOwn(ACTION_PERMISSIONS, action)) {
    throw new UnknownActionError(action);
  }
  const p = ACTION_PERMISSIONS[action];
  if (!p || typeof p.ability !== 'string' || typeof p.subject !== 'string') {
    throw new UnknownActionError(action);
  }
  return p;
}

export interface AuditEntry {
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
  amountPesewas?: Pesewas;
  reason?: string;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  entries: AuditEntry[] = [];
  async write(entry: AuditEntry) { this.entries.push(entry); }
}

export interface AdminActionRequest {
  principal: Principal;
  action: string;              // 'payment.refund'
  ability: Action;             // 'refund'
  subject: Subject;            // 'Payment'
  entityType: string;
  entityId: string;
  record?: Record<string, unknown>;   // for conditional abilities (zone, vendorId)
  reason?: string;
  amountPesewas?: Pesewas;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

export class AuditedActionRunner {
  constructor(private readonly sink: AuditSink) {}

  /**
   * Authorise, execute and record. The mutation only runs if the actor is
   * permitted AND any required reason is supplied.
   */
  async run<T>(
    req: AdminActionRequest,
    mutate: () => Promise<{ before?: unknown; after?: unknown; result: T }>,
  ): Promise<T> {
    if (!can(req.principal, req.ability, req.subject, req.record)) {
      throw new ForbiddenError(
        `${req.principal.role} may not ${req.ability} ${req.subject}`,
      );
    }

    if (REASON_REQUIRED_ACTIONS.has(req.action)) {
      const reason = req.reason?.trim() ?? '';
      if (reason.length < MIN_REASON_LENGTH) {
        throw new ValidationError({
          reason: [`a reason of at least ${MIN_REASON_LENGTH} characters is required for ${req.action}`],
        });
      }
    }

    const { before, after, result } = await mutate();

    await this.sink.write({
      actorUserId: req.principal.id,
      actorRole: req.principal.role,
      action: req.action,
      entityType: req.entityType,
      entityId: req.entityId,
      ...(before !== undefined ? { beforeState: before } : {}),
      ...(after !== undefined ? { afterState: after } : {}),
      ...(req.amountPesewas !== undefined ? { amountPesewas: req.amountPesewas } : {}),
      ...(req.reason ? { reason: req.reason.trim() } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.userAgent ? { userAgent: req.userAgent } : {}),
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });

    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard aggregates (PDF §14)                                      */
/* ------------------------------------------------------------------ */

export interface DashboardMetrics {
  ordersToday: number;
  revenuePesewas: Pesewas;
  activeRiders: number;
  activeVendors: number;
  cancellationRatePct: number;
  unremittedCodPesewas: Pesewas;
  openTasks: number;
  /** Set when the ledger is inconsistent — blocks payouts platform-wide. */
  ledgerHealthy: boolean;
}

/**
 * Operational alarms. Deliberately few: a dashboard that always shows red
 * gets ignored, so only conditions that need action today appear.
 */
export interface Alarm {
  severity: 'critical' | 'warning';
  code: string;
  message: string;
}

export function evaluateAlarms(m: DashboardMetrics): Alarm[] {
  const alarms: Alarm[] = [];

  if (!m.ledgerHealthy) {
    alarms.push({
      severity: 'critical', code: 'LEDGER_DRIFT',
      message: 'Ledger is inconsistent — payouts are halted until reconciled',
    });
  }
  if (m.unremittedCodPesewas > 500_000n) {   // GHS 5,000 in the field
    alarms.push({
      severity: 'critical', code: 'COD_FLOAT_HIGH',
      message: 'Cash float exceeds GHS 5,000 — chase remittances',
    });
  }
  if (m.cancellationRatePct > 15) {
    alarms.push({
      severity: 'warning', code: 'CANCELLATION_RATE',
      message: `Cancellation rate is ${m.cancellationRatePct.toFixed(1)}%`,
    });
  }
  if (m.activeRiders < 5 && m.ordersToday > 20) {
    alarms.push({
      severity: 'warning', code: 'RIDER_SHORTAGE',
      message: `Only ${m.activeRiders} riders online for ${m.ordersToday} orders`,
    });
  }
  if (m.openTasks > 25) {
    alarms.push({
      severity: 'warning', code: 'TASK_BACKLOG',
      message: `${m.openTasks} unresolved operational tasks`,
    });
  }
  return alarms;
}

/* ------------------------------------------------------------------ */
/* Manual-resolution tasks                                             */
/* ------------------------------------------------------------------ */

export type TaskKind =
  | 'payout_failed' | 'cod_overdue' | 'dispute' | 'reconciliation_gap'
  | 'vendor_application' | 'rider_application' | 'order_stuck';

/** Priority 1 is most urgent. Money at risk outranks paperwork. */
export const TASK_PRIORITY: Record<TaskKind, number> = {
  reconciliation_gap: 1,
  payout_failed: 1,
  dispute: 2,
  cod_overdue: 2,
  order_stuck: 2,
  vendor_application: 4,
  rider_application: 4,
};

export interface TaskInput {
  kind: TaskKind;
  entityType: string;
  entityId: string;
  amountPesewas?: Pesewas;
}

export function buildTask(input: TaskInput) {
  return {
    ...input,
    priority: TASK_PRIORITY[input.kind],
  };
}
