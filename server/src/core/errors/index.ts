/**
 * The domain error hierarchy.
 *
 * Every error the API returns deliberately is one of these. Each carries a
 * machine-readable `code` for clients to branch on and an HTTP status, so the
 * global handler never has to guess a status from a message.
 *
 * Anything that is NOT an AppError reaching the handler is by definition a bug,
 * and is reported as a bare 500 with nothing from its message — an unexpected
 * error's text is as likely to hold a connection string as an explanation.
 */

export type FieldIssue = { field: string; message: string };

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;

  /** Safe to show a client. Bugs are never expected, so they are never exposed. */
  readonly expected = true;

  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 422 — the request was understood but the values are not acceptable. */
export class ValidationError extends AppError {
  readonly status = 422;
  readonly code = 'VALIDATION_FAILED';

  constructor(message = 'The submitted values are not valid.', readonly issues: FieldIssue[] = []) {
    super(message, issues);
  }
}

/** 400 — the request itself is malformed (bad JSON, unparseable cursor). */
export class BadRequestError extends AppError {
  readonly status = 400;
  readonly code: string;
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message);
    this.code = code;
  }
}

/** 401 — no usable credentials. Deliberately vague; see AuthService. */
export class UnauthorizedError extends AppError {
  readonly status = 401;
  readonly code: string;
  constructor(message = 'Authentication is required.', code = 'UNAUTHENTICATED') {
    super(message);
    this.code = code;
  }
}

/**
 * 403 — authenticated, but not permitted.
 *
 * Used for a missing *permission*, never for a record outside the caller's
 * scope. Part 7.2: answering 403 for another student's id confirms that the id
 * exists, which is the very thing the check is there to hide. Scope failures
 * raise NotFoundError instead.
 */
export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code: string;
  constructor(message = 'You do not have permission to do that.', code = 'FORBIDDEN') {
    super(message);
    this.code = code;
  }
}

/** 404 — absent, or present but outside the caller's scope. The two are indistinguishable by design. */
export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
  constructor(what = 'Record') {
    super(`${what} was not found.`);
  }
}

/** 409 — a uniqueness or concurrency clash. */
export class ConflictError extends AppError {
  readonly status = 409;
  readonly code: string;
  constructor(message: string, code = 'CONFLICT') {
    super(message);
    this.code = code;
  }
}

/**
 * 409 — the record changed since the caller read it (optimistic concurrency,
 * Part 9.5). Separate from ConflictError so a client can offer a reload.
 */
export class StaleRecordError extends AppError {
  readonly status = 409;
  readonly code = 'STALE_RECORD';
  constructor(what = 'This record') {
    super(`${what} was changed by someone else. Reload and try again.`);
  }
}

/**
 * 422 — a business rule said no. This is the class the database guards map onto:
 * locked marks, a closed academic year, a posted voucher, an unbalanced voucher.
 */
export class BusinessRuleError extends AppError {
  readonly status = 422;
  readonly code: string;
  constructor(message: string, code = 'BUSINESS_RULE_VIOLATION') {
    super(message);
    this.code = code;
  }
}

/** 422 — an illegal state transition, with the states named so the client can explain it. */
export class IllegalTransitionError extends AppError {
  readonly status = 422;
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(entity: string, from: string, to: string, allowed: readonly string[]) {
    super(
      `A ${entity} cannot go from "${from}" to "${to}". ` +
        (allowed.length ? `Allowed from "${from}": ${allowed.join(', ')}.` : `"${from}" is final.`),
      { entity, from, to, allowed },
    );
  }
}

/** 429 — rate limited. `retryAfterSeconds` becomes the Retry-After header. */
export class RateLimitedError extends AppError {
  readonly status = 429;
  readonly code = 'RATE_LIMITED';
  constructor(readonly retryAfterSeconds: number, message = 'Too many requests. Please slow down.') {
    super(message, { retryAfterSeconds });
  }
}

/** 503 — a dependency is unavailable. Distinct from a bug so alerting can differ. */
export class ServiceUnavailableError extends AppError {
  readonly status = 503;
  readonly code = 'SERVICE_UNAVAILABLE';
  constructor(message = 'The service is temporarily unavailable. Try again shortly.') {
    super(message);
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
