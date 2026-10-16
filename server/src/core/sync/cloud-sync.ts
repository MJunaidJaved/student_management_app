/**
 * Replicates the local primary database onto the cloud mirror.
 *
 * Every committed local change sits in `sync_changelog` (see migration 015).
 * This worker drains it in id order, applying each batch to the cloud inside a
 * single cloud transaction, and deletes the batch locally only after the cloud
 * has committed. So:
 *
 *   - nothing is lost: a change leaves the local log only once the cloud holds it;
 *   - nothing is applied twice in a harmful way: a crash between the cloud
 *     commit and the local delete replays the batch, and replay is idempotent
 *     (upserts and deletes of whole row images, in their original order);
 *   - bursts are absorbed: the log is the queue. A burst of writes, or a long
 *     outage, only makes the log longer; the worker catches up batch by batch,
 *     merging repeated changes to the same row within a batch;
 *   - a bad batch is never skipped: it is retried with backoff until it
 *     applies, and the error is surfaced in the status.
 *
 * Ordering: only rows from transactions that have finished are taken, and
 * only the prefix of the log that precedes the oldest unfinished transaction's
 * first row, so a long-running transaction can never have its changes applied
 * out of order behind a later one.
 *
 * Changes are applied with `session_replication_role = replica`, so the cloud's
 * own triggers (audit, updated_at, change capture, foreign-key checks) do not
 * fire: the mirror receives exactly the rows the primary holds. If the cloud
 * role may not set that, user triggers are disabled for the tables a batch
 * touches, inside the batch's transaction.
 *
 * Schema changes are not replicated: migrations run against both databases
 * (`npm run migrate:up` and `npm run migrate:up -- --cloud`). The worker
 * compares the applied migrations on both sides and pauses, rather than
 * guessing, while they differ.
 */

import { Client } from 'pg';
import { withClient } from '../db/pool';
import { logger } from '../logging/logger';
import {
  deleteRows,
  ident,
  loadTableMeta,
  pkKey,
  readSequences,
  upsertRows,
  writeSequences,
  type SequenceState,
  type TableMeta,
} from './replica';

type LogRow = { id: string; table_name: string; op: 'I' | 'U' | 'D' | 'T'; row_data: string | null; old_data: string | null };

type Step =
  | { kind: 'up'; table: string; rows: string[] }
  | { kind: 'del'; table: string; rows: string[] }
  | { kind: 'trunc'; table: string };

export type SyncState = 'starting' | 'idle' | 'syncing' | 'paused' | 'retrying' | 'stopped';

export type SyncStatus = {
  state: SyncState;
  lastSyncedAt: string | null;
  lastError: string | null;
  appliedSinceStart: number;
  replicationMode: 'replica' | 'disable-triggers' | null;
};

const BATCH_ROWS = 1000;
const BATCH_BYTES = 4 * 1024 * 1024;
const IDLE_POLL_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
const PAUSED_RECHECK_MS = 60_000;

class PausedError extends Error {}

/** Taking rows: finished transactions only, and never past the oldest unfinished one. */
const FETCH_SQL = `
  WITH snap AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin),
       fence AS (SELECT min(l.id) AS id FROM sync_changelog l, snap WHERE l.txid >= snap.xmin)
  SELECT l.id::text AS id, l.table_name, l.op, l.row_data::text AS row_data, l.old_data::text AS old_data
    FROM sync_changelog l, snap, fence
   WHERE l.txid < snap.xmin AND (fence.id IS NULL OR l.id < fence.id)
   ORDER BY l.id
   LIMIT $1`;

const isUniqueish = (err: unknown): boolean =>
  ['23505', '23P01', '23503'].includes((err as { code?: string }).code ?? '');

export class CloudSync {
  private cloud: Client | null = null;
  private tables = new Map<string, TableMeta>();
  private sentSequences = new Map<string, string>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly st: SyncStatus = {
    state: 'stopped',
    lastSyncedAt: null,
    lastError: null,
    appliedSinceStart: 0,
    replicationMode: null,
  };

  constructor(private readonly cloudUrl: string) {}

  async status(): Promise<SyncStatus & { pending: number }> {
    return { ...this.st, pending: await pendingChanges() };
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.st.state = 'starting';
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop?.catch(() => {});
    this.loop = null;
    await this.disconnect();
    this.st.state = 'stopped';
  }

  /** Nudge the worker to look for work now rather than at its next poll. */
  poke(): void {
    this.wake?.();
  }

  /** Apply everything currently committed. Used by tools and tests; not alongside start(). */
  async drainAll(): Promise<number> {
    let total = 0;
    for (;;) {
      await this.ensureConnected();
      const n = await this.applyBatch();
      total += n;
      if (n === 0) return total;
    }
  }

  async disconnect(): Promise<void> {
    const c = this.cloud;
    this.cloud = null;
    this.sentSequences.clear();
    if (c) await c.end().catch(() => {});
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopping) {
      try {
        await this.ensureConnected();
        const n = await this.applyBatch();
        backoff = 1000;
        if (n === 0) {
          this.st.state = 'idle';
          await this.sleep(IDLE_POLL_MS);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.st.lastError = message;
        await this.disconnect();
        if (err instanceof PausedError) {
          this.st.state = 'paused';
          logger.warn({ reason: message }, 'Cloud sync paused');
          await this.sleep(PAUSED_RECHECK_MS);
        } else {
          this.st.state = 'retrying';
          logger.error({ err: message, retryInMs: backoff }, 'Cloud sync batch failed; will retry');
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.cloud) return;
    const c = new Client({
      connectionString: this.cloudUrl,
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(this.cloudUrl) ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 300_000,
      application_name: 'sms-cloud-sync',
    });
    // A dropped socket surfaces through the next awaited query; this only stops
    // an idle-time 'error' event from crashing the process.
    c.on('error', (err) => logger.warn({ err: err.message }, 'Cloud sync connection error'));
    await c.connect();
    try {
      await this.preflight(c);
    } catch (err) {
      await c.end().catch(() => {});
      throw err;
    }
    this.cloud = c;
    this.st.lastError = null;
  }

  private async preflight(c: Client): Promise<void> {
    await c.query(`SET TIME ZONE 'UTC'; SET extra_float_digits = 3; SET idle_in_transaction_session_timeout = '120s'`);
    try {
      await c.query(`SET session_replication_role = replica`);
      this.st.replicationMode = 'replica';
    } catch {
      this.st.replicationMode = 'disable-triggers';
    }

    const [local, remote] = await Promise.all([
      withClient((l) => l.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY name`)),
      c.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY name`),
    ]);
    const l = local.rows.map((r) => r.name).join(',');
    const r = remote.rows.map((r) => r.name).join(',');
    if (l !== r) {
      const lastLocal = local.rows.at(-1)?.name;
      const lastCloud = remote.rows.at(-1)?.name;
      throw new PausedError(
        `migrations differ (local at ${lastLocal}, cloud at ${lastCloud}); run "npm run migrate:up -- --cloud"`,
      );
    }

    this.tables = await loadTableMeta(c);
    // The cloud copy never originates changes, so anything its own capture
    // triggers recorded (direct edits, migrations) is noise.
    await c.query(`TRUNCATE sync_changelog`);
    logger.info({ mode: this.st.replicationMode, tables: this.tables.size }, 'Cloud sync connected');
  }

  /** Applies one batch. Returns the number of log rows it consumed. */
  private async applyBatch(): Promise<number> {
    const rows = await fetchBatch();
    if (rows.length === 0) return 0;
    this.st.state = 'syncing';

    try {
      await this.applyInTransaction(this.plan(rows, true));
    } catch (err) {
      // Merging a run of changes into one statement can trip a unique
      // constraint the original sequence never did (two rows swapping a
      // value). Replay this batch exactly as it happened instead. Rare, so the
      // normal path stays at one round trip per step.
      if (!isUniqueish(err)) {
        throw new Error(`applying changes ${rows[0]!.id}..${rows.at(-1)!.id}: ${(err as Error).message}`);
      }
      logger.warn({ from: rows[0]!.id, to: rows.at(-1)!.id }, 'Cloud sync: merged batch conflicted; replaying it row by row');
      try {
        await this.applyInTransaction(this.plan(rows, false));
      } catch (err2) {
        throw new Error(`applying changes ${rows[0]!.id}..${rows.at(-1)!.id}: ${(err2 as Error).message}`);
      }
    }

    // The cloud has it; now it may leave the local log. If this fails, the next
    // pass replays the batch, which is harmless.
    await withClient((l) => l.query(`DELETE FROM sync_changelog WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]));
    this.st.appliedSinceStart += rows.length;
    this.st.lastSyncedAt = new Date().toISOString();
    return rows.length;
  }

  private async applyInTransaction(steps: Step[]): Promise<void> {
    const c = this.cloud!;
    const tables = [...new Set(steps.map((s) => s.table))];
    await c.query('BEGIN');
    try {
      if (this.st.replicationMode === 'disable-triggers') {
        for (const t of tables) await c.query(`ALTER TABLE public.${ident(t)} DISABLE TRIGGER USER`);
      }
      for (const step of steps) await this.applyStep(c, step);
      await this.alignSequences(c);
      if (this.st.replicationMode === 'disable-triggers') {
        for (const t of tables) await c.query(`ALTER TABLE public.${ident(t)} ENABLE TRIGGER USER`);
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      this.sentSequences.clear();
      throw err;
    }
  }

  /**
   * Turns log rows into ordered steps. With `merge`, consecutive work on the
   * same table becomes one set-based statement; without, every change is its
   * own step, in log order.
   */
  private plan(rows: LogRow[], merge: boolean): Step[] {
    const steps: Step[] = [];
    const push = (kind: 'up' | 'del', table: string, row: string) => {
      const last = steps.at(-1);
      if (merge && last && last.kind === kind && last.table === table) last.rows.push(row);
      else steps.push({ kind, table, rows: [row] });
    };
    for (const r of rows) {
      const t = this.tables.get(r.table_name);
      if (!t) throw new PausedError(`table ${r.table_name} does not exist on the cloud`);
      if (r.op === 'T') steps.push({ kind: 'trunc', table: r.table_name });
      else if (r.op === 'D') push('del', r.table_name, r.old_data!);
      else if (r.op === 'I') push('up', r.table_name, r.row_data!);
      else {
        // A key change is a delete of the old row and an insert of the new one.
        if (pkKey(t, r.old_data!) !== pkKey(t, r.row_data!)) push('del', r.table_name, r.old_data!);
        push('up', r.table_name, r.row_data!);
      }
    }
    return steps;
  }

  private async applyStep(c: Client, step: Step): Promise<void> {
    if (step.kind === 'trunc') {
      await c.query(`TRUNCATE public.${ident(step.table)} CASCADE`);
      return;
    }
    const t = this.tables.get(step.table)!;
    const op = step.kind === 'up' ? upsertRows : deleteRows;
    // Only the last image of each row matters within a run of the same table.
    const latest = new Map<string, string>();
    for (const row of step.rows) {
      const k = pkKey(t, row);
      latest.delete(k);
      latest.set(k, row);
    }
    await op(c, t, [...latest.values()]);
  }

  private async alignSequences(c: Client): Promise<void> {
    const seqs = await withClient((l) => readSequences(l));
    const changed: SequenceState[] = seqs.filter((s) => this.sentSequences.get(s.s) !== `${s.v}/${s.called}`);
    await writeSequences(c, changed);
    for (const s of changed) this.sentSequences.set(s.s, `${s.v}/${s.called}`);
  }
}

async function fetchBatch(): Promise<LogRow[]> {
  const res = await withClient((l) => l.query<LogRow>(FETCH_SQL, [BATCH_ROWS]));
  // Cap the payload, but always take at least one row so a huge row still moves.
  let bytes = 0;
  const out: LogRow[] = [];
  for (const r of res.rows) {
    bytes += (r.row_data?.length ?? 0) + (r.old_data?.length ?? 0);
    if (out.length > 0 && bytes > BATCH_BYTES) break;
    out.push(r);
  }
  return out;
}

export async function pendingChanges(): Promise<number> {
  const res = await withClient((l) => l.query<{ n: number }>(`SELECT count(*)::int AS n FROM sync_changelog`));
  return res.rows[0]!.n;
}

/*
 * The worker the running server started, if any, so the admin console can
 * report on it. Set once from server.ts.
 */
let active: CloudSync | null = null;
export function setActiveCloudSync(sync: CloudSync | null): void {
  active = sync;
}
export function activeCloudSync(): CloudSync | null {
  return active;
}
