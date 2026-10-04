/**
 * The Unit of Work: one transaction, one connection, several repositories.
 *
 * This is the only way the application is allowed to write. That is not a style
 * preference — the schema's audit triggers depend on it.
 *
 * **Why the session variables live here.** `audit_row()` is SECURITY DEFINER and
 * reads `current_setting('app.current_user_id', true)`. It is attached to
 * students, guardians, users, roles, payments, invoices, marks, payslips and
 * more. If that setting is absent the trigger still fires and still writes an
 * audit row — with a NULL `user_id`. So forgetting it does not fail loudly, it
 * silently produces an audit trail that cannot answer "who did this", which is
 * the only question an audit trail exists to answer. Part 5.2 therefore asks
 * for it to be impossible to forget, and the way to make it impossible is to
 * have no other route to a writable client.
 *
 * **Why `set_config(..., true)` and not `SET LOCAL`.** Two reasons. `SET LOCAL`
 * takes no bind parameters, so the user id would have to be interpolated into
 * SQL, and interpolating anything into SQL is exactly what Part 5.2 forbids.
 * And `set_config`'s third argument, `is_local = true`, scopes the value to the
 * current transaction, so it is discarded at COMMIT or ROLLBACK and cannot leak
 * to the next request that borrows this pooled connection. A plain `SET` would
 * persist on the connection and hand the next caller the previous caller's
 * identity — the pooled-connection leak the brief warns about.
 */

import type { PoolClient, QueryResultRow } from 'pg';
import { withClient } from './pool';
import { isRetryable, translateDbError } from './translate-error';
import { NotFoundError } from '../errors';
import { logger } from '../logging/logger';

/** Who is acting. Mirrors the `users.user_type` CHECK constraint. */
export type UserType = 'admin' | 'staff' | 'guardian' | 'student';

export type Actor = {
  userId: number | null;
  userType: UserType | null;
  /** Set only for a guardian; drives the fee_invoices RLS policy. */
  guardianId?: number | null;
  staffId?: number | null;
  studentId?: number | null;
};

/** For migrations, jobs and seeds: attributable to no person. */
export const SYSTEM_ACTOR: Actor = { userId: null, userType: null };

/**
 * A database handle scoped to one transaction.
 *
 * Repositories receive this rather than the pool, so a repository physically
 * cannot run a statement outside the transaction it was given. That was the
 * failure mode worth designing out: a stray call on the pool looks like it
 * works right up until a rollback fails to undo half the writes.
 */
export class Uow {
  constructor(private readonly client: PoolClient) {}

  /** Rows from a parameterized statement. */
  async many<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      const result = await this.client.query<T>(sql, params as unknown[]);
      return result.rows;
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** The first row, or null. */
  async maybeOne<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(sql, params);
    return rows[0] ?? null;
  }

  /** The first row, or a 404. `what` names the thing for the message. */
  async one<T extends QueryResultRow>(sql: string, params: readonly unknown[] = [], what = 'Record'): Promise<T> {
    const row = await this.maybeOne<T>(sql, params);
    if (!row) throw new NotFoundError(what);
    return row;
  }

  /** How many rows a statement touched. */
  async count(sql: string, params: readonly unknown[] = []): Promise<number> {
    try {
      const result = await this.client.query(sql, params as unknown[]);
      return result.rowCount ?? 0;
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /**
   * The next value of one of the schema's human-readable sequences.
   *
   * Part 9.5: admission numbers, receipt numbers, invoice numbers and the rest
   * come from the database, never from application code, because only the
   * database can hand out a number that is unique under concurrency.
   *
   * The name is checked against a fixed list rather than trusted, since it
   * reaches `nextval` as an identifier.
   */
  async nextSequenceValue(sequence: SequenceName): Promise<string> {
    if (!SEQUENCES.includes(sequence)) {
      throw new Error(`Unknown sequence: ${sequence}`);
    }
    const row = await this.one<{ v: string }>('SELECT nextval($1)::text AS v', [sequence]);
    return row.v;
  }

  /** Escape hatch for a repository that needs the raw client (COPY, cursors). */
  get raw(): PoolClient {
    return this.client;
  }
}

/** The schema's eight human-readable number sequences. */
export const SEQUENCES = [
  'seq_admission_no',
  'seq_application_no',
  'seq_certificate_no',
  'seq_employee_no',
  'seq_invoice_no',
  'seq_po_no',
  'seq_receipt_no',
  'seq_voucher_no',
] as const;

export type SequenceName = (typeof SEQUENCES)[number];

type TxOptions = {
  /**
   * Retries on serialization failure and deadlock (Part 5.2).
   *
   * Only safe for work that is idempotent when replayed from the start, which
   * a whole transaction re-run from a clean BEGIN is. Default 2, meaning three
   * attempts in all; a contended row that loses three times is reported rather
   * than retried forever.
   */
  retries?: number;
  /** 'serializable' for the money paths that must not interleave. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
};

/**
 * Run `fn` inside one transaction, as `actor`, rolling back on any error.
 *
 * Every write in the application goes through here.
 */
export async function transaction<T>(
  actor: Actor,
  fn: (uow: Uow) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const { retries = 2, isolation = 'read committed', readOnly = false } = options;

  let attempt = 0;
  for (;;) {
    try {
      return await withClient(async (client) => {
        await client.query(
          `BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}${readOnly ? ' READ ONLY' : ''}`,
        );
        try {
          await applyActor(client, actor);
          const result = await fn(new Uow(client));
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // The connection is already gone; the transaction is aborted either way.
          }
          throw err;
        }
      });
    } catch (err) {
      if (attempt < retries && isRetryable(err)) {
        attempt += 1;
        // Brief, jittered: two transactions that collide and back off by the
        // same amount simply collide again.
        const delay = 25 * 2 ** (attempt - 1) + Math.random() * 25;
        logger.warn({ attempt, delay }, 'Transaction contended; retrying');
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw translateDbError(err);
    }
  }
}

/**
 * A read-only transaction. Still sets the actor, because the RLS policies read
 * `app.current_user_type` on SELECT too.
 */
export function readTransaction<T>(
  actor: Actor,
  fn: (uow: Uow) => Promise<T>,
  options: Omit<TxOptions, 'readOnly'> = {},
): Promise<T> {
  return transaction(actor, fn, { ...options, readOnly: true, retries: options.retries ?? 0 });
}

/**
 * Publish the actor to the transaction.
 *
 * Values go in as bind parameters and are scoped to this transaction by
 * `is_local = true`. Nulls are written as the empty string because that is what
 * the schema's own expressions expect: `NULLIF(current_setting('app.current_user_id', true), '')::BIGINT`
 * in `audit_row()`, and the same `NULLIF` idiom in the guardian RLS policy. An
 * explicit empty string and an unset variable are equivalent to them, and
 * setting it every time keeps a recycled connection from retaining a stale one.
 */
async function applyActor(client: PoolClient, actor: Actor): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_user_id',     $1, true),
            set_config('app.current_user_type',   $2, true),
            set_config('app.current_guardian_id', $3, true)`,
    [
      actor.userId == null ? '' : String(actor.userId),
      actor.userType ?? '',
      actor.guardianId == null ? '' : String(actor.guardianId),
    ],
  );
}
