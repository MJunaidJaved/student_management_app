/**
 * Safe, parameterized SQL assembly.
 *
 * Every list endpoint in the application accepts filters, a sort and a page
 * cursor. Building those by hand in each repository is how an injection or an
 * unindexed sort eventually gets in, so it is done once, here, under two
 * non-negotiable rules:
 *
 *   1. **Values are always bind parameters.** No value is ever interpolated.
 *   2. **Identifiers are never taken from the request.** A column can only be
 *      filtered or sorted on if it appears in the endpoint's allow-list, which
 *      is written in code. A request naming anything else is rejected, not
 *      ignored — silently dropping an unknown filter would return more rows
 *      than the caller asked for, which on a defaulters list is a data leak
 *      rather than a cosmetic bug.
 *
 * Part 5.5 also requires sortable columns to be index-backed. The allow-list is
 * where that is asserted, so `SortSpec` carries the index name as documentation
 * that has to be filled in deliberately.
 */

import { BadRequestError, ValidationError } from '../errors';

/** Accumulates `WHERE` fragments and their bind values, numbering as it goes. */
export class ConditionBuilder {
  private readonly clauses: string[] = [];
  private readonly values: unknown[] = [];

  /** `offset` is the count of parameters already bound before this builder ran. */
  constructor(private readonly offset = 0) {}

  /** Next placeholder number, accounting for parameters bound before this builder. */
  private get next(): number {
    return this.offset + this.values.length + 1;
  }

  /**
   * Add a fragment. `?` in `sql` is replaced with the next `$n` in order.
   *
   * `?` rather than hand-written `$1` because the parameters of a list query
   * are assembled by several helpers appending to one list — a branch filter,
   * then a date range, then the cursor. Hand-numbering means renumbering
   * whenever a clause moves, and an off-by-one there produces a query that
   * still runs, against the wrong column.
   */
  add(sql: string, ...params: unknown[]): this {
    let i = 0;
    const numbered = sql.replace(/\?/g, () => {
      if (i >= params.length) {
        throw new Error(`ConditionBuilder: more placeholders than values in "${sql}"`);
      }
      i += 1;
      return `$${this.next + i - 1}`;
    });
    if (i !== params.length) {
      throw new Error(`ConditionBuilder: ${params.length} values but ${i} placeholders in "${sql}"`);
    }
    this.clauses.push(numbered);
    this.values.push(...params);
    return this;
  }

  /** Add only when the value is present, which is most filters. */
  addIf(condition: unknown, sql: string, ...params: unknown[]): this {
    if (condition === undefined || condition === null || condition === '') return this;
    return this.add(sql, ...params);
  }

  /** `column = ANY($n)`, or nothing for an empty list. Beats an IN list of placeholders. */
  addAnyOf(column: string, list: readonly unknown[] | undefined): this {
    if (!list || list.length === 0) return this;
    return this.add(`${column} = ANY(?)`, list);
  }

  /** `WHERE ...`, or '' when nothing was added, so callers need no special case. */
  where(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }

  /** Conditions joined for embedding inside an existing WHERE. */
  and(): string {
    return this.clauses.length ? `AND ${this.clauses.join(' AND ')}` : '';
  }

  params(): unknown[] {
    return [...this.values];
  }

  get length(): number {
    return this.clauses.length;
  }
}

/** One permitted sort, and the index that makes it cheap. */
export type SortSpec = {
  /** The SQL expression to order by; written in code, never from a request. */
  readonly column: string;
  /** The index backing it. Documentation, and a prompt to add one if absent. */
  readonly index: string;
};

export type SortMap = Readonly<Record<string, SortSpec>>;

export type SortDirection = 'asc' | 'desc';

/**
 * Resolve a requested sort against the allow-list.
 *
 * `NULLS LAST` on descending is deliberate: a nullable column sorted descending
 * puts nulls first in Postgres, so the first page of "most recently paid" would
 * be entirely unpaid invoices.
 */
export function resolveSort(
  requested: string | undefined,
  direction: SortDirection,
  allowed: SortMap,
  fallback: string,
): { sql: string; key: string } {
  const key = requested ?? fallback;
  const spec = allowed[key];
  if (!spec) {
    throw new ValidationError(`Cannot sort by "${key}".`, [
      { field: 'sortBy', message: `Allowed values: ${Object.keys(allowed).join(', ')}.` },
    ]);
  }
  const dir = direction === 'desc' ? 'DESC NULLS LAST' : 'ASC';
  return { sql: `${spec.column} ${dir}`, key };
}

/** Reject any filter the endpoint did not declare, rather than ignoring it. */
export function assertAllowedFilters(
  provided: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(provided).filter(
    (k) => provided[k] !== undefined && !allowed.includes(k),
  );
  if (unknown.length) {
    throw new ValidationError('Unknown filter.', [
      { field: unknown.join(', '), message: `Allowed filters: ${allowed.join(', ')}.` },
    ]);
  }
}

/* ------------------------------------------------------------------ *
 * Keyset pagination
 * ------------------------------------------------------------------ */

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * The position of the last row of a page.
 *
 * Keyset rather than OFFSET because these tables grow without bound: at 200,000
 * invoices, `OFFSET 190000` makes Postgres walk and discard 190,000 rows for
 * every page. A cursor holding the last row's sort value and id stays one index
 * seek regardless of depth (Part 5.5).
 *
 * The id is always part of it. The sort column alone is not unique — several
 * payments share a `paid_at` date — and a non-unique keyset silently skips or
 * repeats rows at the page boundary.
 */
export type Cursor = {
  /** The sort key this cursor was built for; a mismatch means the sort changed. */
  k: string;
  /** The last row's sort value. Null is legal for a nullable column. */
  v: string | number | null;
  /** The last row's id, the tie-breaker. */
  i: string;
};

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode a cursor, rejecting anything malformed.
 *
 * A cursor is client-supplied, so it is validated as untrusted input. It is not
 * signed: it contains only a sort value and an id that the caller is already
 * authorised to see, and the scope filters are reapplied on every page
 * regardless, so forging one cannot widen access.
 */
export function decodeCursor(raw: string, expectedKey: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('The page cursor is not valid.', 'INVALID_CURSOR');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Cursor).k !== 'string' ||
    typeof (parsed as Cursor).i !== 'string'
  ) {
    throw new BadRequestError('The page cursor is not valid.', 'INVALID_CURSOR');
  }

  const cursor = parsed as Cursor;
  if (cursor.k !== expectedKey) {
    // Continuing a cursor built for a different sort would produce a page from
    // an arbitrary position rather than an error.
    throw new BadRequestError(
      'The page cursor does not match the current sort. Start from the first page.',
      'CURSOR_SORT_MISMATCH',
    );
  }
  return cursor;
}

/**
 * The condition that resumes after a cursor, as a row-wise comparison.
 *
 * `(sort, id) < (value, id)` is one comparison Postgres can satisfy from a
 * composite index on `(sort, id)`, which the equivalent
 * `sort < v OR (sort = v AND id < i)` cannot always use.
 *
 * A null cursor value is handled separately because `(x) < (NULL)` is NULL, not
 * false, so the row-wise form silently returns nothing once the page boundary
 * lands on a null.
 */
export function keysetCondition(
  builder: ConditionBuilder,
  sortColumn: string,
  idColumn: string,
  cursor: Cursor,
  direction: SortDirection,
): void {
  const op = direction === 'desc' ? '<' : '>';

  if (cursor.v === null) {
    if (direction === 'desc') {
      // Descending with NULLS LAST: nulls are the tail, so only later nulls remain.
      builder.add(`(${sortColumn} IS NULL AND ${idColumn} ${op} ?)`, cursor.i);
    } else {
      // Ascending: nulls sort last, so everything non-null is already behind us.
      builder.add(`(${sortColumn} IS NULL AND ${idColumn} ${op} ?)`, cursor.i);
    }
    return;
  }

  if (direction === 'desc') {
    builder.add(`(${sortColumn}, ${idColumn}) ${op} (?, ?)`, cursor.v, cursor.i);
  } else {
    // Ascending with NULLS LAST: non-null rows first, then the nulls.
    builder.add(
      `((${sortColumn}, ${idColumn}) ${op} (?, ?) OR ${sortColumn} IS NULL)`,
      cursor.v,
      cursor.i,
    );
  }
}

export type KeysetRequest = {
  cursor?: string | undefined;
  limit?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: SortDirection | undefined;
  withTotal?: boolean | undefined;
};

/** Clamp a requested page size. A caller asking for 10,000 rows gets the cap, not an error. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError('limit must be a positive whole number.', [
      { field: 'limit', message: `Between 1 and ${MAX_PAGE_SIZE}.` },
    ]);
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * Turn `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how `hasMore` is known without a second COUNT
 * query. The extra row is dropped before returning.
 */
export function toPage<T extends { id: string | number }>(
  rows: T[],
  limit: number,
  sortKey: string,
  cursorValueOf: (row: T) => string | number | null,
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({ k: sortKey, v: cursorValueOf(last), i: String(last.id) })
        : null,
  };
}
