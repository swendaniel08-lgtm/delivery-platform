import { fetchDashboard, AdminApiError } from '../../lib/api';
import { getSession } from '../../lib/session';
import { ErrorPanel, DegradedBanner, SignInPrompt } from '../_components/states';

/**
 * The operations home screen.
 *
 * Note what is NOT here any more: alarm evaluation. It used to run in the
 * browser tier against locally-held metrics, which meant the dashboard could
 * disagree with the backend about whether the ledger had drifted. The server
 * decides; this renders the decision.
 */
export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const session = await getSession();
  if (!session) return <SignInPrompt />;

  let data;
  try {
    data = await fetchDashboard(session.token);
  } catch (err) {
    const e = err as AdminApiError;
    return (
      <>
        <h1>Today&rsquo;s overview</h1>
        <ErrorPanel
          title="Could not load the dashboard."
          detail={e.userMessage ?? String(e)}
        />
      </>
    );
  }

  const { metrics, alarms, payoutsHalted, degraded } = data;

  return (
    <>
      <h1>Today&rsquo;s overview</h1>
      <p className="sub">Accra — all zones</p>

      {degraded?.length ? <DegradedBanner upstreams={degraded} /> : null}

      {payoutsHalted && (
        <div className="alarm critical" role="alert">
          <strong>Payouts are halted.</strong> The ledger did not balance on the
          last reconciliation. No vendor or rider payout will be released until
          it does.
        </div>
      )}

      {alarms.map((a) => (
        <div key={a.code} className={`alarm ${a.severity}`} role="alert">
          <strong>{a.severity === 'critical' ? 'Critical' : 'Warning'}:</strong>{' '}
          {a.message}
        </div>
      ))}

      {metrics === null ? (
        <ErrorPanel
          title="Metrics unavailable."
          detail={
            'admin-svc did not answer, so there are no figures to show. This is '
            + 'deliberately blank rather than zero — a dashboard reading zero '
            + 'during an outage is how a small incident becomes a large one.'
          }
        />
      ) : (
        <div className="cards">
          <Card k="Orders" v={String(metrics.ordersToday)} />
          {/* Server-formatted. The dashboard must not re-derive money. */}
          <Card k="Revenue" v={metrics.revenueDisplay} />
          <Card k="Active riders" v={String(metrics.activeRiders)} />
          <Card k="Vendors" v={String(metrics.activeVendors)} />
          <Card k="Cancellation rate" v={`${metrics.cancellationRatePct.toFixed(1)}%`} />
          <Card k="Unremitted COD" v={metrics.unremittedCodDisplay} />
          <Card k="Open tasks" v={String(metrics.openTasks)} />
          <Card k="Ledger" v={metrics.ledgerHealthy ? 'Balanced' : 'DRIFT'} />
        </div>
      )}
    </>
  );
}

function Card({ k, v }: { k: string; v: string }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v mono">{v}</div>
    </div>
  );
}
