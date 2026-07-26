/**
 * The admin dashboard's only door to the backend.
 *
 * Every page was rendering hard-coded numbers. That is worse than an empty
 * screen: an operator cannot tell a stub from a real figure, and "revenue
 * GHS 12,400" that never changes is a number someone will eventually act on.
 *
 * Three rules this module exists to enforce:
 *
 *   1. **The types mirror the WIRE, not our wishes.** bff-admin sends
 *      `revenueDisplay: "GHS 12,400.00"` — a preformatted string — not
 *      `revenuePesewas`. The pages previously assumed the latter. Typing the
 *      response honestly is what makes that mismatch a compile error instead
 *      of `NaN` on an operations screen.
 *   2. **A failure is shown, never faked.** No empty-array fallbacks that
 *      look like "a quiet day". During an incident, a dashboard that
 *      cheerfully reports zero orders is actively dangerous.
 *   3. **All calls go through bff-admin.** The gateway is the only published
 *      port; the dashboard has no business talking to nine services.
 */

import 'server-only';

/**
 * Read per call, not once at import.
 *
 * A module-level constant is captured before the process environment is
 * necessarily complete, and it makes the base URL impossible to vary between
 * requests — which matters for tests and for any future per-region routing.
 * The cost is one property read per call.
 */
function baseUrl(): string {
  return process.env.ADMIN_API_URL ?? 'http://127.0.0.1:3104';
}

/** Server-side deadline. A hung upstream must not hang the whole page. */
function timeoutMs(): number {
  return Number(process.env.ADMIN_API_TIMEOUT_MS ?? 6000);
}

/* ------------------------------------------------------------------ */
/* Wire types — these match bff-admin exactly. Do not "improve" them.  */
/* ------------------------------------------------------------------ */

export interface DashboardMetricsWire {
  ordersToday: number;
  /** Preformatted by the server: "GHS 12,400.00". */
  revenueDisplay: string;
  activeRiders: number;
  activeVendors: number;
  cancellationRatePct: number;
  unremittedCodDisplay: string;
  openTasks: number;
  ledgerHealthy: boolean;
}

export interface Alarm {
  code: string;
  severity: 'warning' | 'critical';
  message: string;
}

export interface DashboardWire {
  /** null when admin-svc is unreachable — the BFF degrades rather than 500s. */
  metrics: DashboardMetricsWire | null;
  alarms: Alarm[];
  payoutsHalted: boolean;
  /** Names the upstreams that did not answer. Present only when degraded. */
  degraded?: string[];
}

export interface OrderWire {
  id: string;
  humanRef: string;
  state: string;
  service: string;
  totalDisplay: string;
  totalPesewas: string;
  isCod: boolean;
  placedAt: string;
}

export interface AuditEntryWire {
  id: string;
  actorId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  amountPesewas: string | null;
  reason: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */

/**
 * A failed call, carrying enough detail for the page to say something true.
 *
 * `status` is preserved because 403 and 503 mean very different things to an
 * operator: one is "you may not see this", the other is "we cannot see this
 * right now".
 */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }

  /** What to put on the screen. Never leaks an upstream stack trace. */
  get userMessage(): string {
    if (this.status === 401) return 'Your session has expired. Sign in again.';
    if (this.status === 403) return 'You do not have permission to view this.';
    if (this.status === 0) return 'The admin API did not respond in time.';
    if (this.status >= 500) return 'The admin API is unavailable right now.';
    return this.message;
  }
}

async function get<T>(path: string, token: string): Promise<T> {
  const deadline = timeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
      // Operations data is never cacheable. A stale "unremitted COD" figure
      // is a figure someone will chase a rider over.
      cache: 'no-store',
    });
  } catch (err) {
    const e = err as Error;
    throw new AdminApiError(
      0, path,
      e.name === 'AbortError' ? `timed out after ${deadline}ms` : e.message,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The BFF speaks RFC 7807; use its detail when there is one.
    const body = await res.json().catch(() => ({} as any));
    throw new AdminApiError(
      res.status, path,
      body?.detail ?? body?.title ?? `HTTP ${res.status}`,
    );
  }

  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export function fetchDashboard(token: string): Promise<DashboardWire> {
  return get<DashboardWire>('/api/admin/dashboard', token);
}

/**
 * Order search.
 *
 * bff-admin REQUIRES a customerId or storeId — deliberately, because an
 * unbounded "show me every order" scan across the platform is how an admin
 * screen takes down the order service at dinner time.
 */
export function fetchOrders(
  token: string,
  filter: { customerId?: string; storeId?: string; states?: string },
): Promise<{ orders: OrderWire[] }> {
  const qs = new URLSearchParams();
  if (filter.customerId) qs.set('customerId', filter.customerId);
  if (filter.storeId) qs.set('storeId', filter.storeId);
  if (filter.states) qs.set('states', filter.states);
  return get<{ orders: OrderWire[] }>(`/api/admin/orders?${qs}`, token);
}

export function fetchAudit(
  token: string, limit = 50,
): Promise<{ entries: AuditEntryWire[] }> {
  return get<{ entries: AuditEntryWire[] }>(`/api/admin/audit?limit=${limit}`, token);
}
