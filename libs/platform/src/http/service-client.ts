/**
 * Server-to-server HTTP client.
 *
 * BFFs fan out to several services to render one screen, so three things
 * matter more here than in a browser client:
 *
 *   1. **A timeout on every call.** One slow upstream must not hold a phone's
 *      connection open until it gives up. Without this a single degraded
 *      service takes the whole app down.
 *   2. **The correlation id travels.** A customer complaint has to be
 *      traceable across five services from one id in the logs.
 *   3. **Failures are typed.** A BFF decides per-call whether an upstream
 *      failure degrades the screen or fails it; it cannot do that if every
 *      error is an untyped `Error`.
 */

import { AppError, UpstreamError } from '../errors.ts';

export interface ServiceCallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Forwarded so the upstream can authorise the END USER, not the BFF. */
  bearerToken?: string;
  correlationId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface ServiceClientConfig {
  baseUrl: string;
  /** Named for error messages and metrics, e.g. 'catalogue-svc'. */
  name: string;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The default budget. Deliberately short: a BFF has its own deadline with the
 * phone, and spending it all on one upstream leaves nothing for the others.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;

export class ServiceClient {
  constructor(private readonly cfg: ServiceClientConfig) {}

  get name(): string { return this.cfg.name; }

  async call<T = any>(path: string, opts: ServiceCallOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.defaultTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const doFetch = this.cfg.fetchImpl ?? fetch;

    // AbortController rather than Promise.race: race leaves the socket open
    // and the connection pool eventually starves.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await doFetch(`${this.cfg.baseUrl}${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
          ...(opts.correlationId ? { 'x-correlation-id': opts.correlationId } : {}),
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
          ...opts.headers,
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });

      const text = await res.text();
      const parsed = text ? safeJson(text) : {};

      if (!res.ok) {
        const detail = (parsed as any)?.detail ?? (parsed as any)?.title
          ?? `${this.cfg.name} returned ${res.status}`;

        // A 4xx from an upstream is the CLIENT's fault, not a gateway
        // failure, so it must keep its status. Collapsing "this
        // Idempotency-Key was already used" into a 502 tells the app to
        // retry a request that will never succeed.
        if (res.status >= 400 && res.status < 500) {
          throw new AppError(
            res.status,
            (parsed as any)?.type?.split('/').pop() ?? 'upstream-rejected',
            (parsed as any)?.title ?? 'Request rejected',
            detail,
            (parsed as any)?.errors ? { errors: (parsed as any).errors } : {},
          );
        }
        throw new UpstreamError(this.cfg.name, detail);
      }
      return parsed as T;
    } catch (err) {
      // Both an upstream 4xx (AppError) and a genuine transport failure land
      // here; only the latter should be rewritten.
      if (err instanceof AppError) throw err;
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw new UpstreamError(this.cfg.name, `${this.cfg.name} timed out after ${timeoutMs}ms`);
      }
      throw new UpstreamError(this.cfg.name, `${this.cfg.name} unreachable: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  get<T = any>(path: string, opts: Omit<ServiceCallOptions, 'method' | 'body'> = {}) {
    return this.call<T>(path, { ...opts, method: 'GET' });
  }
  post<T = any>(path: string, body?: unknown, opts: Omit<ServiceCallOptions, 'method'> = {}) {
    return this.call<T>(path, { ...opts, method: 'POST', body });
  }
  patch<T = any>(path: string, body?: unknown, opts: Omit<ServiceCallOptions, 'method'> = {}) {
    return this.call<T>(path, { ...opts, method: 'PATCH', body });
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Run several upstream calls, tolerating individual failures.
 *
 * This is the shape a BFF actually needs: the home screen should still
 * render the active order when the catalogue is down. Callers supply a
 * fallback per call rather than losing the whole screen to one bad upstream.
 */
export async function settleWithFallback<T extends Record<string, unknown>>(
  tasks: { [K in keyof T]: { run: () => Promise<T[K]>; fallback: T[K] } },
): Promise<{ values: T; degraded: string[] }> {
  const keys = Object.keys(tasks) as Array<keyof T & string>;
  const degraded: string[] = [];

  const results = await Promise.all(
    keys.map(async (k) => {
      try {
        return await tasks[k].run();
      } catch {
        degraded.push(k);
        return tasks[k].fallback;
      }
    }),
  );

  const values = Object.fromEntries(keys.map((k, i) => [k, results[i]])) as T;
  return { values, degraded };
}
