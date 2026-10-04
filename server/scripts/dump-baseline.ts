/**
 * Generate `migrations/001_baseline.sql` from the live schema.
 *
 * The database was designed and created before this codebase existed, so there
 * is no migration history to replay. `pg_dump` is not available on this
 * machine, so the DDL is reconstructed from the catalogue instead.
 *
 * Where Postgres can render a definition itself — constraints, indexes,
 * functions, triggers — its own output is used verbatim rather than rebuilt
 * from parts. Those renderers are exact, and hand-assembling a CHECK expression
 * or a partial-index predicate is precisely where a baseline silently drifts
 * from the database it claims to describe.
 *
 * The output is ordered so it can build an empty database from scratch:
 * extensions, standalone sequences, functions, tables, constraints, indexes,
 * then triggers. Constraints come after every table so a circular foreign key
 * cannot make the order unsatisfiable.
 *
 * Run: npx tsx scripts/dump-baseline.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SYSTEM_ACTOR, readTransaction } from '../src/core/db/uow';
import { closePool } from '../src/core/db/pool';

const OUT = path.join(__dirname, '..', 'migrations', '001_baseline.sql');

/** Sequences owned by a serial/identity column are recreated with their table. */
const STANDALONE_SEQUENCE = /^seq_/;

type Column = {
  table_name: string;
  column_name: string;
  type: string;
  notnull: boolean;
  default_expr: string | null;
  identity: string | null;
};

async function main(): Promise<void> {
  const sql = await readTransaction(SYSTEM_ACTOR, async (uow) => {
    const out: string[] = [];

    out.push(
      '-- 001_baseline.sql',
      '--',
      '-- The schema as it stood when the backend was built, reconstructed from',
      '-- the live database. This is the starting point: every later change is a',
      '-- numbered migration on top of it.',
      '--',
      '-- On the existing database this migration is recorded as already applied',
      '-- rather than run (see scripts/mark-baseline-applied.ts). It is executed',
      '-- only when building a fresh database, such as a test one.',
      '--',
      `-- Generated ${new Date().toISOString()}`,
      '',
      '-- Up Migration',
      '',
    );

    const extensions = await uow.many<{ extname: string; nspname: string }>(
      `SELECT e.extname, n.nspname
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql' ORDER BY 1`,
    );
    out.push('-- Extensions', ...extensions.map(
      (e) => `CREATE EXTENSION IF NOT EXISTS "${e.extname}" WITH SCHEMA ${e.nspname};`), '');

    const sequences = await uow.many<{
      sequencename: string; data_type: string; start_value: string; increment_by: string;
    }>(
      `SELECT sequencename, data_type::text, start_value::text, increment_by::text
         FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
    );
    const standalone = sequences.filter((s) => STANDALONE_SEQUENCE.test(s.sequencename));
    out.push('-- Human-readable number sequences (admission no, receipt no, and so on)');
    for (const s of standalone) {
      out.push(
        `CREATE SEQUENCE IF NOT EXISTS public.${s.sequencename} AS ${s.data_type}` +
        ` START WITH ${s.start_value} INCREMENT BY ${s.increment_by};`);
    }
    out.push('');

    /* Functions before tables: the triggers added at the end reference them,
     * and a CHECK or DEFAULT may call one too. */
    const functions = await uow.many<{ def: string }>(
      `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          -- Functions belonging to an extension are created by the extension.
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname`,
    );
    out.push('-- Trigger and helper functions');
    for (const f of functions) out.push(f.def.trimEnd() + ';', '');

    const columns = await uow.many<Column>(
      `SELECT c.relname                                   AS table_name,
              a.attname                                   AS column_name,
              format_type(a.atttypid, a.atttypmod)        AS type,
              a.attnotnull                                AS notnull,
              pg_get_expr(ad.adbin, ad.adrelid)           AS default_expr,
              NULLIF(a.attidentity, '')                   AS identity
         FROM pg_attribute a
         JOIN pg_class c      ON c.oid = a.attrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad   ON ad.adrelid = c.oid AND ad.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
    );

    const byTable = new Map<string, Column[]>();
    for (const col of columns) {
      const list = byTable.get(col.table_name) ?? [];
      list.push(col);
      byTable.set(col.table_name, list);
    }

    out.push('-- Tables');
    for (const [table, cols] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
      const lines = cols.map((col) => {
        let line = `  ${col.column_name} ${col.type}`;
        if (col.identity) {
          // 'a' is ALWAYS, 'd' is BY DEFAULT.
          line += ` GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
        } else if (col.default_expr) {
          line += ` DEFAULT ${col.default_expr}`;
        }
        if (col.notnull) line += ' NOT NULL';
        return line;
      });
      out.push(`CREATE TABLE IF NOT EXISTS public.${table} (`, lines.join(',\n'), ');', '');
    }

    /* Constraints after all tables. Primary keys first so the unique indexes
     * they create exist before a foreign key points at them. */
    const constraints = await uow.many<{ tbl: string; name: string; def: string; kind: string }>(
      `SELECT rel.relname AS tbl, con.conname AS name,
              pg_get_constraintdef(con.oid) AS def, con.contype::text AS kind
         FROM pg_constraint con
         JOIN pg_class rel     ON rel.oid = con.conrelid
         JOIN pg_namespace n   ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND con.contype IN ('p','u','f','c','x')
        ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'x' THEN 2
                                  WHEN 'c' THEN 3 ELSE 4 END,
                 rel.relname, con.conname`,
    );
    out.push('-- Constraints');
    for (const c of constraints) {
      out.push(
        `ALTER TABLE public.${c.tbl} ADD CONSTRAINT ${c.name} ${c.def};`);
    }
    out.push('');

    /* Indexes that are not already implied by a constraint. Filtering by
     * conindid rather than by name, because a constraint's backing index does
     * not have to share its name. */
    const indexes = await uow.many<{ indexdef: string }>(
      `SELECT i.indexdef
         FROM pg_indexes i
         JOIN pg_class c     ON c.relname = i.indexname
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
        WHERE i.schemaname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = c.oid)
        ORDER BY i.tablename, i.indexname`,
    );
    out.push('-- Indexes');
    for (const i of indexes) out.push(i.indexdef + ';');
    out.push('');

    const triggers = await uow.many<{ def: string }>(
      `SELECT pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
         JOIN pg_class c     ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`,
    );
    out.push('-- Triggers');
    for (const t of triggers) out.push(t.def + ';');

    out.push(
      '',
      '-- Row level security is deliberately NOT enabled here. It is enforced in',
      '-- the service and policy layer instead; see docs/00-README-INDEX.md.',
      '',
      '-- Down Migration',
      '--',
      '-- There is deliberately no down migration for the baseline. Reversing it',
      '-- means dropping every table in the school database, which is not an',
      '-- operation that should be one mistyped command away. Rebuild from this',
      '-- file into a fresh database instead.',
      "SELECT 'the baseline migration cannot be reversed' AS refused;",
      '',
    );

    return { text: out.join('\n'), counts: {
      extensions: extensions.length,
      sequences: standalone.length,
      functions: functions.length,
      tables: byTable.size,
      constraints: constraints.length,
      indexes: indexes.length,
      triggers: triggers.length,
    } };
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, sql.text, 'utf8');

  console.log(`Wrote ${OUT}`);
  console.log(JSON.stringify(sql.counts, null, 1));
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
