/**
 * The repository base class (Part 4.1).
 *
 * Every table in this schema shares a shape: a `bigint` id, `created_at` and
 * `updated_at` maintained by the `set_updated_at` trigger, and on most tables a
 * nullable `deleted_at` for soft deletion. That commonality is what this class
 * captures; a concrete repository adds only the queries specific to its module.
 *
 * Two things it deliberately does not do:
 *
 *   - **It does not hold a connection.** Every method takes the `Uow` for the
 *     current transaction. A repository that captured a pool at construction
 *     could be called outside a transaction, which for any table carrying an
 *     `audit_row` trigger means an audit entry with no user attached.
 *
 *   - **It does not accept caller-supplied column names.** `create` and
 *     `update` project through `writableColumns`, so a field the client should
 *     not control — `status`, `total`, `created_by`, `id` — cannot be set by
 *     adding it to a request body (Part 4, mass assignment).
 */

import type { QueryResultRow } from 'pg';
import type { Uow } from '../db/uow';
import { ConflictError, NotFoundError, StaleRecordError } from '../errors';
import {
  ConditionBuilder,
  type Cursor,
  type SortDirection,
  type SortMap,
  clampLimit,
  keysetCondition,
  resolveSort,
  toPage,
} from '../db/query-builder';

export type Id = number | string;

/** Columns present on effectively every table here. */
export type BaseRow = QueryResultRow & {
  id: string;
  created_at: string;
  updated_at: string;
};

export type SoftDeletableRow = BaseRow & { deleted_at: string | null };

export type ListOptions = {
  cursor?: Cursor | undefined;
  limit?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: SortDirection | undefined;
  /** Include soft-deleted rows. Off unless a caller explicitly asks. */
  includeDeleted?: boolean | undefined;
};

export abstract class BaseRepository<TRow extends BaseRow> {
  /** The table, written in code. Interpolated into SQL, so never from input. */
  protected abstract readonly table: string;

  /** Columns a caller may set. Everything else is controlled by the service or the database. */
  protected abstract readonly writableColumns: readonly string[];

  /** Sorts this repository supports, each naming its backing index. */
  protected abstract readonly sortable: SortMap;

  /** Default sort key, which must be a key of `sortable`. */
  protected abstract readonly defaultSort: string;

  /** True when the table carries `deleted_at`. */
  protected readonly softDeletes: boolean = true;

  /** Columns to select. `*` unless a subclass narrows it to avoid wide rows. */
  protected readonly selectColumns: string = '*';

  /* -------------------------------------------------------------- *
   * Reads
   * -------------------------------------------------------------- */

  async findById(uow: Uow, id: Id, options: { includeDeleted?: boolean } = {}): Promise<TRow | null> {
    const conditions = new ConditionBuilder();
    conditions.add('id = ?', id);
    this.applyDeletedFilter(conditions, options.includeDeleted);

    return uow.maybeOne<TRow>(
      `SELECT ${this.selectColumns} FROM ${this.table} ${conditions.where()}`,
      conditions.params(),
    );
  }

  /**
   * As `findById`, but 404s instead of returning null.
   *
   * Services use this by default: Part 7.2 requires a record outside the
   * caller's scope to be indistinguishable from one that does not exist, and
   * the way to guarantee that is for the not-found path to be the same code.
   */
  async getById(uow: Uow, id: Id, options: { includeDeleted?: boolean } = {}): Promise<TRow> {
    const row = await this.findById(uow, id, options);
    if (!row) throw new NotFoundError(this.entityName);
    return row;
  }

  async findOneBy(uow: Uow, criteria: Readonly<Record<string, unknown>>): Promise<TRow | null> {
    const conditions = this.criteriaToConditions(criteria);
    this.applyDeletedFilter(conditions, false);
    return uow.maybeOne<TRow>(
      `SELECT ${this.selectColumns} FROM ${this.table} ${conditions.where()} LIMIT 1`,
      conditions.params(),
    );
  }

  async exists(uow: Uow, criteria: Readonly<Record<string, unknown>>): Promise<boolean> {
    const conditions = this.criteriaToConditions(criteria);
    this.applyDeletedFilter(conditions, false);
    const row = await uow.maybeOne<{ ok: boolean }>(
      `SELECT true AS ok FROM ${this.table} ${conditions.where()} LIMIT 1`,
      conditions.params(),
    );
    return row !== null;
  }

  async countBy(uow: Uow, criteria: Readonly<Record<string, unknown>> = {}): Promise<number> {
    const conditions = this.criteriaToConditions(criteria);
    this.applyDeletedFilter(conditions, false);
    const row = await uow.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ${this.table} ${conditions.where()}`,
      conditions.params(),
    );
    return row.n;
  }

  /**
   * Load many rows by id in one round trip, indexed for O(1) assembly.
   *
   * This is the batching helper Part 9.3 asks for. The N+1 pattern it replaces —
   * a query per row while building a response — is the single most common cause
   * of a list endpoint that is fast with ten rows and unusable with a thousand.
   */
  async findByIds(uow: Uow, ids: readonly Id[]): Promise<Map<string, TRow>> {
    if (ids.length === 0) return new Map();
    const unique = [...new Set(ids.map(String))];
    const rows = await uow.many<TRow>(
      `SELECT ${this.selectColumns} FROM ${this.table} WHERE id = ANY($1)`,
      [unique],
    );
    return new Map(rows.map((row) => [String(row.id), row]));
  }

  /**
   * A keyset-paginated page.
   *
   * `extra` carries the module's own filters, already built and parameterized
   * by the concrete repository, so this method never sees request input.
   */
  async listPage(
    uow: Uow,
    options: ListOptions = {},
    extra?: ConditionBuilder,
  ): Promise<{ items: TRow[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = clampLimit(options.limit);
    const direction: SortDirection = options.sortDir ?? 'desc';
    const { sql: orderBy, key } = resolveSort(
      options.sortBy,
      direction,
      this.sortable,
      this.defaultSort,
    );
    const sortColumn = this.sortable[key]!.column;

    // The module's filters were numbered from 1, so this builder continues
    // after them rather than colliding.
    const conditions = new ConditionBuilder(extra?.params().length ?? 0);
    this.applyDeletedFilter(conditions, options.includeDeleted);
    if (options.cursor) {
      keysetCondition(conditions, sortColumn, `${this.table}.id`, options.cursor, direction);
    }

    const clauses = [extra?.where(), conditions.and()].filter(Boolean).join(' ');
    const params = [...(extra?.params() ?? []), ...conditions.params()];

    // id is the tie-breaker in ORDER BY as well as in the cursor; without it the
    // ordering of rows sharing a sort value is undefined between pages.
    const rows = await uow.many<TRow>(
      `SELECT ${this.selectColumns} FROM ${this.table} ${clauses}
        ORDER BY ${orderBy}, ${this.table}.id ${direction === 'desc' ? 'DESC' : 'ASC'}
        LIMIT ${limit + 1}`,
      params,
    );

    return toPage(rows, limit, key, (row) => {
      const raw = (row as QueryResultRow)[key.split('.').pop() ?? key];
      return raw === undefined || raw === null ? null : (raw as string | number);
    });
  }

  /* -------------------------------------------------------------- *
   * Writes
   * -------------------------------------------------------------- */

  async create(uow: Uow, data: Readonly<Record<string, unknown>>): Promise<TRow> {
    const entries = this.pickWritable(data);
    if (entries.length === 0) {
      throw new Error(`${this.constructor.name}.create called with no writable fields`);
    }

    const columns = entries.map(([column]) => column);
    const placeholders = entries.map((_, i) => `$${i + 1}`);

    return uow.one<TRow>(
      `INSERT INTO ${this.table} (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING ${this.selectColumns}`,
      entries.map(([, value]) => value),
      this.entityName,
    );
  }

  /**
   * Insert many rows in one statement.
   *
   * One statement rather than a loop, because Part 9.3 requires it and because
   * some of this schema's triggers demand it: `check_allocation_total` is a
   * FOR EACH ROW AFTER INSERT trigger asserting that a payment's allocations
   * sum to the payment amount. Postgres queues after-row triggers to the end of
   * the statement, so a multi-row INSERT satisfies it, while the same rows
   * inserted one at a time fail on the first.
   *
   * Every row must present the same columns; a missing key would shift values
   * into the wrong columns, so it is rejected rather than defaulted.
   */
  async createMany(uow: Uow, rows: readonly Readonly<Record<string, unknown>>[]): Promise<TRow[]> {
    if (rows.length === 0) return [];

    const columns = this.pickWritable(rows[0]!).map(([column]) => column);
    if (columns.length === 0) {
      throw new Error(`${this.constructor.name}.createMany called with no writable fields`);
    }

    const params: unknown[] = [];
    const tuples = rows.map((row, rowIndex) => {
      const placeholders = columns.map((column) => {
        if (!(column in row)) {
          throw new Error(
            `${this.constructor.name}.createMany: row ${rowIndex} is missing "${column}"; ` +
              'every row must supply the same columns.',
          );
        }
        params.push(row[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    return uow.many<TRow>(
      `INSERT INTO ${this.table} (${columns.join(', ')})
       VALUES ${tuples.join(', ')}
       RETURNING ${this.selectColumns}`,
      params,
    );
  }

  /**
   * Update by id.
   *
   * `expectedUpdatedAt` is the optimistic concurrency check from Part 9.5. When
   * given, the update only applies if the row has not changed since the caller
   * read it; a mismatch is a 409 rather than a last-write-wins overwrite of
   * someone else's edit. `updated_at` itself is left to the `set_updated_at`
   * trigger.
   */
  async update(
    uow: Uow,
    id: Id,
    data: Readonly<Record<string, unknown>>,
    expectedUpdatedAt?: string,
  ): Promise<TRow> {
    const entries = this.pickWritable(data);
    if (entries.length === 0) return this.getById(uow, id);

    const assignments = entries.map(([column], i) => `${column} = $${i + 1}`);
    const params = entries.map(([, value]) => value);

    params.push(id);
    const idPlaceholder = `$${params.length}`;

    let guard = '';
    if (expectedUpdatedAt !== undefined) {
      params.push(expectedUpdatedAt);
      guard = ` AND updated_at = $${params.length}`;
    }
    if (this.softDeletes) guard += ' AND deleted_at IS NULL';

    const row = await uow.maybeOne<TRow>(
      `UPDATE ${this.table} SET ${assignments.join(', ')}
        WHERE id = ${idPlaceholder}${guard}
        RETURNING ${this.selectColumns}`,
      params,
    );

    if (!row) {
      // No row came back for one of two reasons, and they need different answers.
      const current = await this.findById(uow, id, { includeDeleted: true });
      if (!current) throw new NotFoundError(this.entityName);
      if (expectedUpdatedAt !== undefined) throw new StaleRecordError(this.entityName);
      throw new ConflictError(`${this.entityName} has been deleted.`, 'DELETED');
    }
    return row;
  }

  /**
   * Soft delete.
   *
   * Nothing with history is ever hard deleted in this application — a student
   * with invoices, a staff member with payslips. Restricting the base class to
   * soft deletion means a hard delete has to be written deliberately, in the
   * one repository where it is genuinely correct.
   */
  async softDelete(uow: Uow, id: Id): Promise<void> {
    if (!this.softDeletes) {
      throw new Error(`${this.table} does not support soft deletion`);
    }
    const affected = await uow.count(
      `UPDATE ${this.table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (affected === 0) throw new NotFoundError(this.entityName);
  }

  async restore(uow: Uow, id: Id): Promise<TRow> {
    if (!this.softDeletes) {
      throw new Error(`${this.table} does not support soft deletion`);
    }
    const row = await uow.maybeOne<TRow>(
      `UPDATE ${this.table} SET deleted_at = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL
        RETURNING ${this.selectColumns}`,
      [id],
    );
    if (!row) throw new NotFoundError(this.entityName);
    return row;
  }

  /**
   * Lock rows for update, in ascending id order.
   *
   * The ordering is the point (Part 9.5). Two transactions locking the same two
   * invoices in opposite orders deadlock; both taking them in ascending id
   * order cannot. Used before recording a payment, issuing a book, or moving
   * stock.
   */
  async lockByIds(uow: Uow, ids: readonly Id[]): Promise<TRow[]> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids.map(String))];
    return uow.many<TRow>(
      `SELECT ${this.selectColumns} FROM ${this.table}
        WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [unique],
    );
  }

  /* -------------------------------------------------------------- *
   * Internals
   * -------------------------------------------------------------- */

  /** A readable name for error messages: `fee_invoices` becomes `Fee invoice`. */
  protected get entityName(): string {
    const words = this.table.replace(/s$/, '').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /** Keep only declared-writable keys, dropping anything else without comment. */
  private pickWritable(data: Readonly<Record<string, unknown>>): [string, unknown][] {
    return this.writableColumns
      .filter((column) => data[column] !== undefined)
      .map((column) => [column, data[column]]);
  }

  /**
   * Turn a criteria object into conditions.
   *
   * Keys are checked against `writableColumns` plus `id`, so this cannot be
   * used to filter on a column the repository has not declared.
   */
  private criteriaToConditions(criteria: Readonly<Record<string, unknown>>): ConditionBuilder {
    const conditions = new ConditionBuilder();
    for (const [column, value] of Object.entries(criteria)) {
      if (column !== 'id' && !this.writableColumns.includes(column)) {
        throw new Error(`${this.constructor.name}: "${column}" is not a filterable column`);
      }
      if (value === null) {
        conditions.add(`${column} IS NULL`);
      } else {
        conditions.add(`${column} = ?`, value);
      }
    }
    return conditions;
  }

  private applyDeletedFilter(conditions: ConditionBuilder, includeDeleted: boolean | undefined): void {
    if (this.softDeletes && !includeDeleted) {
      conditions.add(`${this.table}.deleted_at IS NULL`);
    }
  }
}
