/**
 * Runs the local PostgreSQL the app uses as its primary database.
 *
 *   tsx scripts/local-db.ts init     create the cluster and the app database (once)
 *   tsx scripts/local-db.ts start    start it (no-op when already running)
 *   tsx scripts/local-db.ts stop
 *   tsx scripts/local-db.ts status
 *
 * Binaries: PG_HOME (default ~/.local/pg/17, a PostgreSQL 17.6 build matching
 * the cloud server). Data: PG_DATA (default ~/.local/pg/data). The role,
 * password, port and database name are all taken from DATABASE_URL in .env, so
 * there is a single source of truth for how the app reaches the database.
 *
 * The cluster listens on localhost only, uses scram-sha-256 password auth, and
 * runs in UTC so timestamps render identically to the cloud copy.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../src/core/config';

const PG_HOME = process.env.PG_HOME ?? join(homedir(), '.local', 'pg', '17');
const PG_DATA = process.env.PG_DATA ?? join(homedir(), '.local', 'pg', 'data');
const bin = (name: string) => join(PG_HOME, 'bin', `${name}.exe`);

function target() {
  const u = new URL(config.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('DATABASE_URL does not point at localhost; refusing to manage it as the local database');
  }
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    port: Number(u.port || 5432),
    database: u.pathname.slice(1),
  };
}

function run(cmd: string, args: string[], allowFail = false) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args[0] ?? ''} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

function isRunning(): boolean {
  if (!existsSync(join(PG_DATA, 'PG_VERSION'))) return false;
  return run(bin('pg_ctl'), ['status', '-D', PG_DATA], true).status === 0;
}

async function init() {
  const t = target();
  if (existsSync(join(PG_DATA, 'PG_VERSION'))) {
    console.log(`Cluster already exists at ${PG_DATA}`);
  } else {
    const tmp = mkdtempSync(join(tmpdir(), 'pginit-'));
    const pwfile = join(tmp, 'pw');
    writeFileSync(pwfile, t.password);
    try {
      run(bin('initdb'), [
        '-D', PG_DATA, '-U', t.user, `--pwfile=${pwfile}`,
        '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', '--no-instructions',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    appendFileSync(
      join(PG_DATA, 'postgresql.conf'),
      [
        '',
        '# --- student_management_app ---',
        `port = ${t.port}`,
        "listen_addresses = 'localhost'",
        "timezone = 'UTC'",
        "log_timezone = 'UTC'",
        'max_connections = 50',
        "shared_preload_libraries = 'pg_stat_statements'",
        '',
      ].join('\n'),
    );
    console.log(`Initialised cluster at ${PG_DATA}`);
  }
  await start();
  const c = new Client({ host: 'localhost', port: t.port, user: t.user, password: t.password, database: 'postgres' });
  await c.connect();
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [t.database]);
  if (exists.rowCount === 0) {
    await c.query(`CREATE DATABASE "${t.database.replace(/"/g, '""')}"`);
    console.log(`Created database ${t.database}`);
  }
  await c.end();
}

async function start() {
  if (isRunning()) {
    console.log('Local Postgres is running');
    return;
  }
  if (!existsSync(join(PG_DATA, 'PG_VERSION'))) {
    throw new Error(`No cluster at ${PG_DATA}. Run: npm run db:local -- init`);
  }
  // stdio must not be piped: the postmaster inherits the handles and spawnSync
  // would then wait for the server to exit.
  const r = spawnSync(bin('pg_ctl'), ['start', '-D', PG_DATA, '-l', join(PG_DATA, 'server.log'), '-w', '-t', '60'], {
    stdio: 'ignore',
  });
  if (r.status !== 0) throw new Error(`pg_ctl start failed; see ${join(PG_DATA, 'server.log')}`);
  console.log('Started local Postgres');
}

function stop() {
  if (!isRunning()) {
    console.log('Local Postgres is not running');
    return;
  }
  run(bin('pg_ctl'), ['stop', '-D', PG_DATA, '-m', 'fast', '-w']);
  console.log('Stopped local Postgres');
}

const cmd = process.argv[2] ?? 'status';
const actions: Record<string, () => unknown> = {
  init,
  start,
  stop,
  status: () => console.log(isRunning() ? 'running' : 'stopped'),
};
if (!actions[cmd]) {
  console.error(`Unknown command "${cmd}". Use: init | start | stop | status`);
  process.exit(2);
}
Promise.resolve(actions[cmd]()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
