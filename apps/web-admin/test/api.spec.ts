/**
 * web-admin API client specs.
 *
 * Every page in this dashboard used to render hard-coded numbers. The failure
 * that mattered was not "the fetch is missing" — it was that nothing could
 * tell you it was missing. `revenuePesewas: 1_240_000n` looked exactly as
 * real as a live figure.
 *
 * So these specs pin the two things that keep that from coming back:
 *
 *   1. The client is typed and parsed against the ACTUAL bff-admin wire
 *      (`revenueDisplay`, a preformatted string — NOT `revenuePesewas`).
 *   2. A failure surfaces as a failure. There are no empty-array fallbacks
 *      that a tired operator would read as "a quiet night".
 *
 * The module reads env at import time and uses `server-only`, so it is loaded
 * dynamically after the environment is arranged.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/* `server-only` throws outside a React Server Component; stub it. */
const require_ = Module.prototype.require as any;
(Module.prototype as any).require = function (id: string) {
  if (id === 'server-only') return {};
  return require_.apply(this, arguments as any);
};

process.env.ADMIN_API_TIMEOUT_MS = '400';

let api: typeof import('../lib/api');

before(async () => { api = await import('../lib/api.ts'); });

/**
 * A stand-in bff-admin on an EPHEMERAL port.
 *
 * An earlier version pinned one port for every test. Closing a listener does
 * not release the port instantly, so consecutive tests intermittently bound
 * to a socket the previous one was still shutting down and the suite failed
 * about one run in three. Letting the OS allocate (`port 0`) removes the
 * class of bug rather than adding a sleep.
 */
async function withServer(
  handler: (req: any, res: any) => void,
  body: (base: string) => Promise<void>,
) {
  const http = await import('node:http');
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}`;
  const previous = process.env.ADMIN_API_URL;
  process.env.ADMIN_API_URL = base;
  try { await body(base); }
  finally {
    if (previous === undefined) delete process.env.ADMIN_API_URL;
    else process.env.ADMIN_API_URL = previous;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const json = (res: any, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

/** The dashboard payload bff-admin really returns — captured from a live run. */
const REAL_DASHBOARD = {
  metrics: {
    ordersToday: 234,
    revenueDisplay: 'GHS 12,400.00',
    activeRiders: 47,
    activeVendors: 156,
    cancellationRatePct: 4,
    unremittedCodDisplay: 'GHS 2,300.00',
    openTasks: 3,
    ledgerHealthy: true,
  },
  alarms: [],
  payoutsHalted: false,
};

/* ------------------------------------------------------------------ */

describe('dashboard', () => {
  test('parses the REAL bff-admin shape', async () => {
    await withServer(
      (req, res) => json(res, 200, REAL_DASHBOARD),
      async () => {
        const d = await api.fetchDashboard('tok');
        // The server preformats money. The dashboard must never re-derive it:
        // two formatters for one number is two answers for one number.
        assert.equal(d.metrics!.revenueDisplay, 'GHS 12,400.00');
        assert.equal(d.metrics!.ordersToday, 234);
        assert.equal(d.payoutsHalted, false);
      },
    );
  });

  test('sends the bearer token', async () => {
    let seen: string | undefined;
    await withServer(
      (req, res) => { seen = req.headers.authorization; json(res, 200, REAL_DASHBOARD); },
      async () => { await api.fetchDashboard('tok-abc'); },
    );
    assert.equal(seen, 'Bearer tok-abc');
  });

  test('never caches — a stale COD figure is one someone chases a rider over', async () => {
    let hits = 0;
    await withServer(
      (req, res) => { hits++; json(res, 200, REAL_DASHBOARD); },
      async () => {
        await api.fetchDashboard('tok');
        await api.fetchDashboard('tok');
      },
    );
    assert.equal(hits, 2);
  });

  test('metrics:null survives — the BFF degrades rather than 500s', async () => {
    // admin-svc is down but the BFF still answers. The page must be able to
    // tell "no data" apart from "zero".
    await withServer(
      (req, res) => json(res, 200, {
        metrics: null, alarms: [], payoutsHalted: false, degraded: ['admin'],
      }),
      async () => {
        const d = await api.fetchDashboard('tok');
        assert.equal(d.metrics, null);
        assert.deepEqual(d.degraded, ['admin']);
      },
    );
  });

  test('a ledger drift arrives with payoutsHalted set', async () => {
    await withServer(
      (req, res) => json(res, 200, {
        ...REAL_DASHBOARD,
        metrics: { ...REAL_DASHBOARD.metrics, ledgerHealthy: false },
        alarms: [{ code: 'ledger_drift', severity: 'critical', message: 'Ledger did not balance' }],
        payoutsHalted: true,
      }),
      async () => {
        const d = await api.fetchDashboard('tok');
        assert.equal(d.payoutsHalted, true);
        assert.equal(d.alarms[0]!.severity, 'critical');
      },
    );
  });
});

/* ------------------------------------------------------------------ */

describe('failures are shown, never faked', () => {
  test('a 500 THROWS rather than returning empty data', async () => {
    // The whole point. An operations dashboard that renders a quiet, empty
    // screen during an outage is actively dangerous.
    await withServer(
      (req, res) => json(res, 500, { title: 'Internal', detail: 'boom' }),
      async () => {
        await assert.rejects(() => api.fetchDashboard('tok'), (e: any) => {
          assert.equal(e.name, 'AdminApiError');
          assert.equal(e.status, 500);
          assert.match(e.userMessage, /unavailable right now/);
          return true;
        });
      },
    );
  });

  test('401 and 403 say different things to the operator', async () => {
    // "Sign in again" and "you may not see this" are different actions.
    await withServer(
      (req, res) => json(res, 401, {}),
      async () => {
        await assert.rejects(() => api.fetchDashboard('tok'),
          (e: any) => { assert.match(e.userMessage, /session has expired/); return true; });
      },
    );
    await withServer(
      (req, res) => json(res, 403, {}),
      async () => {
        await assert.rejects(() => api.fetchAudit('tok'),
          (e: any) => { assert.match(e.userMessage, /do not have permission/); return true; });
      },
    );
  });

  test('a hung upstream times out instead of hanging the page', async () => {
    await withServer(
      () => { /* never responds */ },
      async () => {
        const started = Date.now();
        await assert.rejects(() => api.fetchDashboard('tok'), (e: any) => {
          assert.equal(e.status, 0);
          assert.match(e.userMessage, /did not respond in time/);
          return true;
        });
        assert.ok(Date.now() - started < 3000, 'must give up near the deadline');
      },
    );
  });

  test('an RFC 7807 detail reaches the operator', async () => {
    await withServer(
      (req, res) => json(res, 400, {
        type: 'https://errors.besonc.app/validation',
        title: 'Validation failed',
        detail: 'search by customerId or storeId',
      }),
      async () => {
        await assert.rejects(() => api.fetchOrders('tok', {}),
          (e: any) => { assert.match(e.message, /customerId or storeId/); return true; });
      },
    );
  });

  test('a connection refusal is an error, not silence', async () => {
    // Nothing listening at all: port 1 is never a bff-admin.
    process.env.ADMIN_API_URL = 'http://127.0.0.1:1';
    await assert.rejects(() => api.fetchDashboard('tok'), (e: any) => {
      assert.equal(e.name, 'AdminApiError');
      return true;
    });
  });
});

/* ------------------------------------------------------------------ */

describe('orders', () => {
  test('passes the search filter through', async () => {
    let url = '';
    await withServer(
      (req, res) => { url = req.url; json(res, 200, { orders: [] }); },
      async () => {
        await api.fetchOrders('tok', { storeId: 'store-1', states: 'placed,preparing' });
      },
    );
    assert.match(url, /storeId=store-1/);
    assert.match(url, /states=placed%2Cpreparing/);
  });

  test('omits absent filters rather than sending empty ones', async () => {
    // `customerId=` is a real filter value to a query parser, and would match
    // nothing at all.
    let url = '';
    await withServer(
      (req, res) => { url = req.url; json(res, 200, { orders: [] }); },
      async () => { await api.fetchOrders('tok', { storeId: 's1' }); },
    );
    assert.ok(!url.includes('customerId'));
  });

  test('reads the server-formatted total, not a recomputed one', async () => {
    await withServer(
      (req, res) => json(res, 200, {
        orders: [{
          id: 'o1', humanRef: '#1234', state: 'in_transit', service: 'food',
          totalDisplay: 'GHS 81.50', totalPesewas: '8150', isCod: false,
          placedAt: '2026-07-26T18:00:00Z',
        }],
      }),
      async () => {
        const { orders } = await api.fetchOrders('tok', { storeId: 's1' });
        assert.equal(orders[0]!.totalDisplay, 'GHS 81.50');
        assert.equal(orders[0]!.totalPesewas, '8150');
      },
    );
  });
});

describe('audit', () => {
  test('requests a bounded number of entries', async () => {
    let url = '';
    await withServer(
      (req, res) => { url = req.url; json(res, 200, { entries: [] }); },
      async () => { await api.fetchAudit('tok', 100); },
    );
    assert.match(url, /limit=100/);
  });

  test('an entry with no reason is preserved as null, not blanked', async () => {
    // A money-moving action with no stated reason is the first thing an
    // auditor looks for. It must not be quietly rendered as an empty cell.
    await withServer(
      (req, res) => json(res, 200, {
        entries: [{
          id: '1', actorId: 'a1', actorRole: 'finance', action: 'payment.refund',
          entityType: 'Payment', entityId: 'pay-1', amountPesewas: '8150',
          reason: null, createdAt: '2026-07-26T11:42:00Z',
        }],
      }),
      async () => {
        const { entries } = await api.fetchAudit('tok');
        assert.equal(entries[0]!.reason, null);
        assert.equal(entries[0]!.amountPesewas, '8150');
      },
    );
  });
});
