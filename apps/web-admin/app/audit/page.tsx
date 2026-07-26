import { fetchAudit, AdminApiError } from '../../lib/api';
import { getSession } from '../../lib/session';
import { formatCedis } from '../../lib/format';
import { ErrorPanel, EmptyState, SignInPrompt } from '../_components/states';

/**
 * The audit trail.
 *
 * admin-svc restricts this to super_admin / ops_manager / finance — an audit
 * log a junior agent can browse is a list of which colleagues to imitate. The
 * 403 is rendered as a plain explanation rather than an error, because being
 * refused here is normal and not a fault.
 */
export const dynamic = 'force-dynamic';

export default async function Audit() {
  const session = await getSession();
  if (!session) return <SignInPrompt />;

  let entries;
  try {
    ({ entries } = await fetchAudit(session.token, 100));
  } catch (err) {
    const e = err as AdminApiError;
    return (
      <>
        <h1>Audit log</h1>
        {e.status === 403 ? (
          <EmptyState message={
            'Your role cannot read the audit log. Only a senior administrator '
            + '(super admin, operations manager or finance) may review the '
            + 'actions of other staff.'
          } />
        ) : (
          <ErrorPanel title="Could not load the audit log." detail={e.userMessage ?? String(e)} />
        )}
      </>
    );
  }

  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">
        Append-only. Entries can never be edited or deleted — including by the
        person who made them.
      </p>

      {entries.length === 0 ? (
        <EmptyState message="No administrative actions have been recorded yet." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Actor</th><th>Action</th>
              <th>Entity</th><th>Amount</th><th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((r) => (
              <tr key={r.id}>
                <td className="mono">{new Date(r.createdAt).toLocaleString('en-GB')}</td>
                <td><span className="pill">{r.actorRole}</span></td>
                <td className="mono">{r.action}</td>
                <td className="mono">{r.entityType}/{r.entityId}</td>
                <td className="mono">
                  {r.amountPesewas ? formatCedis(r.amountPesewas) : '—'}
                </td>
                {/* A money-moving action with no reason is the thing an
                    auditor looks for first, so absence is shown, not hidden. */}
                <td>{r.reason ?? <span className="sub">no reason given</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
