/**
 * admin-bff HTTP surface.
 *
 * Feeds the Next.js dashboard, which has been rendering stubbed data. This
 * is what replaces the stubs.
 *
 * Unlike the three app BFFs, this one fans out to almost every service —
 * an operator's screen genuinely needs orders, money, riders and the audit
 * trail at once. Each region degrades independently: a payment outage must
 * not hide the order queue from the person trying to fix it.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Query, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError,
} from '../../../libs/platform/src/errors.ts';
import {
  ServiceClient, settleWithFallback,
} from '../../../libs/platform/src/http/service-client.ts';
import { formatCedis } from '../../../libs/money/src/money.ts';

export const UPSTREAMS = Symbol('ADMIN_UPSTREAMS');
export const VERIFY_TOKEN = Symbol('ADMIN_BFF_VERIFY_TOKEN');

export interface Claims { sub: string; role: string; zones?: string[] }
export type VerifyToken = (token: string) => Claims;

export interface AdminUpstreams {
  admin: ServiceClient;
  order: ServiceClient;
  payment: ServiceClient;
  catalogue: ServiceClient;
  identity: ServiceClient;
}

const STAFF_ROLES = new Set([
  'super_admin', 'ops_manager', 'dispatcher', 'finance',
  'support', 'catalogue_editor', 'read_only',
]);

/** Roles that may change anything at all. */
const MUTATING_ROLES = new Set([
  'super_admin', 'ops_manager', 'finance', 'support', 'catalogue_editor',
]);

function bearer(auth?: string): string {
  if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
  return auth.slice(7);
}

@Controller('api/admin')
export class AdminBffController {
  constructor(
    @Inject(UPSTREAMS) private readonly up: AdminUpstreams,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    const token = bearer(auth);
    let c: Claims;
    try { c = this.verify(token); }
    catch { throw new UnauthorizedError('Invalid token'); }
    if (!STAFF_ROLES.has(c.role)) throw new ForbiddenError('Staff only');
    return c;
  }

  /** The operations home screen, in one call. */
  @Get('dashboard')
  async dashboard(@Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    const opts = { bearerToken: token };

    const { values, degraded } = await settleWithFallback({
      dashboard: {
        run: () => this.up.admin.get('/admin/dashboard', opts),
        fallback: { metrics: null, alarms: [], payoutsHalted: false } as any,
      },
    });

    return {
      ...(values.dashboard as any),
      // Told plainly, because an operator acting on a partial dashboard
      // during an incident is how a small outage becomes a large one.
      ...(degraded.length ? { degraded } : {}),
    };
  }

  /** Order search across the platform. */
  @Get('orders')
  async orders(@Query() q: any, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);

    if (!q.customerId && !q.storeId) {
      throw new ValidationError({
        customerId: ['search by customerId or storeId'],
      });
    }
    const qs = new URLSearchParams();
    if (q.customerId) qs.set('customerId', String(q.customerId));
    if (q.storeId) qs.set('storeId', String(q.storeId));
    if (q.states) qs.set('states', String(q.states));

    const r = await this.up.order.get(`/orders?${qs}`, { bearerToken: token });
    return {
      orders: (r.orders ?? []).map((o: any) => ({
        id: o.id,
        humanRef: o.humanRef,
        state: o.state,
        service: o.service,
        totalDisplay: formatCedis(BigInt(o.totalPesewas ?? '0')),
        totalPesewas: o.totalPesewas,
        isCod: o.isCod,
        placedAt: o.placedAt,
      })),
    };
  }

  @Get('audit')
  async audit(@Query() q: any, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    return this.up.admin.get(
      `/admin/audit?limit=${Number(q.limit ?? 50)}`, { bearerToken: token },
    );
  }

  /**
   * Perform an audited action.
   *
   * `read_only` and `dispatcher` are refused here as well as in admin-svc.
   * Two checks for one rule is deliberate: the BFF gives a fast, clear
   * message, and the service enforces it for anyone who bypasses the BFF.
   */
  @Post('actions')
  async act(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);

    if (!MUTATING_ROLES.has(c.role)) {
      throw new ForbiddenError(`${c.role} has read-only access`);
    }
    return this.up.admin.post('/admin/actions', body, { bearerToken: token });
  }

  /** Approve or suspend a store. */
  @Post('stores/:id/status')
  async storeStatus(
    @Param('id') id: string, @Body() body: any,
    @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    const token = bearer(auth);
    if (!MUTATING_ROLES.has(c.role)) {
      throw new ForbiddenError(`${c.role} has read-only access`);
    }
    if (!body?.status) throw new ValidationError({ status: ['is required'] });

    // Record the decision FIRST. If the catalogue call then fails, we have
    // a log of an attempted change with no effect — recoverable. The other
    // order leaves a suspended vendor with no record of who suspended them.
    await this.up.admin.post('/admin/actions', {
      action: body.status === 'approved' ? 'vendor.approve' : 'vendor.suspend',
      ability: body.status === 'approved' ? 'approve' : 'suspend',
      subject: 'Vendor',
      entityType: 'Store',
      entityId: id,
      reason: body.reason,
    }, { bearerToken: token });

    return this.up.catalogue.patch(
      `/catalogue/manage/stores/${id}/status`,
      { status: body.status },
      { bearerToken: token },
    );
  }

  @Get('tasks/priorities')
  async priorities(@Headers('authorization') auth?: string) {
    this.claims(auth);
    return this.up.admin.get('/admin/tasks/priorities', { bearerToken: bearer(auth) });
  }
}

export interface AdminBffDeps {
  upstreams: AdminUpstreams;
  verifyToken?: VerifyToken;
}

@Module({})
export class AdminBffHttpModule {
  static forRoot(deps: AdminBffDeps): DynamicModule {
    return {
      module: AdminBffHttpModule,
      imports: [HealthModule.forRoot(null)],
      controllers: [AdminBffController],
      providers: [
        { provide: UPSTREAMS, useValue: deps.upstreams },
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
