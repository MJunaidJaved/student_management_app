import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_admissions__', password: 'AdmitPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let token: string;

const made = {
  years: [] as string[],
  classes: [] as string[],
  sections: [] as string[],
  students: [] as string[],
  guardians: [] as string[],
  applications: [] as string[],
};

async function call(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: any } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(ADMIN.password);
    const existing = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
      [ADMIN.username],
    );
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true WHERE id = $1`, [
        existing.id,
      ]);
      return;
    }
    const u = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
       VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`,
      [ADMIN.username, hash],
    );
    await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [
      u.id,
      SUPER_ADMIN_ROLE,
    ]);
  });

  const res = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { username: ADMIN.username, password: ADMIN.password },
  });
  if (res.status !== 200) throw new Error('Login failed: ' + JSON.stringify(res.body));
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    for (const id of made.applications) await uow.count(`DELETE FROM admission_applications WHERE id = $1`, [id]);
    // student_leaving_records, student_guardians and student_enrollments all
    // RESTRICT students/guardians; they have to go first.
    for (const id of made.students) {
      await uow.count(`DELETE FROM student_leaving_records WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_guardians WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
    }
    for (const id of made.students) await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    for (const id of made.guardians) await uow.count(`DELETE FROM guardians WHERE id = $1`, [id]);
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Admission applications API', () => {
  let yearId: string;
  let classId: string;
  let sectionId: string;

  beforeAll(async () => {
    const yearRes = await call('/api/v1/academic/years', {
      method: 'POST',
      body: { name: '2027-28-admissions', startDate: '2027-04-01', endDate: '2028-03-31' },
    });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);

    const classRes = await call('/api/v1/academic/classes', {
      method: 'POST',
      body: { name: 'Admissions Class', levelOrder: 90 },
    });
    classId = classRes.body.data.id;
    made.classes.push(classId);

    const secRes = await call('/api/v1/academic/sections', {
      method: 'POST',
      body: { classId, name: 'Adm-A', capacity: 2 },
    });
    sectionId = secRes.body.data.id;
    made.sections.push(sectionId);
  });

  it('rejects a missing required field at validation', async () => {
    const res = await call('/api/v1/applications', {
      method: 'POST',
      body: { dob: '2017-01-01', guardianName: 'G', guardianPhone: '03001234567', appliedClassId: classId },
    });
    expect(res.status).toBe(422);
  });

  it('records an enquiry, starting at "enquiry"', async () => {
    const res = await call('/api/v1/applications', {
      method: 'POST',
      body: {
        applicantName: 'Bilal Ahmed',
        dob: '2017-03-10',
        gender: 'male',
        guardianName: 'Ahmed Khan',
        guardianPhone: '03001112233',
        appliedClassId: classId,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('enquiry');
    expect(res.body.data.applicationNo).toBeDefined();
    made.applications.push(res.body.data.id);
  });

  it('lists applications filtered by status', async () => {
    const res = await call('/api/v1/applications?status=enquiry');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it('rejects an illegal transition (enquiry straight to enrolled)', async () => {
    const appId = made.applications[0]!;
    const res = await call(`/api/v1/applications/${appId}/status`, {
      method: 'PATCH',
      body: { status: 'enrolled' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('USE_CONVERSION_ENDPOINT');
  });

  it('walks the application through applied -> test -> accepted', async () => {
    const appId = made.applications[0]!;
    const toApplied = await call(`/api/v1/applications/${appId}/status`, {
      method: 'PATCH',
      body: { status: 'applied' },
    });
    expect(toApplied.status).toBe(200);

    const toTest = await call(`/api/v1/applications/${appId}/status`, {
      method: 'PATCH',
      body: { status: 'test' },
    });
    expect(toTest.status).toBe(200);

    const toAccepted = await call(`/api/v1/applications/${appId}/status`, {
      method: 'PATCH',
      body: { status: 'accepted' },
    });
    expect(toAccepted.status).toBe(200);
    expect(toAccepted.body.data.status).toBe('accepted');
  });

  it('refuses to convert an application that is not accepted', async () => {
    const other = await call('/api/v1/applications', {
      method: 'POST',
      body: {
        applicantName: 'Still Enquiry',
        dob: '2017-05-05',
        guardianName: 'Someone',
        guardianPhone: '03005556677',
        appliedClassId: classId,
      },
    });
    made.applications.push(other.body.data.id);

    const res = await call(`/api/v1/applications/${other.body.data.id}/convert`, {
      method: 'POST',
      body: { academicYearId: yearId, sectionId, enrolledOn: '2027-04-01' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it(
    'converts an accepted application into a student, a guardian link and an ' +
      'enrollment in one transaction',
    async () => {
      const appId = made.applications[0]!;
      const res = await call(`/api/v1/applications/${appId}/convert`, {
        method: 'POST',
        body: { academicYearId: yearId, sectionId, enrolledOn: '2027-04-01', relation: 'father' },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.student.firstName).toBe('Bilal');
      expect(res.body.data.student.lastName).toBe('Ahmed');
      expect(res.body.data.enrollment.rollNo).toBe(1);
      expect(res.body.data.guardian.fullName).toBe('Ahmed Khan');
      made.students.push(res.body.data.student.id);
      made.guardians.push(res.body.data.guardian.id);

      const applicationAfter = await call(`/api/v1/applications/${appId}`);
      expect(applicationAfter.body.data.status).toBe('enrolled');
      expect(applicationAfter.body.data.studentId).toBe(res.body.data.student.id);
    },
  );

  it('refuses to convert the same application twice', async () => {
    const appId = made.applications[0]!;
    const res = await call(`/api/v1/applications/${appId}/convert`, {
      method: 'POST',
      body: { academicYearId: yearId, sectionId, enrolledOn: '2027-04-01' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('records a withdrawal: status changes, one leaving record, no second allowed', async () => {
    const studentId = made.students[0]!;
    const res = await call(`/api/v1/students/${studentId}/leave`, {
      method: 'POST',
      body: { status: 'withdrawn', leavingDate: '2027-06-01', reason: 'Relocating' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('withdrawn');

    // The enrollment itself must close too, not just the student record —
    // and it must close regardless of whether its academic year happens to
    // still be flagged "current" school-wide.
    const enrollment = await transaction(SYSTEM_ACTOR, (uow) =>
      uow.one<{ status: string }>(
        `SELECT status FROM student_enrollments WHERE student_id = $1`,
        [studentId],
      ),
    );
    expect(enrollment.status).toBe('withdrawn');

    const again = await call(`/api/v1/students/${studentId}/leave`, {
      method: 'POST',
      body: { status: 'withdrawn', leavingDate: '2027-06-02' },
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('STUDENT_NOT_ACTIVE');
  });
});
