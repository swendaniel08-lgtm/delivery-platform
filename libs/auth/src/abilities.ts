/**
 * RBAC ability rules — the SAME definitions power the NestJS guards and the
 * Next.js admin UI, so backend and frontend can never disagree about
 * permissions. MASTER_PLAN §1.1 (admin RBAC) and §3.1.
 *
 * Deliberately framework-free so `web-admin` can import it directly.
 */

export type Action = 'create' | 'read' | 'update' | 'delete' | 'approve' | 'suspend' | 'refund' | 'payout' | 'manage';

export type Subject =
  | 'Order' | 'Vendor' | 'Rider' | 'Customer' | 'Payment' | 'Ledger'
  | 'Payout' | 'Pricing' | 'Zone' | 'Report' | 'Setting' | 'AuditLog'
  | 'Catalogue' | 'Dispatch' | 'all';

export type AdminRole =
  | 'super_admin' | 'ops_manager' | 'dispatcher' | 'finance'
  | 'support' | 'catalogue_editor' | 'read_only';

export type PrincipalRole = AdminRole | 'customer' | 'vendor_owner' | 'vendor_staff' | 'rider';

export interface Rule {
  action: Action | Action[];
  subject: Subject | Subject[];
  /** Restricts the rule to matching records, e.g. { zone: 'accra-osu' }. */
  conditions?: Record<string, unknown>;
  inverted?: boolean;
  reason?: string;
}

export interface Principal {
  id: string;
  role: PrincipalRole;
  /** City/zone scoping for ops staff. */
  zones?: string[];
  vendorId?: string;
}

const ALL: Action[] = ['create', 'read', 'update', 'delete', 'approve', 'suspend', 'refund', 'payout', 'manage'];

export function rulesFor(p: Principal): Rule[] {
  switch (p.role) {
    case 'super_admin':
      return [{ action: 'manage', subject: 'all' }];

    case 'ops_manager':
      return [
        { action: ALL, subject: ['Order', 'Dispatch', 'Rider', 'Vendor', 'Customer'] },
        { action: ['read'], subject: ['Payment', 'Ledger', 'Report', 'AuditLog'] },
        { action: ['read', 'update'], subject: ['Pricing', 'Zone'] },
        { action: ['refund', 'payout'], subject: 'Payment', inverted: true,
          reason: 'Only finance may move money' },
      ];

    case 'dispatcher':
      return [
        // When zones are assigned, Order access is scoped to them; otherwise
        // the dispatcher is national. Order is NOT granted unscoped here —
        // an unscoped grant would silently override the zone restriction.
        p.zones?.length
          ? { action: ['read', 'update'] as Action[], subject: 'Order' as Subject,
              conditions: { zone: { $in: p.zones } } }
          : { action: ['read', 'update'] as Action[], subject: 'Order' as Subject },
        { action: ['read', 'update'], subject: 'Dispatch' },
        { action: ['read'], subject: ['Rider', 'Vendor', 'Customer'] },
        { action: ['suspend'], subject: 'Rider' },
      ];

    case 'finance':
      return [
        { action: ['read', 'refund', 'payout'], subject: ['Payment', 'Ledger', 'Payout'] },
        { action: ['read'], subject: ['Order', 'Vendor', 'Rider', 'Report', 'AuditLog'] },
        { action: ['update', 'delete'], subject: 'Ledger', inverted: true,
          reason: 'The ledger is append-only; post a reversing entry instead' },
      ];

    case 'support':
      return [
        { action: ['read'], subject: ['Order', 'Customer', 'Vendor', 'Rider', 'Payment'] },
        { action: ['update'], subject: 'Order' },
        { action: ['read'], subject: 'Ledger' },
        { action: ['refund'], subject: 'Payment', inverted: true,
          reason: 'Support must escalate refunds to finance' },
      ];

    case 'catalogue_editor':
      return [
        { action: ALL, subject: 'Catalogue' },
        { action: ['read', 'update', 'approve'], subject: 'Vendor' },
        { action: ['read'], subject: 'Order' },
      ];

    case 'read_only':
      return [{ action: ['read'], subject: ['Order', 'Vendor', 'Rider', 'Customer', 'Report'] }];

    /* ---- app principals ---- */
    case 'customer':
      return [
        { action: ['create', 'read'], subject: 'Order', conditions: { customerId: p.id } },
        { action: ['read'], subject: 'Catalogue' },
        { action: ['read'], subject: 'Payment', conditions: { customerId: p.id } },
      ];

    case 'vendor_owner':
      return [
        { action: ['read', 'update'], subject: 'Order', conditions: { vendorId: p.vendorId } },
        { action: 'manage', subject: 'Catalogue', conditions: { vendorId: p.vendorId } },
        { action: ['read'], subject: 'Payment', conditions: { vendorId: p.vendorId } },
        { action: ['read', 'update'], subject: 'Vendor', conditions: { id: p.vendorId } },
      ];

    case 'vendor_staff':
      return [
        { action: ['read', 'update'], subject: 'Order', conditions: { vendorId: p.vendorId } },
        { action: ['read', 'update'], subject: 'Catalogue', conditions: { vendorId: p.vendorId } },
      ];

    case 'rider':
      return [
        { action: ['read', 'update'], subject: 'Order', conditions: { riderId: p.id } },
        { action: ['read'], subject: 'Dispatch' },
        { action: ['read'], subject: 'Payment', conditions: { riderId: p.id } },
      ];
  }
}

/** Minimal evaluator — no CASL dependency needed for the check itself. */
export function can(p: Principal, action: Action, subject: Subject, record?: Record<string, unknown>): boolean {
  const rules = rulesFor(p);
  let allowed = false;
  for (const rule of rules) {
    const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
    const subjects = Array.isArray(rule.subject) ? rule.subject : [rule.subject];
    const actionMatch = actions.includes(action) || actions.includes('manage');
    const subjectMatch = subjects.includes(subject) || subjects.includes('all');
    if (!actionMatch || !subjectMatch) continue;
    if (rule.conditions && record && !matches(rule.conditions, record)) continue;
    if (rule.inverted) return false; // explicit deny always wins
    allowed = true;
  }
  return allowed;
}

function matches(conditions: Record<string, unknown>, record: Record<string, unknown>): boolean {
  return Object.entries(conditions).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === 'object' && '$in' in (expected as object)) {
      const list = (expected as { $in: unknown[] }).$in;
      return list.includes(actual);
    }
    return actual === expected;
  });
}
