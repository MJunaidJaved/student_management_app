import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_promotions__', password: 'PromotionsPassw0rd!2026' };
const TEACHER = { username: '__apitest_promotions_teacher__', password: 'PromoTeacher!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let teacherToken: string;

const made = {
  years: [] as string[], classes: [] as string[], sections: [] as string[], students: [] as string[], staff: [] as string[],
};

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ensureUser(username: string, password: string, role: string, staffId?: string): Promise<void> {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true, staff_id = $2 WHERE id = $1`, [existing.id, staffId ?? null]);
      return;
    }
    const hash = await hashPassword(password);
    const u = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, staff_id, must_change_password, is_active) VALUES ($1, $2, $3, $4, false, true) RETURNING id::text AS id`,
      [username, hash, staffId ? 'staff' : 'admin', staffId ?? null],
    );
    await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [u.id, role]);
  });
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await ensureUser(ADMIN.username, ADMIN.password, SUPER_ADMIN_ROLE);
  const adminLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: ADMIN.username, password: ADMIN.password } });
  if (adminLogin.status !== 200) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin.body));
  token = adminLogin.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    for (const id of made.students) {
      await uow.count(`DELETE FROM student_promotions WHERE from_enrollment_id IN (SELECT id FROM student_enrollments WHERE student_id = $1)`, [id]);
      await uow.count(`DELETE FROM student_leaving_records WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    }
    await uow.count(`UPDATE users SET staff_id = NULL WHERE staff_id = ANY($1)`, [made.staff]);
    for (const id of made.staff) await uow.count(`DELETE FROM staff WHERE id = $1`, [id]);
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Promotions API', () => {
  let year1: string, year2: string, classA: string, classB: string, sectionA: string, sectionBFull: string;
  let s1: string, s2: string, s3: string, e1: string, e2: string, e3: string;

  beforeAll(async () => {
    const y1 = await call('/api/v1/academic/years', { method: 'POST', body: { name: '2026-27-promo-src', startDate: '2026-01-01', endDate: '2026-12-31' } });
    year1 = y1.body.data.id;
    made.years.push(year1);
    const y2 = await call('/api/v1/academic/years', { method: 'POST', body: { name: '2027-28-promo-dst', startDate: '2027-01-01', endDate: '2027-12-31' } });
    year2 = y2.body.data.id;
    made.years.push(year2);

    const cA = await call('/api/v1/academic/classes', { method: 'POST', body: { name: 'Promo Class A', levelOrder: 95 } });
    classA = cA.body.data.id;
    made.classes.push(classA);
    const cB = await call('/api/v1/academic/classes', { method: 'POST', body: { name: 'Promo Class B', levelOrder: 96 } });
    classB = cB.body.data.id;
    made.classes.push(classB);

    const secA = await call('/api/v1/academic/sections', { method: 'POST', body: { classId: classA, name: 'Promo-A', capacity: 10 } });
    sectionA = secA.body.data.id;
    made.sections.push(sectionA);
    const secBFull = await call('/api/v1/academic/sections', { method: 'POST', body: { classId: classB, name: 'Promo-Full', capacity: 1 } });
    sectionBFull = secBFull.body.data.id;
    made.sections.push(sectionBFull);
  });

  beforeAll(async () => {
    const mk = async (first: string, last: string) => {
      const s = await call('/api/v1/students', { method: 'POST', body: { firstName: first, lastName: last, gender: 'male', dob: '2014-01-01', admissionDate: '2026-01-01' } });
      const studentId = s.body.data.student.id;
      made.students.push(studentId);
      const e = await call('/api/v1/enrollments', { method: 'POST', body: { studentId, academicYearId: year1, classId: classA, sectionId: sectionA, enrolledOn: '2026-01-01' } });
      return { studentId, enrollmentId: e.body.data.id };
    };
    const r1 = await mk('Promo', 'One'); s1 = r1.studentId; e1 = r1.enrollmentId;
    const r2 = await mk('Promo', 'Two'); s2 = r2.studentId; e2 = r2.enrollmentId;
    const r3 = await mk('Promo', 'Three'); s3 = r3.studentId; e3 = r3.enrollmentId;

    const teacher = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Promo Teacher', gender: 'female', dob: '1985-01-01', phone: '03008880001', joinDate: '2025-01-01' } });
    made.staff.push(teacher.body.data.id);
    await ensureUser(TEACHER.username, TEACHER.password, 'Teacher', teacher.body.data.id);
    const teacherLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: TEACHER.username, password: TEACHER.password } });
    teacherToken = teacherLogin.body.data.accessToken;
  });

  it('a teacher without students.promote is forbidden', async () => {
    const res = await call(`/api/v1/promotions/preview?academicYearId=${year1}&classId=${classA}`, { token: teacherToken });
    expect(res.status).toBe(403);
  });

  it('previews all three active enrollments, each proposed as promoted', async () => {
    const res = await call(`/api/v1/promotions/preview?academicYearId=${year1}&classId=${classA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.candidates.length).toBe(3);
    expect(res.body.data.candidates.every((c: { proposedAction: string }) => c.proposedAction === 'promoted')).toBe(true);
    expect(res.body.data.candidates.map((c: { enrollmentId: string }) => c.enrollmentId).sort()).toEqual([e1, e2, e3].sort());
  });

  it('rejects a graduated decision that also names a target class', async () => {
    const res = await call('/api/v1/promotions/apply', { method: 'POST', body: { toAcademicYearId: year2, decisions: [{ fromEnrollmentId: e3, action: 'graduated', toClassId: classB }] } });
    expect(res.status).toBe(422);
  });

  it('rejects a promoted decision with a section that does not belong to the target class', async () => {
    const res = await call('/api/v1/promotions/apply', { method: 'POST', body: { toAcademicYearId: year2, decisions: [{ fromEnrollmentId: e1, action: 'promoted', toClassId: classA, toSectionId: sectionBFull }] } });
    expect(res.status).toBe(422);
  });

  it('applies a mixed batch: promoted, detained and graduated, in one transaction', async () => {
    const res = await call('/api/v1/promotions/apply', {
      method: 'POST',
      body: {
        toAcademicYearId: year2,
        decisions: [
          { fromEnrollmentId: e1, action: 'promoted', toClassId: classB, toSectionId: sectionBFull, remarks: 'Did well' },
          { fromEnrollmentId: e2, action: 'detained', toClassId: classA, toSectionId: sectionA },
          { fromEnrollmentId: e3, action: 'graduated' },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(3);

    const closed = await transaction(SYSTEM_ACTOR, (uow) => uow.many<{ id: string; status: string }>(`SELECT id::text, status FROM student_enrollments WHERE id = ANY($1) ORDER BY id`, [[e1, e2, e3]]));
    const byId = new Map(closed.map((r) => [r.id, r.status]));
    expect(byId.get(e1)).toBe('promoted');
    expect(byId.get(e2)).toBe('detained');
    expect(byId.get(e3)).toBe('promoted'); // graduated closes the enrollment as "promoted"; the student record carries "graduated".

    const student3 = await transaction(SYSTEM_ACTOR, (uow) => uow.one<{ status: string }>(`SELECT status FROM students WHERE id = $1`, [s3]));
    expect(student3.status).toBe('graduated');

    const newEnrollments = await transaction(SYSTEM_ACTOR, (uow) => uow.many<{ student_id: string; class_id: string; section_id: string }>(`SELECT student_id::text, class_id::text, section_id::text FROM student_enrollments WHERE academic_year_id = $1`, [year2]));
    expect(newEnrollments.find((r) => r.student_id === s1)).toMatchObject({ class_id: classB, section_id: sectionBFull });
    expect(newEnrollments.find((r) => r.student_id === s2)).toMatchObject({ class_id: classA, section_id: sectionA });
    expect(newEnrollments.find((r) => r.student_id === s3)).toBeUndefined();
  });

  it('refuses to decide the same enrollment twice', async () => {
    const res = await call('/api/v1/promotions/apply', { method: 'POST', body: { toAcademicYearId: year2, decisions: [{ fromEnrollmentId: e1, action: 'detained', toClassId: classA, toSectionId: sectionA }] } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PROMOTED');
  });

  it('refuses to promote an enrollment that is no longer active (and was never decided)', async () => {
    // A withdrawn student: inactive, but with no student_promotions row —
    // distinct from e1/e3 above, which are inactive precisely because they
    // were already decided.
    const s5 = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Promo', lastName: 'Five', gender: 'male', dob: '2014-03-01', admissionDate: '2026-01-01' } });
    made.students.push(s5.body.data.student.id);
    const e5 = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: s5.body.data.student.id, academicYearId: year1, classId: classA, sectionId: sectionA, enrolledOn: '2026-01-01' } });
    const withdraw = await call(`/api/v1/students/${s5.body.data.student.id}/leave`, { method: 'POST', body: { status: 'withdrawn', leavingDate: '2026-06-01' } });
    expect(withdraw.status).toBe(200);

    const res = await call('/api/v1/promotions/apply', { method: 'POST', body: { toAcademicYearId: year2, decisions: [{ fromEnrollmentId: e5.body.data.id, action: 'promoted', toClassId: classA, toSectionId: sectionA }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ENROLLMENT_NOT_ACTIVE');
  });

  it('refuses to promote into a full section', async () => {
    // sectionBFull now holds student 1 (capacity 1); a fresh fourth student tries to join it too.
    const s4 = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Promo', lastName: 'Four', gender: 'female', dob: '2014-02-01', admissionDate: '2026-01-01' } });
    made.students.push(s4.body.data.student.id);
    const e4 = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: s4.body.data.student.id, academicYearId: year1, classId: classA, sectionId: sectionA, enrolledOn: '2026-01-01' } });
    const res = await call('/api/v1/promotions/apply', { method: 'POST', body: { toAcademicYearId: year2, decisions: [{ fromEnrollmentId: e4.body.data.id, action: 'promoted', toClassId: classB, toSectionId: sectionBFull }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SECTION_FULL');
  });

  it("lists a student's promotion history", async () => {
    const res = await call(`/api/v1/students/${s1}/promotions`);
    expect(res.status).toBe(200);
    expect(res.body.data.decisions.length).toBe(1);
    expect(res.body.data.decisions[0].action).toBe('promoted');
    expect(res.body.data.decisions[0].remarks).toBe('Did well');
  });

  it('a request without authentication is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/v1/promotions/preview?academicYearId=${year1}&classId=${classA}`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
