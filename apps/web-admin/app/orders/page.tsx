import { fetchOrders, AdminApiError } from '../../lib/api';
import { getSession } from '../../lib/session';
import { formatState } from '../../lib/format';
import { ErrorPanel, EmptyState, SignInPrompt } from '../_components/states';

/**
 * Order search.
 *
 * There is no "all orders" view, and that is on purpose: bff-admin requires a
 * customerId or storeId because an unbounded scan across every order on the
 * platform is how an admin screen takes down order-svc at dinner time. The
 * page therefore opens as a search form, not a table.
 */
export const dynamic = 'force-dynamic';

export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; storeId?: string; states?: string }>;
}) {
  const session = await getSession();
  if (!session) return <SignInPrompt />;

  const params = await searchParams;
  const hasFilter = Boolean(params.customerId || params.storeId);

  return (
    <>
      <h1>Orders</h1>
      <SearchForm params={params} />
      {hasFilter
        ? <Results token={session.token} params={params} />
        : (
          <EmptyState message={
            'Search by customer or store. There is no unfiltered listing — '
            + 'scanning every order on the platform would put real load on '
            + 'order-svc at exactly the times it is busiest.'
          } />
        )}
    </>
  );
}

function SearchForm({ params }: { params: { customerId?: string; storeId?: string } }) {
  return (
    <form method="get" style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
      <input
        name="customerId"
        placeholder="Customer ID"
        defaultValue={params.customerId ?? ''}
        style={inputStyle}
      />
      <input
        name="storeId"
        placeholder="Store ID"
        defaultValue={params.storeId ?? ''}
        style={inputStyle}
      />
      <button type="submit" style={buttonStyle}>Search</button>
    </form>
  );
}

async function Results({
  token, params,
}: {
  token: string;
  params: { customerId?: string; storeId?: string; states?: string };
}) {
  let orders;
  try {
    ({ orders } = await fetchOrders(token, params));
  } catch (err) {
    const e = err as AdminApiError;
    return <ErrorPanel title="Could not load orders." detail={e.userMessage ?? String(e)} />;
  }

  if (orders.length === 0) {
    return <EmptyState message="No orders matched that search." />;
  }

  return (
    <>
      <p className="sub">{orders.length} order{orders.length === 1 ? '' : 's'}</p>
      <table>
        <thead>
          <tr>
            <th>Ref</th><th>Service</th><th>Status</th>
            <th>Payment</th><th>Placed</th><th>Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="mono">{o.humanRef}</td>
              <td><span className="pill">{o.service}</span></td>
              <td>{formatState(o.state)}</td>
              {/* COD is called out: it is the one that carries cash risk. */}
              <td>{o.isCod ? <span className="pill">COD</span> : 'Prepaid'}</td>
              <td>{new Date(o.placedAt).toLocaleString('en-GB')}</td>
              {/* Server-formatted; the dashboard never re-derives money. */}
              <td className="mono">{o.totalDisplay}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--panel, #14161a)',
  border: '1px solid var(--line, #2a2f37)',
  borderRadius: 6,
  color: 'inherit',
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  fontWeight: 600,
};
