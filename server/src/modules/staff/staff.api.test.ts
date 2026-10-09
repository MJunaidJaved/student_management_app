import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_staff__', password: 'StaffPassw0rd!2026' };
const TEACHER = { username: '__apitest_staff_teacher__', password: 'TeacherNoAccess!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let teacherToken: string;

const made = {
  departments: [] as string[],
  designations: [] as string[],
  staff: [] as string[],
};

async function call(
  path: string,
  init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${init.token ?? token}`,
  };
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Create (or reuse) a user with a given role, the same way every API test fixture does. */
async function ensureUser(username: string, password: string, role: string): Promise<void> {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    const existing = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
      [username],
    );
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true WHERE id = $1`, [
        existing.id,
      ]);
      return;
    }
    const hash = await hashPassword(password);
    const user = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
       VALUES ($1, $2, 'staff', false, true) RETURNING id::text AS id`,
      [username, hash],
    );
    await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [
      user.id,
      role,
    ]);
  });
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await ensureUser(ADMIN.username, ADMIN.password, SUPER_ADMIN_ROLE);
  await ensureUser(TEACHER.username, TEACHER.password, 'Teacher');

  const adminLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    token: 'none',
    body: { username: ADMIN.username, password: ADMIN.password },
  });
  if (adminLogin.status !== 200) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin.body));
  token = adminLogin.body.data.accessToken;

  const teacherLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    token: 'none',
    body: { username: TEACHER.username, password: TEACHER.password },
  });
  if (teacherLogin.status !== 200) throw new Error('Teacher login failed: ' + JSON.stringify(teacherLogin.body));
  teacherToken = teacherLogin.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    // Clear what the tests attached to staffId so the hard delete below does
    // not trip the very FK-RESTRICT guards the tests were proving exist.
    for (const id of made.staff) {
      await uow.count(`UPDATE users SET staff_id = NULL WHERE staff_id = $1`, [id]);
      await uow.count(`DELETE FROM staff_contracts WHERE staff_id = $1`, [id]);
    }
    for (const id of made.staff) await uow.count(`DELETE FROM staff WHERE id = $1`, [id]);
    for (const id of made.designations) await uow.count(`DELETE FROM designations WHERE id = $1`, [id]);
    for (const id of made.departments) await uow.count(`DELETE FROM departments WHERE id = $1`, [id]);
  });
  // ADMIN and TEACHER are left in place: both now carry audit_logs rows from
  // logging in, and audit_logs is immutable and RESTRICT-linked to users, so
  // deleting them would fail. They are created idempotently on every run.
  server.close();
  await closePool();
});

describe('Staff and HR API', () => {
  let departmentId: string;
  let designationId: string;
  let staffId: string;

  it('a caller without staff.create is forbidden, not just unauthenticated', async () => {
    const res = await call('/api/v1/staff', {
      method: 'POST',
      token: teacherToken,
      body: { fullName: 'Nope', gender: 'male', dob: '1990-01-01', phone: '03001112222', joinDate: '2026-01-01' },
    });
    expect(res.status).toBe(403);
  });

  it('creates a department', async () => {
    const res = await call('/api/v1/departments', { method: 'POST', body: { name: 'Science' } });
    expect(res.status).toBe(201);
    departmentId = res.body.data.id;
    made.departments.push(departmentId);
  });

  it('creates a designation under the department', async () => {
    const res = await call('/api/v1/designations', {
      method: 'POST',
      body: { name: 'Lab Assistant', departmentId },
    });
    expect(res.status).toBe(201);
    designationId = res.body.data.id;
    made.designations.push(designationId);
  });

  it('rejects an invalid gender at validation, before touching the database', async () => {
    const res = await call('/api/v1/staff', {
      method: 'POST',
      body: {
        fullName: 'Bad Gender',
        gender: 'unspecified',
        dob: '1990-01-01',
        phone: '03001112222',
        joinDate: '2026-01-01',
      },
    });
    expect(res.status).toBe(422);
  });

  it('creates a staff member with an employee number from the sequence', async () => {
    const res = await call('/api/v1/staff', {
      method: 'POST',
      body: {
        fullName: 'Imran Qureshi',
        gender: 'male',
        dob: '1988-03-12',
        nationalId: '3520112223334',
        phone: '03007654321',
        joinDate: '2026-01-05',
        departmentId,
        designationId,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.employeeNo).toBeDefined();
    expect(res.body.data.nationalId).toBe('3520112223334'); // admin sees it unmasked
    staffId = res.body.data.id;
    made.staff.push(staffId);
  });

  it('refuses a second staff member with the same national ID', async () => {
    const res = await call('/api/v1/staff', {
      method: 'POST',
      body: {
        fullName: 'Someone Else',
        gender: 'male',
        dob: '1980-01-01',
        nationalId: '3520112223334',
        phone: '03001119999',
        joinDate: '2026-01-05',
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STAFF_EXISTS');
  });

  it('gets the staff profile by id', async () => {
    const res = await call(`/api/v1/staff/${staffId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Imran Qureshi');
  });

  it('edits the staff record', async () => {
    const res = await call(`/api/v1/staff/${staffId}`, { method: 'PATCH', body: { phone: '03009998888' } });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('03009998888');
  });

  it('lists staff filtered by department, with pagination', async () => {
    const res = await call(`/api/v1/staff?departmentId=${departmentId}&limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.items[0].departmentId).toBe(departmentId);
  });

  it('searches staff by exact employee number', async () => {
    const got = await call(`/api/v1/staff/${staffId}`);
    const employeeNo = got.body.data.employeeNo as string;

    const res = await call(`/api/v1/staff-search?q=${encodeURIComponent(employeeNo)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('employee_no');
    expect(res.body.data.staff.some((s: { id: string }) => s.id === staffId)).toBe(true);
  });

  it('searches staff by name, by the trigram-backed path', async () => {
    const res = await call(`/api/v1/staff-search?q=Imran`);
    expect(res.status).toBe(200);
    expect(res.body.data.staff.some((s: { id: string }) => s.id === staffId)).toBe(true);
  });

  it('refuses to delete a department that still has staff and designations', async () => {
    const res = await call(`/api/v1/departments/${departmentId}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEPARTMENT_IN_USE');
  });

  it('refuses to soft-delete a staff member who has a teaching assignment or contract', async () => {
    // subject_teachers requires a full academic setup; a staff_contracts row
    // is the cheapest real "history" row to prove the block with, and
    // contracts management is out of this phase's scope regardless.
    await transaction(SYSTEM_ACTOR, async (uow) => {
      await uow.count(
        `INSERT INTO staff_contracts (staff_id, contract_type, start_date, basic_salary)
         VALUES ($1, 'permanent', '2026-01-05', 50000)`,
        [staffId],
      );
    });

    const res = await call(`/api/v1/staff/${staffId}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STAFF_HAS_HISTORY');
  });

  it('deactivates a staff member and disables the linked user account', async () => {
    const linkedUsername = '__apitest_staff_linked_user__';
    const linkedUserId = await transaction(SYSTEM_ACTOR, async (uow) => {
      const existing = await uow.maybeOne<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
        [linkedUsername],
      );
      if (existing) {
        await uow.count(`UPDATE users SET staff_id = $2, is_active = true WHERE id = $1`, [
          existing.id,
          staffId,
        ]);
        return existing.id;
      }
      const hash = await hashPassword('LinkedUser!2026');
      const user = await uow.one<{ id: string }>(
        `INSERT INTO users (username, password_hash, user_type, staff_id, must_change_password, is_active)
         VALUES ($1, $2, 'staff', $3, false, true) RETURNING id::text AS id`,
        [linkedUsername, hash, staffId],
      );
      return user.id;
    });

    const res = await call(`/api/v1/staff/${staffId}/deactivate`, {
      method: 'POST',
      body: { status: 'resigned', separationDate: '2026-06-30', reason: 'Moving to another city' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resigned');
    expect(res.body.data.separationDate).toBe('2026-06-30');
    expect(res.body.data.separationReason).toBe('Moving to another city');

    const row = await transaction(SYSTEM_ACTOR, (uow) =>
      uow.one<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [linkedUserId]),
    );
    expect(row.is_active).toBe(false);
  });

  it('refuses to deactivate an already-inactive staff member', async () => {
    const res = await call(`/api/v1/staff/${staffId}/deactivate`, {
      method: 'POST',
      body: { status: 'terminated', separationDate: '2026-07-01' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STAFF_NOT_ACTIVE');
  });

  it('soft-deletes a staff member with no history', async () => {
    const created = await call('/api/v1/staff', {
      method: 'POST',
      body: {
        fullName: 'No History At All',
        gender: 'female',
        dob: '1995-01-01',
        phone: '03004443333',
        joinDate: '2026-01-05',
      },
    });
    expect(created.status).toBe(201);
    const freshId = created.body.data.id;
    made.staff.push(freshId);

    const res = await call(`/api/v1/staff/${freshId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const after = await call(`/api/v1/staff/${freshId}`);
    expect(after.status).toBe(404);
  });
});
