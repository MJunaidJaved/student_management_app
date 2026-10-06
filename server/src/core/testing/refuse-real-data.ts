/**
 * Vitest global setup: refuse to run the suite against a database that holds
 * real people or money.
 *
 * There is one database and no separate test database, so the suite writes to
 * the same tables the application uses. This guard stops the run before the
 * first test if any operational table already has rows, so a test run can
 * never be mistaken for real use or mixed into real records.
 */

import { closePool, withClient } from '../db/pool';

const PROTECTED_TABLES = ['students', 'guardians', 'staff', 'payments'] as const;

export default async function refuseRealData(): Promise<void> {
  const counts = await withClient(async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT ${PROTECTED_TABLES.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`).join(", ")}`,
    );
    return result.rows[0] ?? {};
  });
  await closePool();

  const populated = PROTECTED_TABLES.filter((t) => Number(counts[t] ?? 0) > 0);
  if (populated.length > 0) {
    throw new Error(
      `Refusing to run tests: real rows exist in ${populated.join(', ')}. ` +
        'The test suite must not run against a database that holds live records.',
    );
  }
}
