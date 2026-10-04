/**
 * The connection pool.
 *
 * Ported from the old POS `cloud/db/pg.js`, which had already paid for two
 * lessons worth keeping:
 *
 *   1. **`pg` returns bigint and numeric as strings** to avoid silent precision
 *      loss. That is the behaviour we want for money — see core/money — but it
 *      means every aggregate has to be cast in SQL (`COUNT(*)::int`) rather
 *      than parsed afterwards, so the shape is right at the source. The one
 *      thing never to do is register a numeric parser that returns a float.
 *
 *   2. **Session settings must be applied on checkout, not on connect.**
 *      `pool.on('connect')` races the query the pool is already dispatching on
 *      that client, and startup `options` / `ALTER ROLE` are both accepted and
 *      then silently ignored through Supabase's pooler, which reports the old
 *      value as if nothing happened. A WeakSet keyed on the client means an
 *      established connection pays for this once.
 *
 * This relies on the **session** pooler (port 5432). In transaction mode a SET
 * would not outlive the statement.
 */

import { Pool, type PoolClient, types } from 'pg';
import { config } from '../config';
import { logger } from '../logging/logger';

/*
 * `timestamptz` and `date` arrive as JavaScript Dates by default, which applies
 * the server process's local zone and quietly shifts a date by a day either
 * side of midnight. Part 5.3 requires ISO 8601 UTC on the wire, so both are
 * kept as the strings Postgres sent and converted deliberately.
 */
const OID_DATE = 1082;
const OID_TIMESTAMPTZ = 1184;
const OID_TIMESTAMP = 1114;
types.setTypeParser(OID_DATE, (v) => v);
types.setTypeParser(OID_TIMESTAMPTZ, (v) => v);
types.setTypeParser(OID_TIMESTAMP, (v) => v);

/** Supabase terminates TLS with its own chain; a local Postgres has no TLS at all. */
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(config.DATABASE_URL);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: config.PGPOOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/*
 * A dropped idle connection must not take the process down. Supabase recycles
 * idle connections, and an unhandled 'error' on an idle client is a hard crash
 * in Node.
 */
pool.on('error', (err) => {
  logger.error({ err: err.message }, 'Idle Postgres client error (recovering)');
});

const configured = new WeakSet<PoolClient>();

/**
 * Settings every connection needs, applied once per pooled client.
 *
 * `extra_float_digits` matters because without it Postgres truncates floats to
 * 15 significant digits on the wire. The timeouts are the protection Part 5.2
 * asks for: a statement that runs away is cancelled rather than holding a
 * connection, and `idle_in_transaction_session_timeout` covers the case where
 * this process dies mid-transaction and the pooler keeps the server connection
 * alive holding locks, which blocks the next deploy with nothing reporting why.
 */
async function configureClient(client: PoolClient): Promise<void> {
  if (configured.has(client)) return;
  await client.query('SET extra_float_digits = 3');
  await client.query(`SET statement_timeout = ${config.DB_STATEMENT_TIMEOUT_MS}`);
  await client.query(`SET lock_timeout = ${config.DB_LOCK_TIMEOUT_MS}`);
  await client.query("SET idle_in_transaction_session_timeout = '30s'");
  configured.add(client);
}

/** Check out a client, guarantee its release. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await configureClient(client);
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
