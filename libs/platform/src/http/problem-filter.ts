/**
 * Shared HTTP concerns for every Nest service:
 *   - RFC-7807 problem responses (one error contract for all clients)
 *   - correlation-ID propagation (MASTER_PLAN §1.2.6)
 *   - Idempotency-Key extraction for command endpoints
 */

import {
  Catch, type ArgumentsHost, type ExceptionFilter, HttpException, Injectable,
  type NestMiddleware, Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, type ProblemDetails } from '../errors.ts';

export const CORRELATION_HEADER = 'x-correlation-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Attaches a correlation id to every request and echoes it on the response. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const id = req.headers?.[CORRELATION_HEADER] ?? randomUUID();
    req.correlationId = id;
    if (typeof res.header === 'function') res.header(CORRELATION_HEADER, id);
    else res.setHeader?.(CORRELATION_HEADER, id);
    next();
  }
}

/**
 * Converts every thrown error into RFC-7807. Unknown errors become a bare
 * 500 — we never leak stack traces or driver messages to a client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const correlationId: string | undefined =
      req?.correlationId ??
      req?.headers?.[CORRELATION_HEADER] ??
      req?.raw?.headers?.[CORRELATION_HEADER];
    const instance: string | undefined = req?.url;

    let problem: ProblemDetails;

    if (exception instanceof AppError) {
      problem = exception.toProblem(correlationId, instance);
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      problem = {
        type: 'https://errors.besonc.app/http-error',
        title: typeof body === 'string' ? body : (body as any)?.error ?? 'Request failed',
        status,
        ...(typeof body === 'object' && (body as any)?.message
          ? { detail: String((body as any).message) } : {}),
        ...(instance ? { instance } : {}),
        ...(correlationId ? { correlationId } : {}),
      };
    } else {
      this.logger.error(
        `unhandled error [${correlationId}]: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
      problem = {
        type: 'https://errors.besonc.app/internal',
        title: 'Internal Server Error',
        status: 500,
        ...(instance ? { instance } : {}),
        ...(correlationId ? { correlationId } : {}),
      };
    }

    // Retry-After is a real header, not just a body field
    const retryAfter = (problem as any).retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      if (typeof res.header === 'function') res.header('retry-after', String(retryAfter));
      else res.setHeader?.('retry-after', String(retryAfter));
    }

    const send = res.status(problem.status);
    if (typeof send.type === 'function') send.type('application/problem+json');
    send.send(problem);
  }
}
