/**
 * Admin BFF. PDF §14, MASTER_PLAN §3.1.
 *
 * Serves the Next.js dashboard. Two responsibilities beyond composition:
 *
 *   1. Every mutation is wrapped in the audited-action runner, so
 *      authorisation, the reason requirement and the audit row are enforced
 *      here rather than trusted to the UI.
 *   2. Zone scoping is applied to LIST queries, not just to individual
 *      records. A dispatcher scoped to Osu must not receive Kumasi orders in
 *      a page of results and have them hidden client-side.
 */

import { add, formatCedis, type Pesewas } from '../../../libs/money/src/money.ts';
import { can, type Principal } from '../../../libs/auth/src/abilities.ts';
import { ForbiddenError, NotFoundError } from '../../../libs/platform/src/errors.ts';
import {
  AuditedActionRunner, evaluateAlarms, type AuditSink, type DashboardMetrics,
} from '../../svc-admin/src/audit.ts';

/* ------------------------------------------------------------------ */
/* Upstream ports                                                      */
/* ------------------------------------------------------------------ */

export interface AdminOrderRow {
  id: string;
  humanRef: string;
  service: string;
  state: string;
  zone: string;
  storeName: string | null;
  riderName: string | null;
  totalPesewas: string;
  createdAt: string;
}

export interface AdminOrderClient {
  list(filter: {
    states?: string[]; zones?: string[]; service?: string; limit: number;
  }): Promise<AdminOrderRow[]>;
  get(orderId: string): Promise<AdminOrderRow | null>;
  forceCancel(orderId: string, reason: string): Promise<void>;
}

export interface MetricsClient {
  today(zones?: string[]): Promise<Omit<DashboardMetrics, 'ledgerHealthy'>>;
  ledgerDrift(): Promise<Pesewas>;
}

export interface ApprovalClient {
  pendingVendors(): Promise<Array<{ id: string; name: string; submittedAt: string }>>;
  pendingRiders(): Promise<Array<{ id: string; name: string; vehicle: string; submittedAt: string }>>;
  approveVendor(id: string, adminId: string): Promise<void>;
  rejectVendor(id: string, adminId: string, reason: string): Promise<void>;
}

export interface TaskClient {
  open(limit: number): Promise<Array<{
    id: string; kind: string; entityType: string; entityId: string;
    amountPesewas: string | null; priority: number; createdAt: string;
  }>>;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface AdminDashboard {
  scope: 'national' | 'zoned';
  zones: string[];
  metrics: {
    orders: number;
    revenueDisplay: string;
    activeRiders: number;
    activeVendors: number;
    cancellationRate: string;
    unremittedCodDisplay: string;
    openTasks: number;
    ledgerHealthy: boolean;
  };
  alarms: Array<{ severity: string; code: string; message: string }>;
  recentOrders: AdminOrderRow[];
  /** Only shown to roles that can act on them. */
  pendingApprovals: { vendors: number; riders: number } | null;
  taskQueue: Array<{ id: string; kind: string; amountDisplay: string | null; priority: number }>;
}

export class AdminBff {
  private readonly runner: AuditedActionRunner;

  constructor(
    private readonly orders: AdminOrderClient,
    private readonly metrics: MetricsClient,
    private readonly approvals: ApprovalClient,
    private readonly tasks: TaskClient,
    auditSink: AuditSink,
  ) {
    this.runner = new AuditedActionRunner(auditSink);
  }

  /** Zone filter derived from the principal — never from the request. */
  private scopeZones(p: Principal): string[] | undefined {
    return p.zones?.length ? p.zones : undefined;
  }

  async dashboard(principal: Principal): Promise<AdminDashboard> {
    if (!can(principal, 'read', 'Report') && !can(principal, 'read', 'Order')) {
      throw new ForbiddenError('You do not have dashboard access');
    }
    const zones = this.scopeZones(principal);

    const [raw, drift, recent, tasks] = await Promise.all([
      this.metrics.today(zones).catch(() => ({
        ordersToday: 0, revenuePesewas: 0n, activeRiders: 0, activeVendors: 0,
        cancellationRatePct: 0, unremittedCodPesewas: 0n, openTasks: 0,
      })),
      this.metrics.ledgerDrift().catch(() => 0n),
      this.orders.list({ ...(zones ? { zones } : {}), limit: 10 }).catch(() => []),
      can(principal, 'read', 'Payment')
        ? this.tasks.open(10).catch(() => [])
        : Promise.resolve([]),
    ]);

    const full: DashboardMetrics = { ...raw, ledgerHealthy: drift === 0n };

    // Approvals are only surfaced to roles that can actually act on them —
    // showing a count someone cannot clear is noise.
    const canApprove = can(principal, 'approve', 'Vendor');
    const pending = canApprove
      ? await Promise.all([this.approvals.pendingVendors(), this.approvals.pendingRiders()])
          .then(([v, r]) => ({ vendors: v.length, riders: r.length }))
          .catch(() => ({ vendors: 0, riders: 0 }))
      : null;

    return {
      scope: zones ? 'zoned' : 'national',
      zones: zones ?? [],
      metrics: {
        orders: full.ordersToday,
        revenueDisplay: formatCedis(full.revenuePesewas),
        activeRiders: full.activeRiders,
        activeVendors: full.activeVendors,
        cancellationRate: `${full.cancellationRatePct.toFixed(1)}%`,
        unremittedCodDisplay: formatCedis(full.unremittedCodPesewas),
        openTasks: full.openTasks,
        ledgerHealthy: full.ledgerHealthy,
      },
      alarms: evaluateAlarms(full),
      recentOrders: recent,
      pendingApprovals: pending,
      taskQueue: tasks.map((t) => ({
        id: t.id, kind: t.kind, priority: t.priority,
        amountDisplay: t.amountPesewas ? formatCedis(BigInt(t.amountPesewas)) : null,
      })),
    };
  }

  /**
   * Order list. The zone filter is applied UPSTREAM, so out-of-scope rows
   * never reach the client in the first place.
   */
  async orderList(
    principal: Principal,
    filter: { states?: string[]; service?: string; limit?: number } = {},
  ): Promise<AdminOrderRow[]> {
    if (!can(principal, 'read', 'Order')) throw new ForbiddenError('No access to orders');
    const zones = this.scopeZones(principal);
    return this.orders.list({
      ...(filter.states ? { states: filter.states } : {}),
      ...(filter.service ? { service: filter.service } : {}),
      ...(zones ? { zones } : {}),
      limit: Math.min(filter.limit ?? 50, 200),
    });
  }

  async orderDetail(principal: Principal, orderId: string): Promise<AdminOrderRow> {
    const order = await this.orders.get(orderId);
    if (!order) throw new NotFoundError('Order');
    if (!can(principal, 'read', 'Order', { zone: order.zone })) {
      throw new ForbiddenError('This order is outside your zone');
    }
    return order;
  }

  /* ---------------- audited mutations ---------------- */

  async forceCancelOrder(
    principal: Principal, orderId: string, reason: string,
    ctx: { ip?: string; correlationId?: string } = {},
  ): Promise<void> {
    const order = await this.orders.get(orderId);
    if (!order) throw new NotFoundError('Order');

    await this.runner.run({
      principal,
      action: 'order.force_cancel',
      ability: 'update', subject: 'Order',
      entityType: 'Order', entityId: orderId,
      record: { zone: order.zone },
      reason,
      amountPesewas: BigInt(order.totalPesewas),
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    }, async () => {
      await this.orders.forceCancel(orderId, reason);
      return {
        before: { state: order.state },
        after: { state: 'cancelled' },
        result: undefined,
      };
    });
  }

  async approveVendor(
    principal: Principal, vendorId: string,
    ctx: { ip?: string; correlationId?: string } = {},
  ): Promise<void> {
    await this.runner.run({
      principal,
      action: 'vendor.approve',
      ability: 'approve', subject: 'Vendor',
      entityType: 'Vendor', entityId: vendorId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    }, async () => {
      await this.approvals.approveVendor(vendorId, principal.id);
      return {
        before: { status: 'pending_review' },
        after: { status: 'approved' },
        result: undefined,
      };
    });
  }

  async rejectVendor(
    principal: Principal, vendorId: string, reason: string,
    ctx: { ip?: string; correlationId?: string } = {},
  ): Promise<void> {
    await this.runner.run({
      principal,
      action: 'vendor.reject',
      ability: 'approve', subject: 'Vendor',
      entityType: 'Vendor', entityId: vendorId,
      reason,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    }, async () => {
      await this.approvals.rejectVendor(vendorId, principal.id, reason);
      return {
        before: { status: 'pending_review' },
        after: { status: 'rejected', reason },
        result: undefined,
      };
    });
  }
}
