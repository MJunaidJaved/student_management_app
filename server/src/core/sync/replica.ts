/**
 * Shared machinery for writing rows into a replica database (the cloud mirror):
 * table metadata, set-based upsert/delete, and sequence alignment.
 *
 * Rows travel as JSON images (`to_jsonb(row)`) and are turned back into typed
 * rows on the target with `jsonb_populate_recordset(NULL::table, ...)`, so every
 * column type round-trips exactly — timestamptz keeps its offset, numeric keeps
 * every digit, bytea travels as hex.
 *
 * Used by the live worker (cloud-sync.ts) and the one-off tools
 * (scripts/sync.ts).
 */

import type { ClientBase } from 'pg';

export type TableMeta = {
  name: string;
  /** Insertable columns: excludes dropped and generated columns. */
  columns: string[];
  pk: string[];
};

export const EXCLUDED_TABLES = new Set(['sync_changelog', 'pgmigrations']);

export const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export async function loadTableMeta(db: ClientBase): Promise<Map<string, TableMeta>> {
  const res = await db.query<{ name: string; columns: string[]; pk: string[] | null }>(`
    SELECT c.relname AS name,
           array_agg(a.attname::text ORDER BY a.attnum) AS columns,
           (SELECT array_agg(pa.attname::text ORDER BY k.ord)
              FROM pg_index i
              CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute pa ON pa.attrelid = i.indrelid AND pa.attnum = k.attnum
             WHERE i.indrelid = c.oid AND i.indisprimary) AS pk
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     GROUP BY c.oid, c.relname`);
  const out = new Map<string, TableMeta>();
  for (const r of res.rows) {
    if (EXCLUDED_TABLES.has(r.name)) continue;
    if (!r.pk?.length) throw new Error(`Table ${r.name} has no primary key; it cannot be replicated`);
    out.set(r.name, { name: r.name, columns: r.columns, pk: r.pk });
  }
  return out;
}

/**
 * Rows are passed as JSON text (one object per row), never as parsed objects:
 * JSON.parse would turn a numeric like 12345678901234567.89 into a float.
 */
const jsonArray = (rows: string[]): string => `[${rows.join(',')}]`;

/** Insert-or-replace by primary key. `rows` must hold at most one image per key. */
export async function upsertRows(db: ClientBase, t: TableMeta, rows: string[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = t.columns.map(ident).join(', ');
  const nonKey = t.columns.filter((c) => !t.pk.includes(c));
  const onConflict = nonKey.length
    ? `DO UPDATE SET ${nonKey.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`
    : 'DO NOTHING';
  await db.query(
    `INSERT INTO public.${ident(t.name)} (${cols}) OVERRIDING SYSTEM VALUE
     SELECT ${cols} FROM jsonb_populate_recordset(NULL::public.${ident(t.name)}, $1::jsonb)
     ON CONFLICT (${t.pk.map(ident).join(', ')}) ${onConflict}`,
    [jsonArray(rows)],
  );
}

export async function deleteRows(db: ClientBase, t: TableMeta, rows: string[]): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `DELETE FROM public.${ident(t.name)} AS t
      USING jsonb_populate_recordset(NULL::public.${ident(t.name)}, $1::jsonb) AS d
      WHERE ${t.pk.map((c) => `t.${ident(c)} = d.${ident(c)}`).join(' AND ')}`,
    [jsonArray(rows)],
  );
}

export type SequenceState = { s: string; v: string; called: boolean };

/** Every sequence in public, as setval arguments (an unused one is reset to its start). */
export async function readSequences(db: ClientBase): Promise<SequenceState[]> {
  const res = await db.query<SequenceState>(`
    SELECT sequencename::text AS s,
           COALESCE(last_value, start_value)::text AS v,
           last_value IS NOT NULL AS called
      FROM pg_sequences
     WHERE schemaname = 'public'
       -- Each side numbers its own migration history and change log.
       AND sequencename NOT IN ('pgmigrations_id_seq', 'sync_changelog_id_seq')`);
  return res.rows;
}

export async function writeSequences(db: ClientBase, seqs: SequenceState[]): Promise<void> {
  if (seqs.length === 0) return;
  await db.query(
    `SELECT setval(format('public.%I', x.s), x.v, x.called)
       FROM jsonb_to_recordset($1::jsonb) AS x(s text, v bigint, called boolean)
      WHERE to_regclass(format('public.%I', x.s)) IS NOT NULL`,
    [JSON.stringify(seqs)],
  );
}

/** The key of a row image (JSON text), as a stable string. Keys are ids/uuids/text, so parsing is exact. */
export function pkKey(t: TableMeta, rowJson: string): string {
  const row = JSON.parse(rowJson) as Record<string, unknown>;
  return JSON.stringify(t.pk.map((c) => row[c]));
}
