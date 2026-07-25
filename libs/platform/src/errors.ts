/**
 * RFC-7807 problem details. Every service returns errors in this shape so the
 * three Flutter apps and the admin dashboard have one error contract.
 * MASTER_PLAN §1.2 (error format) and §1.2.6 (correlation IDs).
 */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  correlationId?: string;
  errors?: Record<string, string[]>;
  [key: string]: unknown;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    override readonly message: string = title,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }

  toProblem(correlationId?: string, instance?: string): ProblemDetails {
    return {
      type: `https://errors.besonc.app/${this.type}`,
      title: this.title,
      status: this.status,
      ...(this.message !== this.title ? { detail: this.message } : {}),
      ...(instance ? { instance } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...this.extra,
    };
  }
}

export class ValidationError extends AppError {
  constructor(errors: Record<string, string[]>, message = 'Request validation failed') {
    super(422, 'validation-failed', 'Validation Failed', message, { errors });
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', 'Unauthorized', message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'forbidden', 'Forbidden', message);
  }
}
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'not-found', 'Not Found', `${resource} not found`);
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(409, 'conflict', 'Conflict', message);
  }
}

/** 429 — carries Retry-After so clients can back off correctly. */
export class RateLimitError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many requests',
  ) {
    super(429, 'rate-limited', 'Too Many Requests', message, {
      retryAfterSeconds,
    });
  }
}

export class UpstreamError extends AppError {
  constructor(provider: string, message = `Upstream provider ${provider} failed`) {
    super(502, 'upstream-failure', 'Bad Gateway', message, { provider });
  }
}
