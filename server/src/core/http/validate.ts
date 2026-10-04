/**
 * Route-level validation (Part 5.4).
 *
 * Validation happens before the controller, and the controller reads only what
 * came back out of the schema — never `req.body` directly. That is what makes
 * mass assignment structurally impossible rather than a thing to remember:
 * `strict()` schemas reject unknown fields, so a client cannot smuggle
 * `status`, `total` or `created_by` into a create request by adding them to the
 * JSON.
 *
 * The parsed values replace the originals on the request, so downstream code
 * gets coerced types (a query `?limit=25` arrives as the number 25) and cannot
 * accidentally reach around to the raw string.
 */

import type { RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import { ValidationError } from '../errors';

export type RequestSchemas = {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  headers?: ZodType;
};

/** What a validated handler can rely on. */
export type Validated<S extends RequestSchemas> = {
  body: S['body'] extends ZodType ? z.infer<S['body']> : undefined;
  query: S['query'] extends ZodType ? z.infer<S['query']> : undefined;
  params: S['params'] extends ZodType ? z.infer<S['params']> : undefined;
};

/** Where validated values are parked; read via `validated(req)`. */
const SLOT = Symbol('validated');

type WithValidated = { [SLOT]?: { body?: unknown; query?: unknown; params?: unknown } };

/**
 * Validate the parts of a request a route declares.
 *
 * All sections are checked before throwing, so a request with a bad path param
 * *and* a bad body reports both rather than making the caller fix them one
 * round trip at a time. Issue paths are prefixed with the section so
 * `body.email` and `query.email` are distinguishable in the response.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { field: string; message: string }[] = [];
    const parsed: { body?: unknown; query?: unknown; params?: unknown } = {};

    for (const section of ['params', 'query', 'body'] as const) {
      const schema = schemas[section];
      if (!schema) continue;

      const result = schema.safeParse(req[section]);
      if (result.success) {
        parsed[section] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            field: issue.path.length ? `${section}.${issue.path.join('.')}` : section,
            message: issue.message,
          });
        }
      }
    }

    // Headers are validated but never replaced: Express's header handling is
    // case-insensitive and other middleware reads it, so overwriting the object
    // breaks things in ways that are hard to trace.
    if (schemas.headers) {
      const result = schemas.headers.safeParse(req.headers);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ field: `headers.${issue.path.join('.')}`, message: issue.message });
        }
      }
    }

    if (issues.length) {
      return next(new ValidationError('The submitted values are not valid.', issues));
    }

    (req as unknown as WithValidated)[SLOT] = parsed;
    return next();
  };
}

/**
 * Read the validated values in a controller.
 *
 * Throws if the route forgot `validate()`. A controller silently receiving
 * `undefined` where it expected a parsed body is a worse failure than a 500,
 * because it looks like a validation pass.
 */
export function validated<S extends RequestSchemas>(req: unknown): Validated<S> {
  const slot = (req as WithValidated)[SLOT];
  if (!slot) {
    throw new Error(
      'validated() called on a request with no validation middleware. ' +
        'Add validate({...}) to the route declaration.',
    );
  }
  return slot as Validated<S>;
}

/* ------------------------------------------------------------------ *
 * Shared field schemas
 * ------------------------------------------------------------------ */

/**
 * A database id from a path or body.
 *
 * Kept as a *string* deliberately. These are `bigint` columns, and `bigint`
 * exceeds JavaScript's safe integer range, so parsing ids to numbers would
 * quietly corrupt them once the school has enough audit rows. They are only
 * ever bound as parameters and compared, never arithmetic, so a string is the
 * honest representation.
 */
export const idParam = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, 'Must be a positive whole number.');

/** Trimmed, bounded text. */
export const text = (max: number, min = 1) =>
  z.string().trim().min(min, `Must not be empty.`).max(max, `Must be ${max} characters or fewer.`);

export const optionalText = (max: number) =>
  z.string().trim().max(max, `Must be ${max} characters or fewer.`).optional();

/** ISO calendar day. `YYYY-MM-DD` only, and a real date. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD form.')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    // Rejects 2026-02-30, which passes the regex and which `new Date` would
    // otherwise silently roll forward to March.
    return (
      date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    );
  }, 'Must be a real calendar date.');

/**
 * A money amount, as a decimal string.
 *
 * A JSON number is accepted and immediately stringified, because clients do
 * send `1250.5`. Two decimal places maximum, matching `numeric(12,2)`, and a
 * length cap so the value cannot overflow the column.
 */
export const moneyAmount = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Must be a positive amount, at most 2 decimal places.');

/**
 * A phone number, normalised to a single canonical form (Part 9.4).
 *
 * Stored and compared in one shape, because `0300-1234567`, `03001234567` and
 * `+92 300 1234567` are the same person and a phone lookup that misses them is
 * how a guardian ends up duplicated.
 */
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .refine((v) => /^(\+?\d{10,15})$/.test(v), 'Must be a valid phone number.')
  .transform((v) => (v.startsWith('+') ? v : v));

export const email = z.string().trim().toLowerCase().email('Must be a valid email address.').max(200);

/** Pagination and sorting, shared by every list endpoint (Part 5.5). */
export const listQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sortBy: z.string().max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  // Counting is a full scan on the large tables, so it is opt-in.
  withTotal: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

/**
 * The idempotency key header (Part 5.7).
 *
 * Required on money-creating endpoints. Length-bounded and character-restricted
 * because it becomes a cache key.
 */
export const idempotencyKeyHeader = z.object({
  'idempotency-key': z
    .string()
    .min(8, 'Must be at least 8 characters.')
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, 'May contain letters, digits and . _ : - only.'),
});
