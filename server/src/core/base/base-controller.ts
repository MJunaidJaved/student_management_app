/**
 * Controller helpers (Part 4.3).
 *
 * Controllers stay thin: read the validated request, call one service method,
 * shape the response. No business rules, no database access.
 *
 * The value here is `handler()`. Express 5 forwards a rejected promise to the
 * error middleware, but only if the handler actually returns the promise — and
 * an `async` Express handler whose rejection is not forwarded becomes a request
 * that hangs until the client times out, with nothing in the log. Routing every
 * controller through one wrapper makes that impossible to get wrong.
 */

import type { RequestHandler, Request } from 'express';
import { ok, type PageMeta } from '../http/envelope';
import { getRequestId } from '../http/request-context';
import { currentUser } from '../http/authenticate';
import { toActor } from '../authz/permission-service';
import type { Actor } from '../db/uow';

export type HandlerResult =
  | { status: 200 | 201; body: unknown; page?: PageMeta }
  | { status: 204 };

/**
 * Wrap an async controller.
 *
 * A 204 sends no body, because an envelope with a null payload is not "no
 * content" and some clients choke on a body where none is expected.
 */
export function handler(fn: (req: Request) => Promise<HandlerResult>): RequestHandler {
  return (req, res, next) => {
    void fn(req)
      .then((result) => {
        if (result.status === 204) {
          res.status(204).send();
          return;
        }
        res
          .status(result.status)
          .json(ok(result.body, getRequestId(), result.page ? { page: result.page } : {}));
      })
      .catch(next);
  };
}

/** The acting user, as the database layer wants it. */
export const actorOf = (req: Request): Actor => toActor(currentUser(req));

/** A list response: items plus page metadata in `meta`, never mixed into the data. */
export const listed = <T>(result: { items: T[]; page: PageMeta }, key = 'items'): HandlerResult => ({
  status: 200,
  body: { [key]: result.items },
  page: result.page,
});

export const created = (body: unknown): HandlerResult => ({ status: 201, body });
export const okBody = (body: unknown): HandlerResult => ({ status: 200, body });
export const noContent = (): HandlerResult => ({ status: 204 });
