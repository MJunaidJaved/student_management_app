/**
 * Prove `001_baseline.sql` can actually build the schema from nothing.
 *
 * A baseline nobody has executed is a guess. There is only one database here,
 * so it is applied into a throwaway schema inside a transaction that is always
 * rolled back: the real schema is never touched, and nothing is left behind
 * even if this crashes.
 *
 * The DDL is re-pointed from `public.` to the probe schema. Unqualified
 * references inside constraint and function definitions resolve through
 * `search_path`, which is why the probe schema is put in front of `public`
 * rather than replacing it — the `btree_gist` operators the EXCLUDE constraints
 * need still live in `public`.
 *
 * Run: npx tsx scripts/verify-baseline.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withClient, closePool } from '../src/core/db/pool';

const PROBE = 'baseline_probe';
const FILE = path.join(__dirname, '..', 'migrations', '001_baseline.sql');

async function main(): Promise<void> {
  const raw = fs.readFileSync(FILE, 'utf8');

  // Only the up section. Everything from the down marker on is commentary and a
  // deliberate refusal, neither of which belongs in a build.
  const upOnly = raw.split(/^-- Down Migration$/m)[0] ?? raw;

  const body = upOnly
    .replace(/^-- Up Migration$/m, '')
    // Extensions are already installed and are schema-qualified to public on
    // purpose, so leave those lines alone while re-pointing everything else.
    .split('\n')
    .map((line) => (line.startsWith('CREATE EXTENSION') ? line : line.replace(/\bpublic\./g, `${PROBE}.`)))
    .join('\n');

  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`CREATE SCHEMA ${PROBE}`);
      await client.query(`SET LOCAL search_path = ${PROBE}, public`);
      await client.query(body);

      const counts = await client.query<{ tables: number; triggers: number; constraints: number }>(
        `SELECT (SELECT count(*)::int FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND c.relkind = 'r')          AS tables,
                (SELECT count(*)::int FROM pg_trigger t
                   JOIN pg_class c ON c.oid = t.tgrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND NOT t.tgisinternal)       AS triggers,
                (SELECT count(*)::int FROM pg_constraint con
                   JOIN pg_class rel ON rel.oid = con.conrelid
                   JOIN pg_namespace n ON n.oid = rel.relnamespace
                  WHERE n.nspname = $1)                              AS constraints`,
        [PROBE],
      );

      const live = await client.query<{ tables: number }>(
        `SELECT count(*)::int AS tables FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      );

      const built = counts.rows[0]!;
      console.log('Baseline applied into a fresh schema successfully.');
      console.log(`  tables      ${built.tables} (live public: ${live.rows[0]!.tables})`);
      console.log(`  triggers    ${built.triggers}`);
      console.log(`  constraints ${built.constraints}`);

      // A guard trigger has to work in the rebuilt schema, not merely exist.
      await client.query(
        `INSERT INTO ${PROBE}.audit_logs (action, table_name, record_id) VALUES ('insert','probe','1')`,
      );
      let guardFired = false;
      try {
        await client.query(`UPDATE ${PROBE}.audit_logs SET action = 'x'`);
      } catch (err) {
        guardFired = /append-only/i.test((err as Error).message);
      }
      console.log(`  append-only guard active in rebuilt schema: ${guardFired ? 'yes' : 'NO'}`);

      if (built.tables !== live.rows[0]!.tables || !guardFired) {
        throw new Error('baseline did not reproduce the schema faithfully');
      }
    } finally {
      // Always. The probe schema must not survive this script under any outcome.
      await client.query('ROLLBACK');
    }
  });

  await closePool();
}

main().catch(async (err) => {
  console.error('BASELINE VERIFICATION FAILED\n', err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
