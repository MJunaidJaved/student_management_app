/**
 * Tools for the local primary / cloud mirror pair (see src/core/sync).
 *
 *   tsx scripts/sync.ts status      pending changes, migration state on both sides
 *   tsx scripts/sync.ts verify      compare every table (row count + checksum) on both sides
 *   tsx scripts/sync.ts drain       push everything pending now, then exit
 *   tsx scripts/sync.ts pull        replace ALL local data with a copy of the cloud's
 *   tsx scripts/sync.ts push-full   replace ALL cloud data with a copy of the local's
 *
 * `pull` and `push-full` are for (re)initialising a side; day-to-day
 * replication is the worker started by the server. Both copy in replica mode,
 * so no triggers fire and the target ends up row-for-row identical, sequences
 * included.
 */

import { Client } from 'pg';
import { config } from '../src/core/config';
import { closePool, withClient } from '../src/core/db/pool';
import { CloudSync, pendingChanges } from '../src/core/sync/cloud-sync';
import { ident, loadTableMeta, readSequences, upsertRows, writeSequences, type TableMeta } from '../src/core/sync/replica';

const cloudUrl = config.CLOUD_DATABASE_URL;
if (!cloudUrl) throw new Error('CLOUD_DATABASE_URL is not set');

const isLocal = (u: string) => /@(localhost|127\.0\.0\.1)[:/]/.test(u);

async function connect(url: string): Promise<Client> {
  for (let attempt = 1; ; attempt++) {
    const c = new Client({
      connectionString: url,
      ssl: isLocal(url) ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 60_000,
      keepAlive: true,
      statement_timeout: 600_000,
    });
    c.on('error', () => {});
    try {
      await c.connect();
      await c.query(`SET TIME ZONE 'UTC'; SET extra_float_digits = 3`);
      return c;
    } catch (err) {
      await c.end().catch(() => {});
      if (attempt >= 6) throw err;
      console.log(`  connect retry ${attempt}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const local = () => connect(config.DATABASE_URL);
const cloud = () => connect(cloudUrl!);

async function migrations(c: Client): Promise<string[]> {
  return (await c.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY name`)).rows.map((r) => r.name);
}

async function status() {
  const [l, c] = [await local(), await cloud()];
  const [lm, cm] = [await migrations(l), await migrations(c)];
  console.log(`Local migrations: ${lm.length} (last ${lm.at(-1)})`);
  console.log(`Cloud migrations: ${cm.length} (last ${cm.at(-1)})`);
  console.log(lm.join() === cm.join() ? 'Migrations: in step' : 'Migrations: DIFFER (sync is paused until they match)');
  const p = await l.query<{ n: number; oldest: string | null }>(
    `SELECT count(*)::int AS n, min(created_at)::text AS oldest FROM sync_changelog`,
  );
  console.log(`Pending changes: ${p.rows[0]!.n}${p.rows[0]!.oldest ? ` (oldest ${p.rows[0]!.oldest})` : ''}`);
  await Promise.all([l.end(), c.end()]);
}

/** Row count and an order-independent-of-storage checksum of every row's JSON image. */
async function fingerprint(c: Client, t: TableMeta): Promise<{ n: number; md5: string | null }> {
  const order = t.pk.map((k) => `t.${ident(k)}`).join(', ');
  const r = await c.query<{ n: number; md5: string | null }>(
    `SELECT count(*)::int AS n, md5(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY ${order})) AS md5 FROM public.${ident(t.name)} t`,
  );
  return r.rows[0]!;
}

async function verify(): Promise<boolean> {
  const [l, c] = [await local(), await cloud()];
  const [lt, ct] = [await loadTableMeta(l), await loadTableMeta(c)];
  let ok = true;
  const onlyLocal = [...lt.keys()].filter((t) => !ct.has(t));
  const onlyCloud = [...ct.keys()].filter((t) => !lt.has(t));
  if (onlyLocal.length) { ok = false; console.log(`Only on local: ${onlyLocal.join(', ')}`); }
  if (onlyCloud.length) { ok = false; console.log(`Only on cloud: ${onlyCloud.join(', ')}`); }
  let rows = 0;
  for (const t of [...lt.values()].filter((t) => ct.has(t.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const [a, b] = [await fingerprint(l, t), await fingerprint(c, t)];
    rows += a.n;
    if (a.n !== b.n || a.md5 !== b.md5) {
      ok = false;
      console.log(`MISMATCH ${t.name}: local ${a.n} rows, cloud ${b.n} rows${a.n === b.n ? ' (contents differ)' : ''}`);
    }
  }
  const [ls, cs] = [await readSequences(l), await readSequences(c)];
  const cmap = new Map(cs.map((s) => [s.s, `${s.v}/${s.called}`]));
  for (const s of ls) {
    if (cmap.has(s.s) && cmap.get(s.s) !== `${s.v}/${s.called}`) {
      ok = false;
      console.log(`SEQUENCE ${s.s}: local ${s.v}, cloud ${cmap.get(s.s)}`);
    }
  }
  console.log(ok ? `IDENTICAL: ${lt.size} tables, ${rows} rows, ${ls.length} sequences` : 'NOT identical');
  await Promise.all([l.end(), c.end()]);
  return ok;
}

/** Replace every row in `target` with the rows of `source`. Tables missing on either side are skipped. */
async function copyAll(source: Client, target: Client, label: string): Promise<void> {
  const [st, tt] = [await loadTableMeta(source), await loadTableMeta(target)];
  const tables = [...tt.values()].filter((t) => st.has(t.name));
  await target.query('BEGIN');
  try {
    await target.query('SET LOCAL session_replication_role = replica');
    await target.query(`TRUNCATE ${tables.map((t) => `public.${ident(t.name)}`).join(', ')}`);
    let total = 0;
    for (const t of tables) {
      const res = await source.query<{ j: string }>(`SELECT to_jsonb(t)::text AS j FROM public.${ident(t.name)} t`);
      const rows = res.rows.map((r) => r.j);
      for (let i = 0; i < rows.length; i += 2000) await upsertRows(target, t, rows.slice(i, i + 2000));
      total += rows.length;
      if (rows.length) console.log(`  ${t.name}: ${rows.length}`);
    }
    await writeSequences(target, await readSequences(source));
    await target.query('COMMIT');
    console.log(`${label}: copied ${total} rows across ${tables.length} tables`);
  } catch (err) {
    await target.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function pull() {
  const [l, c] = [await local(), await cloud()];
  // Read the whole cloud side in one snapshot so the copy is consistent.
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await copyAll(c, l, 'pull');
  await c.query('COMMIT');
  // The copy was made in replica mode, so it captured nothing; clear any
  // changes recorded before it, which the copy has superseded.
  await l.query('TRUNCATE sync_changelog');
  await Promise.all([l.end(), c.end()]);
}

async function pushFull() {
  const [l, c] = [await local(), await cloud()];
  if ((await migrations(l)).join() !== (await migrations(c)).join()) {
    throw new Error('Migrations differ; run "npm run migrate:up -- --cloud" first');
  }
  await l.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  // Everything this snapshot can see is in the copy, so changes logged by
  // transactions it can see are superseded. Later ones still replay.
  const seen = await l.query<{ ids: string[] }>(`SELECT coalesce(array_agg(id::text), '{}') AS ids FROM sync_changelog`);
  await copyAll(l, c, 'push-full');
  await l.query('COMMIT');
  await l.query(`DELETE FROM sync_changelog WHERE id = ANY($1::bigint[])`, [seen.rows[0]!.ids]);
  await Promise.all([l.end(), c.end()]);
}

async function drain() {
  const s = new CloudSync(cloudUrl!);
  const n = await s.drainAll();
  await s.disconnect();
  console.log(`Applied ${n} changes; ${await pendingChanges()} pending`);
}

const commands: Record<string, () => Promise<unknown>> = { status, verify, pull, 'push-full': pushFull, drain };
const cmd = process.argv[2] ?? 'status';
if (!commands[cmd]) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(2);
}
console.log(`Local: ${new URL(config.DATABASE_URL).host}  Cloud: ${new URL(cloudUrl).host}`);
commands[cmd]!()
  .then(async (r) => {
    await closePool();
    process.exit(r === false ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exit(1);
  });
