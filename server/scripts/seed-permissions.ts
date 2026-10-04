/**
 * Seed the permission catalogue and the default role assignments.
 *
 * Idempotent, and safe to re-run after adding a permission: it inserts what is
 * missing, updates changed descriptions, and reports anything in the database
 * that is no longer in the catalogue without deleting it. Deleting is left
 * manual on purpose — a code that has disappeared from the catalogue may still
 * be granted to a custom role, and removing it silently would strip that role's
 * access with no record of why.
 *
 * Run: npx tsx scripts/seed-permissions.ts [--dry-run]
 */

import { SYSTEM_ACTOR, transaction, type Uow } from '../src/core/db/uow';
import { closePool } from '../src/core/db/pool';
import { PERMISSION_CATALOG } from '../src/core/authz/permission-catalog';
import {
  DEFAULT_ROLE_PERMISSIONS,
  SUPER_ADMIN_ROLE,
  superAdminPermissions,
} from '../src/core/authz/default-roles';

const dryRun = process.argv.includes('--dry-run');

async function seedPermissions(uow: Uow): Promise<Map<string, string>> {
  /*
   * One statement for all of them. `unnest` turns three parallel arrays into
   * rows, which keeps this a single round trip regardless of catalogue size —
   * the bulk-insert rule from Part 9.3 applies to seeds as much as to imports.
   */
  const rows = await uow.many<{ id: string; code: string }>(
    `INSERT INTO permissions (code, module, description)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     ON CONFLICT (code) DO UPDATE
       SET module = EXCLUDED.module,
           description = EXCLUDED.description
     RETURNING id, code`,
    [
      PERMISSION_CATALOG.map((p) => p.code),
      PERMISSION_CATALOG.map((p) => p.module),
      PERMISSION_CATALOG.map((p) => p.description),
    ],
  );
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function seedRolePermissions(
  uow: Uow,
  permissionIds: Map<string, string>,
): Promise<{ role: string; granted: number; removed: number }[]> {
  const wanted: Record<string, readonly string[]> = {
    [SUPER_ADMIN_ROLE]: superAdminPermissions(),
    ...DEFAULT_ROLE_PERMISSIONS,
  };

  const roles = await uow.many<{ id: string; name: string }>(
    `SELECT id, name FROM roles WHERE name = ANY($1)`,
    [Object.keys(wanted)],
  );
  const byName = new Map(roles.map((r) => [r.name, r.id]));

  const missing = Object.keys(wanted).filter((name) => !byName.has(name));
  if (missing.length) {
    throw new Error(
      `These roles are not in the database: ${missing.join(', ')}. ` +
        'The seven system roles are expected to exist already.',
    );
  }

  const summary: { role: string; granted: number; removed: number }[] = [];

  for (const [roleName, codes] of Object.entries(wanted)) {
    const roleId = byName.get(roleName)!;
    const ids = codes.map((code) => {
      const id = permissionIds.get(code);
      if (!id) {
        // Caught here rather than inserting a partial set: a typo in the role
        // matrix would otherwise quietly leave that role missing a permission.
        throw new Error(`Role "${roleName}" refers to unknown permission "${code}".`);
      }
      return id;
    });

    const granted = await uow.count(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, unnest($2::bigint[])
       ON CONFLICT DO NOTHING`,
      [roleId, ids],
    );

    /*
     * Remove grants this role should no longer have, so re-running after
     * tightening the matrix actually tightens it. Scoped to permissions in the
     * catalogue: a grant for a code we no longer define is left alone, to be
     * dealt with deliberately.
     */
    const removed = await uow.count(
      `DELETE FROM role_permissions rp
        USING permissions p
        WHERE rp.permission_id = p.id
          AND rp.role_id = $1
          AND p.code = ANY($2)
          AND NOT (rp.permission_id = ANY($3::bigint[]))`,
      [roleId, PERMISSION_CATALOG.map((p) => p.code), ids],
    );

    summary.push({ role: roleName, granted, removed });
  }

  return summary;
}

async function main(): Promise<void> {
  const result = await transaction(SYSTEM_ACTOR, async (uow) => {
    const permissionIds = await seedPermissions(uow);
    const roleSummary = await seedRolePermissions(uow, permissionIds);

    const orphans = await uow.many<{ code: string }>(
      `SELECT code FROM permissions WHERE NOT (code = ANY($1)) ORDER BY code`,
      [PERMISSION_CATALOG.map((p) => p.code)],
    );

    if (dryRun) {
      // Everything above ran, so the counts are real; the rollback is what
      // makes it a dry run.
      throw new DryRun({ permissionIds, roleSummary, orphans: orphans.map((o) => o.code) });
    }
    return { count: permissionIds.size, roleSummary, orphans: orphans.map((o) => o.code) };
  });

  report(result);
}

class DryRun extends Error {
  constructor(readonly payload: unknown) {
    super('dry run');
  }
}

type Result = {
  count: number;
  roleSummary: { role: string; granted: number; removed: number }[];
  orphans: string[];
};

function report(r: Result): void {
  console.log(`Permissions in catalogue: ${PERMISSION_CATALOG.length}`);
  console.log(`Permissions present after seed: ${r.count}\n`);
  console.log('Role assignments:');
  for (const s of r.roleSummary) {
    const changes = [
      s.granted ? `+${s.granted}` : null,
      s.removed ? `-${s.removed}` : null,
    ].filter(Boolean).join(' ');
    console.log(`  ${s.role.padEnd(14)} ${changes || 'unchanged'}`);
  }
  if (r.orphans.length) {
    console.log(
      `\nIn the database but NOT in the catalogue (left in place, remove deliberately):\n  ${r.orphans.join(', ')}`,
    );
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    if (err instanceof DryRun) {
      const p = err.payload as { permissionIds: Map<string, string>; roleSummary: Result['roleSummary']; orphans: string[] };
      console.log('DRY RUN — rolled back, nothing was written.\n');
      report({ count: p.permissionIds.size, roleSummary: p.roleSummary, orphans: p.orphans });
      await closePool();
      process.exit(0);
    }
    console.error('SEED FAILED\n', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
