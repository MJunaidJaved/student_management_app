/**
 * Migration runner.
 *
 * Wraps node-pg-migrate rather than invoking its CLI so that the .env loading
 * and validation in src/core/config is the single source of connection details,
 * and so migrations use `MIGRATION_DATABASE_URL` — the privileged connection —
 * rather than the limited role the application runs as.
 *
 * The baseline is a special case. Migration 001 describes a schema that already
 * exists, so on this database it must be *recorded* rather than run. Passing
 * `--mark-baseline` inserts the 001 row into the migrations table without
 * executing it, which is what makes the existing database look like one that
 * had been migrated from the start. It is a no-op if 001 is already recorded.
 *
 * Usage:
 *   npx tsx scripts/migrate.ts up
 *   npx tsx scripts/migrate.ts down
 *   npx tsx scripts/migrate.ts status
 *   npx tsx scripts/migrate.ts --mark-baseline
 */

import * as path from 'node:path';
import { Client } from 'pg';
import runner from 'node-pg-migrate';
import { config } from '../src/core/config';

const DIR = path.join(__dirname, '..', 'migrations');
const TABLE = 'pgmigrations';
const BASELINE = '001_baseline';

/** Migrations alter the schema, so they use the privileged connection. */
const databaseUrl = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
const ssl = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)
  ? undefined
  : { rejectUnauthorized: false };

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl, ...(ssl ? { ssl } : {}) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function markBaseline(): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         id serial PRIMARY KEY,
         name varchar(255) NOT NULL,
         run_on timestamp NOT NULL
       )`,
    );

    const existing = await client.query(`SELECT 1 FROM ${TABLE} WHERE name = $1`, [BASELINE]);
    if (existing.rowCount) {
      console.log(`${BASELINE} is already recorded; nothing to do.`);
      return;
    }

    // Only safe when the schema really is already there. Recording the baseline
    // against an empty database would skip creating 85 tables and leave every
    // later migration failing on a missing relation.
    const check = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'students'`,
    );
    if (check.rows[0]!.n === 0) {
      throw new Error(
        'Refusing to mark the baseline as applied: this database has no "students" table, ' +
          'so the schema is NOT already present. Run "migrate up" to build it instead.',
      );
    }

    await client.query(`INSERT INTO ${TABLE} (name, run_on) VALUES ($1, now())`, [BASELINE]);
    console.log(`Recorded ${BASELINE} as already applied (schema pre-existed).`);
  });
}

async function status(): Promise<void> {
  await withAdminClient(async (client) => {
    const exists = await client.query<{ ok: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS ok`, [TABLE],
    );
    if (!exists.rows[0]!.ok) {
      console.log('No migrations table yet; nothing has been applied.');
      return;
    }
    const rows = await client.query<{ name: string; run_on: string }>(
      `SELECT name, run_on::text FROM ${TABLE} ORDER BY id`,
    );
    console.log('Applied migrations:');
    for (const r of rows.rows) console.log(`  ${r.name}  (${r.run_on})`);
  });
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'up';

  if (arg === '--mark-baseline') return markBaseline();
  if (arg === 'status') return status();

  const direction = arg === 'down' ? 'down' : 'up';

  const applied = await runner({
    databaseUrl: { connectionString: databaseUrl, ...(ssl ? { ssl } : {}) },
    dir: DIR,
    migrationsTable: TABLE,
    direction,
    // Down is one step at a time on purpose: "undo everything" is not a thing
    // anyone means to type against a school database.
    count: direction === 'down' ? 1 : Infinity,
    // Each migration in its own transaction, so a failure part-way through a
    // batch leaves earlier migrations applied and recorded rather than half-done.
    singleTransaction: false,
    verbose: true,
  });

  if (applied.length === 0) {
    console.log('Nothing to do; already up to date.');
  } else {
    console.log(`\n${direction === 'up' ? 'Applied' : 'Reverted'}:`);
    for (const m of applied) console.log(`  ${m.name}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('MIGRATION FAILED\n', err instanceof Error ? err.message : err);
    process.exit(1);
  });
