/**
 * Per-request context, carried without threading it through every signature.
 *
 * The request id has to appear in the response envelope and in every log line
 * written while handling that request, including from deep inside a service.
 * Passing it down by hand would mean adding a parameter to every method in the
 * application purely for logging, and one missed hand-off silently produces an
 * untraceable line.
 *
 * `AsyncLocalStorage` is the right tool and is not a global: each request gets
 * its own store, and an `await` inside a handler keeps it. What it must NOT be
 * used for is the actor identity in the database layer — that is passed
 * explicitly into `transaction()` so a service cannot accidentally write as
 * whoever happened to be in scope.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Actor } from '../db/uow';

export type RequestContext = {
  requestId: string;
  actor: Actor | null;
  ip: string | undefined;
  userAgent: string | undefined;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** The current context, or null outside a request (a job, a script, a test). */
export const getContext = (): RequestContext | null => storage.getStore() ?? null;

/** The current request id; a placeholder outside a request so logs stay uniform. */
export const getRequestId = (): string => storage.getStore()?.requestId ?? 'no-request';

/**
 * Set the actor once authentication has resolved it.
 *
 * Mutating the store rather than re-entering it means the auth middleware does
 * not have to wrap the rest of the chain in a callback.
 */
export function setContextActor(actor: Actor): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

/** Run `fn` with a fresh context. Used by jobs and tests, which have no request. */
export function withContext<T>(context: Partial<RequestContext>, fn: () => T): T {
  return storage.run(
    {
      requestId: context.requestId ?? randomUUID(),
      actor: context.actor ?? null,
      ip: context.ip,
      userAgent: context.userAgent,
    },
    fn,
  );
}

/**
 * Open a context for each request and echo the id back.
 *
 * An inbound `x-request-id` is honoured so a trace can span a gateway, but it
 * is length-capped and stripped of anything but safe characters first: it is
 * attacker-controlled and ends up in log lines and a response header, where an
 * unbounded or newline-bearing value would let a caller forge log entries.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  const supplied = inbound?.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  const requestId = supplied && supplied.length >= 8 ? supplied : randomUUID();

  res.setHeader('x-request-id', requestId);

  storage.run(
    {
      requestId,
      actor: null,
      ip: req.ip,
      userAgent: req.header('user-agent')?.slice(0, 300),
    },
    () => next(),
  );
};
