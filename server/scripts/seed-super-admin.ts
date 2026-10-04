/**
 * Create the first Super Admin (Part 15).
 *
 * Without this there is no way into the system: every other account is created
 * through an authenticated endpoint.
 *
 * The password comes from the environment, never from a literal in code, and
 * the account is created with `must_change_password` set so the seeded value
 * cannot become the long-term credential. If no password is supplied, one is
 * generated and printed once — printed rather than stored, because a password
 * written to a file is a password that stays there.
 *
 * Idempotent: re-running reports the existing account and changes nothing. It
 * will not silently reset the password of a live admin account.
 *
 * Run: SUPER_ADMIN_USERNAME=admin npx tsx scripts/seed-super-admin.ts
 */

import { SYSTEM_ACTOR, transaction } from '../src/core/db/uow';
import { closePool } from '../src/core/db/pool';
import {
  assertPasswordAcceptable,
  generateTemporaryPassword,
  hashPassword,
} from '../src/core/auth/password';
import { SUPER_ADMIN_ROLE } from '../src/core/authz/default-roles';

async function main(): Promise<void> {
  const username = (process.env.SUPER_ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
  const email = process.env.SUPER_ADMIN_EMAIL?.trim() || null;
  const supplied = process.env.SUPER_ADMIN_PASSWORD;

  const password = supplied ?? generateTemporaryPassword(14);
  if (supplied) {
    // A password chosen by a human gets checked; a generated one is known good.
    assertPasswordAcceptable(supplied, { username });
  }

  const result = await transaction(SYSTEM_ACTOR, async (uow) => {
    const existing = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
      [username],
    );
    if (existing) return { created: false as const, id: existing.id };

    const role = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM roles WHERE name = $1`, [
      SUPER_ADMIN_ROLE,
    ]);
    if (!role) {
      throw new Error(
        `The "${SUPER_ADMIN_ROLE}" role does not exist. Run seed-permissions.ts first.`,
      );
    }

    // user_type 'admin' with all three person links NULL is the one combination
    // the users_check constraint allows for an account with no person record.
    const user = await uow.one<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, user_type, must_change_password, is_active)
       VALUES ($1, $2, $3, 'admin', true, true)
       RETURNING id::text AS id`,
      [username, email, await hashPassword(password)],
    );

    await uow.count(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      user.id,
      role.id,
    ]);

    /*
     * `action` must be one of the six values audit_logs_action_check permits,
     * so the real event name goes in new_values. Casts are explicit because $1
     * fills both a bigint column (user_id) and a text one (record_id), and
     * without them Postgres cannot deduce a single type for the parameter.
     */
    await uow.count(
      `INSERT INTO audit_logs (user_id, action, table_name, record_id, new_values)
       VALUES ($1::bigint, 'insert', 'users', $1::text, $2::jsonb)`,
      [
        user.id,
        JSON.stringify({ event: 'super_admin_seeded', username, viaSeedScript: true }),
      ],
    );

    return { created: true as const, id: user.id };
  });

  if (!result.created) {
    console.log(`User "${username}" already exists (id ${result.id}). Nothing changed.`);
    console.log('To reset its password, use the admin password-reset endpoint.');
    return;
  }

  console.log(`Created Super Admin "${username}" (id ${result.id}).`);
  console.log('The account must change its password at first login.\n');
  if (supplied) {
    console.log('Password: taken from SUPER_ADMIN_PASSWORD.');
  } else {
    // The only time this value is ever displayed.
    console.log(`Temporary password: ${password}`);
    console.log('Shown once and not stored anywhere. Copy it now.');
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('SEED FAILED\n', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
