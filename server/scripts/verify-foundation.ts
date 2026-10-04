/**
 * Proves the Unit of Work honours the schema's contract, against the real
 * database. Read-only: nothing is inserted, and the one write test is rolled
 * back deliberately.
 *
 * Run with: npx tsx scripts/verify-foundation.ts
 */

import { SEQUENCES, SYSTEM_ACTOR, readTransaction, transaction, type Actor } from '../src/core/db/uow';
import { closePool } from '../src/core/db/pool';
import { BusinessRuleError } from '../src/core/errors';

const guardian: Actor = { userId: 42, userType: 'guardian', guardianId: 7 };

async function main(): Promise<void> {
  const checks: [string, boolean, string][] = [];

  // 1. The actor reaches the transaction in the form the schema's own
  //    expressions expect.
  await readTransaction(guardian, async (uow) => {
    const row = await uow.one<{ uid: string; utype: string; gid: string }>(
      `SELECT current_setting('app.current_user_id', true)     AS uid,
              current_setting('app.current_user_type', true)   AS utype,
              current_setting('app.current_guardian_id', true) AS gid`,
    );
    checks.push(['actor visible in transaction', row.uid === '42' && row.utype === 'guardian' && row.gid === '7',
      `uid=${row.uid} type=${row.utype} gid=${row.gid}`]);

    // audit_row() does NULLIF(...)::BIGINT on this; confirm it casts.
    const cast = await uow.one<{ n: string | null }>(
      `SELECT NULLIF(current_setting('app.current_user_id', true), '')::BIGINT::text AS n`,
    );
    checks.push(['audit_row cast works', cast.n === '42', `got ${cast.n}`]);
  });

  // 2. A system actor leaves the settings empty rather than stale.
  await readTransaction(SYSTEM_ACTOR, async (uow) => {
    const row = await uow.one<{ n: string | null }>(
      `SELECT NULLIF(current_setting('app.current_user_id', true), '')::BIGINT::text AS n`,
    );
    checks.push(['system actor yields NULL user', row.n === null, `got ${row.n}`]);
  });

  // 3. THE critical one: the setting must not survive into the next
  //    transaction on the same pooled connection. If set_config's is_local
  //    argument were wrong, this would return 42 and every request would be
  //    audited as whoever used that connection last.
  await readTransaction({ userId: null, userType: 'admin' }, async (uow) => {
    const row = await uow.one<{ uid: string }>(
      `SELECT current_setting('app.current_user_id', true) AS uid`,
    );
    checks.push(['no identity leak between transactions', row.uid === '' || row.uid === null,
      `leaked "${row.uid}"`]);
  });

  // 4. All eight human-readable sequences exist and are reachable.
  //    Checked by catalogue rather than by calling nextval, which would both
  //    fail in a read-only transaction and permanently burn live receipt and
  //    invoice numbers on a diagnostic.
  await readTransaction(SYSTEM_ACTOR, async (uow) => {
    const rows = await uow.many<{ sequencename: string }>(
      `SELECT sequencename FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename = ANY($1)`,
      [[...SEQUENCES]],
    );
    checks.push(['all 8 number sequences present', rows.length === SEQUENCES.length,
      `found ${rows.length} of ${SEQUENCES.length}`]);
  });

  // 5. A guard trigger maps to a BusinessRuleError, not a raw driver error.
  //    audit_logs is append-only via prevent_mutation; the UPDATE is rolled back.
  try {
    await transaction(SYSTEM_ACTOR, async (uow) => {
      await uow.count(`UPDATE audit_logs SET action = action WHERE id = (SELECT min(id) FROM audit_logs)`);
    });
    checks.push(['append-only guard translated', false, 'no error was raised']);
  } catch (err) {
    const good = err instanceof BusinessRuleError && err.code === 'APPEND_ONLY';
    checks.push(['append-only guard translated', good,
      err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)]);
  }

  // 6. Rollback really rolls back.
  const before = await readTransaction(SYSTEM_ACTOR, (uow) =>
    uow.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM settings'));
  try {
    await transaction(SYSTEM_ACTOR, async (uow) => {
      await uow.count(`INSERT INTO settings (key, value, group_name) VALUES ('__probe__', 'x', 'general')`);
      throw new Error('deliberate rollback');
    });
  } catch { /* expected */ }
  const after = await readTransaction(SYSTEM_ACTOR, (uow) =>
    uow.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM settings'));
  checks.push(['rollback discards writes', before.n === after.n, `${before.n} -> ${after.n}`]);

  let failed = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (${detail})`}`);
    if (!pass) failed += 1;
  }
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('verification crashed:', err);
  await closePool();
  process.exit(1);
});
