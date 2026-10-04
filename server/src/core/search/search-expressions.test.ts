/**
 * The unit tests below cover term handling. The integration tests below them
 * cover the thing that actually goes wrong: an expression constant drifting
 * away from the index it was written to match.
 *
 * Getting this test right took two wrong turns worth recording, because both
 * look convincing:
 *
 *   1. **Comparing the constant to `pg_indexes.indexdef` as text.** Postgres
 *      re-renders an expression with its own casts and parentheses, so
 *      `lower(first_name || ' ' || coalesce(last_name, ''))` comes back as
 *      `lower(((first_name || ' '::text) || COALESCE(last_name, ''::text)))`.
 *      A string comparison fails on expressions that are in fact identical.
 *
 *   2. **Asking the planner via EXPLAIN.** These tables are empty, and on an
 *      empty table the planner is free to satisfy `deleted_at IS NULL` with
 *      whichever partial index is smallest and then apply the expression as a
 *      plain Filter. It did exactly that — a query written against the author
 *      trigram index planned as a Bitmap Index Scan on the *title* index. The
 *      test passed or failed on table statistics rather than on the thing it
 *      claimed to check.
 *
 * What works is to make Postgres render both expressions and compare its own
 * output. A throwaway table gets an index built from the shared constant, and
 * `pg_get_expr` is read for that index and for the real one. Identical
 * renderings mean the planner will treat them as the same expression, which is
 * precisely the property that matters. Everything happens inside a transaction
 * that is always rolled back.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  BOOK_AUTHOR_EXPR,
  BOOK_TITLE_EXPR,
  GUARDIAN_NAME_EXPR,
  STAFF_NAME_EXPR,
  STUDENT_NAME_EXPR,
  classifySearchTerm,
  containsPattern,
  escapeLike,
  normalizeName,
  prefixPattern,
} from './search-expressions';
import { closePool, withClient } from '../db/pool';

describe('normalizeName', () => {
  it('collapses whitespace and case-folds', () => {
    expect(normalizeName('  Ali   Hassan ')).toBe('ali hassan');
    expect(normalizeName('ALI\tHASSAN')).toBe('ali hassan');
  });
});

describe('escapeLike', () => {
  it('neutralises LIKE wildcards in a user term', () => {
    // Without this, searching "50%" would match every row.
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes the backslash before the wildcards it introduces', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('a\\%')).toBe('a\\\\\\%');
  });

  it('builds patterns that are both normalised and escaped', () => {
    expect(prefixPattern('  Ali% ')).toBe('ali\\%%');
    expect(containsPattern(' O_ne ')).toBe('%o\\_ne%');
  });
});

describe('classifySearchTerm', () => {
  it('routes an admission number to an exact lookup', () => {
    expect(classifySearchTerm('2026-0413')).toBe('admission_no');
    expect(classifySearchTerm('EMP-1024')).toBe('admission_no');
  });

  it('distinguishes a 13-digit national ID from a phone number', () => {
    // Both are all digits, so the order of the checks is what makes this work.
    expect(classifySearchTerm('3520112345671')).toBe('national_id');
    expect(classifySearchTerm('03001234567')).toBe('phone');
    expect(classifySearchTerm('+92 300 1234567')).toBe('phone');
  });

  it('falls back to a name search', () => {
    expect(classifySearchTerm('Ali Hassan')).toBe('name');
    expect(classifySearchTerm('ali')).toBe('name');
  });
});

/* ------------------------------------------------------------------ *
 * Integration: the expressions must actually reach their indexes.
 * ------------------------------------------------------------------ */

type Case = {
  name: string;
  /** Enough of the real table to rebuild the expression against. */
  columns: string;
  /** The expression constant under test. */
  expression: string;
  /** How the real index is built, so the probe index is built the same way. */
  using: string;
  /** The index in the live schema this must match. */
  index: string;
};

const NAME_COLS = 'full_name text NOT NULL, deleted_at timestamptz';

const cases: Case[] = [
  {
    name: 'students_name_trgm_idx',
    columns: 'first_name text NOT NULL, last_name text, deleted_at timestamptz',
    expression: STUDENT_NAME_EXPR,
    using: 'gin ((%EXPR%) gin_trgm_ops)',
    index: 'students_name_trgm_idx',
  },
  {
    name: 'students_name_prefix_idx',
    columns: 'first_name text NOT NULL, last_name text, deleted_at timestamptz',
    expression: STUDENT_NAME_EXPR,
    using: 'btree ((%EXPR%) text_pattern_ops)',
    index: 'students_name_prefix_idx',
  },
  {
    name: 'guardians_name_trgm_idx',
    columns: NAME_COLS,
    expression: GUARDIAN_NAME_EXPR,
    using: 'gin ((%EXPR%) gin_trgm_ops)',
    index: 'guardians_name_trgm_idx',
  },
  {
    name: 'staff_name_trgm_idx',
    columns: NAME_COLS,
    expression: STAFF_NAME_EXPR,
    using: 'gin ((%EXPR%) gin_trgm_ops)',
    index: 'staff_name_trgm_idx',
  },
  {
    name: 'books_title_trgm_idx',
    columns: 'title text NOT NULL, author text, deleted_at timestamptz',
    expression: BOOK_TITLE_EXPR,
    using: 'gin ((%EXPR%) gin_trgm_ops)',
    index: 'books_title_trgm_idx',
  },
  {
    name: 'books_author_trgm_idx',
    columns: 'title text NOT NULL, author text, deleted_at timestamptz',
    expression: BOOK_AUTHOR_EXPR,
    using: 'gin ((%EXPR%) gin_trgm_ops)',
    index: 'books_author_trgm_idx',
  },
];

/** Postgres's own rendering of an index's expression. */
const RENDERED = `SELECT pg_get_expr(i.indexprs, i.indrelid) AS expr
                    FROM pg_index i WHERE i.indexrelid = $1::regclass`;

describe('search expressions match their indexes', () => {
  afterAll(async () => {
    await closePool();
  });

  for (const c of cases) {
    it(`${c.name} is built from the shared constant`, async () => {
      const { mine, live } = await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(`CREATE TEMP TABLE probe_tbl (${c.columns}) ON COMMIT DROP`);
          await client.query(
            `CREATE INDEX probe_idx ON probe_tbl USING ${c.using.replace('%EXPR%', c.expression)}` +
              ` WHERE deleted_at IS NULL`,
          );

          const a = await client.query<{ expr: string }>(RENDERED, ['probe_idx']);
          const b = await client.query<{ expr: string }>(RENDERED, [c.index]);
          return { mine: a.rows[0]?.expr ?? null, live: b.rows[0]?.expr ?? null };
        } finally {
          await client.query('ROLLBACK');
        }
      });

      expect(live, `${c.index} not found in the live schema`).not.toBeNull();
      expect(mine).toBe(live);
    });
  }
});
