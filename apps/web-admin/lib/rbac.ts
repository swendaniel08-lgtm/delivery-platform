/**
 * Server-side RBAC for the admin dashboard.
 *
 * Imports the SAME ability rules the backend enforces (libs/auth), so the UI
 * can never offer a button the API will reject — and, more importantly, a
 * hidden button is not the security boundary. Every server action re-checks.
 */
import { can, type Principal, type Action, type Subject } from '../../../libs/auth/src/abilities';

export type { Principal };

/** Guard for React Server Components and server actions. */
export function requireAbility(
  principal: Principal, action: Action, subject: Subject,
  record?: Record<string, unknown>,
): void {
  if (!can(principal, action, subject, record)) {
    throw new Error(`Forbidden: ${principal.role} cannot ${action} ${subject}`);
  }
}

export function ability(principal: Principal) {
  return {
    can: (action: Action, subject: Subject, record?: Record<string, unknown>) =>
      can(principal, action, subject, record),
  };
}

/** Nav items filtered by what the signed-in admin may actually see. */
export interface NavItem { href: string; label: string; action: Action; subject: Subject }

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', action: 'read', subject: 'Report' },
  { href: '/orders', label: 'Orders', action: 'read', subject: 'Order' },
  { href: '/vendors', label: 'Vendors', action: 'read', subject: 'Vendor' },
  { href: '/riders', label: 'Riders', action: 'read', subject: 'Rider' },
  { href: '/payments', label: 'Payments', action: 'read', subject: 'Payment' },
  { href: '/ledger', label: 'Ledger', action: 'read', subject: 'Ledger' },
  { href: '/pricing', label: 'Pricing', action: 'read', subject: 'Pricing' },
  { href: '/audit', label: 'Audit log', action: 'read', subject: 'AuditLog' },
];

export function visibleNav(principal: Principal): NavItem[] {
  return NAV.filter((item) => can(principal, item.action, item.subject));
}
