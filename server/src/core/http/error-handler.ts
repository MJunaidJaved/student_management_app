/**
 * The global error handler.
 *
 * One rule shapes all of it: a client learns the code and the message of errors
 * we chose to raise, and nothing whatsoever about errors we did not.
 *
 * An AppError is deliberate, so its message was written for a reader. Anything
 * else is a bug, and a bug's message is as likely to contain a connection
 * string, a file path or a fragment of SQL as an explanation — so it is logged
 * in full and reported as a bare 500. Stack traces never cross the wire.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, NotFoundError, RateLimitedError, ValidationError, isAppError } from '../errors';
import { translateDbError } from '../db/translate-error';
import { logger } from '../logging/logger';
import type { ErrorEnvelope } from './envelope';
import { getRequestId } from './request-context';

/** Zod's issue list, flattened to the field-level shape the envelope promises. */
function fromZod(err: ZodError): ValidationError {
  return new ValidationError(
    'The submitted values are not valid.',
    err.issues.map((issue) => ({
      // A path of [] means the whole body; name it so the message is not orphaned.
      field: issue.path.length ? issue.path.join('.') : '_root',
      message: issue.message,
    })),
  );
}

/** Unmatched route. Registered after all routers, before the error handler. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('Endpoint'));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = getRequestId();

  // A driver error can reach here from a path that bypassed Uow; translate it
  // so the mapping is not silently skipped.
  let error: unknown = err instanceof ZodError ? fromZod(err) : translateDbError(err);

  // Express 5 raises this for a malformed JSON body before any route runs.
  if (
    !isAppError(error) &&
    error instanceof SyntaxError &&
    'body' in error &&
    (error as { status?: number }).status === 400
  ) {
    error = new ValidationError('The request body is not valid JSON.');
  }

  if (isAppError(error)) {
    const appError: AppError = error;

    if (appError instanceof RateLimitedError) {
      res.setHeader('Retry-After', String(Math.ceil(appError.retryAfterSeconds)));
    }

    // 4xx is the caller's problem and routine; 5xx we raised ourselves is not.
    const level = appError.status >= 500 ? 'error' : 'warn';
    logger[level](
      { requestId, code: appError.code, status: appError.status, route: req.originalUrl, method: req.method },
      appError.message,
    );

    const body: ErrorEnvelope = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError instanceof ValidationError && appError.issues.length
          ? { issues: appError.issues }
          : {}),
      },
      meta: { requestId },
    };
    res.status(appError.status).json(body);
    return;
  }

  // Unexpected. Everything useful goes to the log, nothing to the client.
  logger.error(
    {
      requestId,
      route: req.originalUrl,
      method: req.method,
      err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    },
    'Unhandled error',
  );

  const body: ErrorEnvelope = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. The problem has been logged.',
    },
    meta: { requestId },
  };
  res.status(500).json(body);
};
