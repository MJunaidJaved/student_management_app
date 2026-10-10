import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_students__', password: 'StudentsPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let token: string;

const made = {
  years: [] as string[],
  classes: [] as string[],
  sections: [] as string[],
  students: [] as string[],
  guardians: [] as string[],
};

async function call(
  path: string,
  init: Omit<RequestInit, 'body'> & { auth?: boolean; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.auth !== false) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    ...((init.body !== undefined) && { body: JSON.stringify(init.body) }),
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
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true WHERE id = $1`, [existing.id]);
      return existing.id;
    }

    const u = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active) VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`,
      [ADMIN.username, hash],
    );
    await uow.count(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name = $2`,
      [u.id, SUPER_ADMIN_ROLE],
    );
    return u.id;
  });

  const res = await call('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: ADMIN.username, password: ADMIN.password },
  });
  if (res.status !== 200) {
    throw new Error('Login failed: ' + JSON.stringify(res.body));
  }
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    // student_guardians and student_enrollments both RESTRICT the parent
    // rows below; they have to go first or the guardian/student deletes fail.
    for (const id of made.students) {
      await uow.count(`DELETE FROM student_guardians WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
    }
    for (const id of made.guardians) await uow.count(`DELETE FROM guardians WHERE id = $1`, [id]);
    for (const id of made.students) await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Students API', () => {
  let yearId: string;
  let classId: string;
  let sectionId: string;
  let student1Id: string;
  let admissionNo1: string;
  let student2Id: string;
  let guardianId: string;

  beforeAll(async () => {
    // Setup academic year and section
    const yearRes = await call('/api/v1/academic/years', {
      method: 'POST',
      body: { name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31' },
    });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);

    const classRes = await call('/api/v1/academic/classes', {
      method: 'POST',
      body: { name: 'Class 1', levelOrder: 1 },
    });
    classId = classRes.body.data.id;
    made.classes.push(classId);

    const secRes = await call('/api/v1/academic/sections', {
      method: 'POST',
      body: { classId, name: 'A', capacity: 30 },
    });
    sectionId = secRes.body.data.id;
    made.sections.push(sectionId);
  });

  it('creates a student', async () => {
    const res = await call('/api/v1/students', {
      method: 'POST',
      body: {
        firstName: 'John',
        lastName: 'Doe',
        gender: 'male',
        dob: '2015-05-15',
        admissionDate: '2026-04-01',
      },
    });
    expect(res.status).toBe(201);
    // create() wraps the student with a probable-duplicates warning (Part
    // 9.4), so the student itself is nested rather than at the top level.
    expect(res.body.data.student.firstName).toBe('John');
    expect(res.body.data.student.admissionNo).toBeDefined();
    student1Id = res.body.data.student.id;
    admissionNo1 = res.body.data.student.admissionNo;
    made.students.push(student1Id);
  });

  it('finds a student by exact admission number via the global search', async () => {
    const res = await call(`/api/v1/search?q=${encodeURIComponent(admissionNo1)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.kind).toBe('admission_no');
    expect(res.body.data.students.some((s: { id: string }) => s.id === student1Id)).toBe(true);
  });

  it('finds a student by name, by the trigram-backed path', async () => {
    const res = await call(`/api/v1/search?q=${encodeURIComponent('John')}&typeahead=true`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.students.some((s: { id: string }) => s.id === student1Id)).toBe(true);
  });

  it('global search returns nothing for an admission number that does not exist', async () => {
    const res = await call(`/api/v1/search?q=${encodeURIComponent('ADM-NOT-REAL-999999')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.students.length).toBe(0);
  });

  it('denies the global search to a caller without students.search', async () => {
    const res = await fetch(`${baseUrl}/api/v1/search?q=John`);
    expect(res.status).toBe(401);
  });

  it('creates a guardian', async () => {
    const res = await call('/api/v1/guardians', {
      method: 'POST',
      body: {
        fullName: 'Jane Doe',
        phone: '03001234567',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.fullName).toBe('Jane Doe');
    guardianId = res.body.data.id;
    made.guardians.push(guardianId);
  });

  it('links guardian to student', async () => {
    const res = await call('/api/v1/student-guardians', {
      method: 'POST',
      body: {
        studentId: student1Id,
        guardianId: guardianId,
        relation: 'mother',
        isPrimary: true,
        isFeePayer: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.links.length).toBe(1);
  });

  it('concurrent roll number assignment', async () => {
    // Create second student
    const s2 = await call('/api/v1/students', {
      method: 'POST',
      body: {
        firstName: 'Alice',
        lastName: 'Smith',
        gender: 'female',
        dob: '2015-06-16',
        admissionDate: '2026-04-01',
      },
    });
    student2Id = s2.body.data.student.id;
    made.students.push(student2Id);

    // Fire enrollments concurrently
    const [e1, e2] = await Promise.all([
      call('/api/v1/enrollments', {
        method: 'POST',
        body: { studentId: student1Id, academicYearId: yearId, classId: classId, sectionId: sectionId, enrolledOn: '2026-04-01' },
      }),
      call('/api/v1/enrollments', {
        method: 'POST',
        body: { studentId: student2Id, academicYearId: yearId, classId: classId, sectionId: sectionId, enrolledOn: '2026-04-01' },
      }),
    ]);

    expect(e1.status).toBe(201);
    expect(e2.status).toBe(201);
    
    expect(e1.body.data.rollNo).not.toBe(e2.body.data.rollNo);
    const rolls = [e1.body.data.rollNo, e2.body.data.rollNo].sort();
    expect(rolls).toEqual([1, 2]);
  });
  
  it('duplicate guardian link is idempotent, not a second row', async () => {
    // Linking the same guardian to the same student twice must not create a
    // second student_guardians row (Part 5.4: duplicate relationships
    // rejected/prevented, enforced here by the unique constraint plus upsert).
    const first = await call('/api/v1/student-guardians', {
      method: 'POST',
      body: { studentId: student1Id, guardianId, relation: 'mother', isPrimary: true, isFeePayer: true },
    });
    expect(first.status).toBe(200);
    const linksAfterFirst = first.body.data.links.length;

    const second = await call('/api/v1/student-guardians', {
      method: 'POST',
      body: { studentId: student1Id, guardianId, relation: 'mother', isPrimary: true, isFeePayer: true },
    });
    expect(second.status).toBe(200);
    expect(second.body.data.links.length).toBe(linksAfterFirst);
  });

  it('a teacher outside a section cannot view a student inside it (404, not 403)', async () => {
    // Part 7.2: out of scope must read as "not found", never "forbidden" —
    // a 403 would confirm the record exists. This account holds the Teacher
    // role (so it legitimately passes the students.read permission gate) but
    // has no staff record and so no section assignment, which is what the
    // policy layer uses to scope a teacher's view.
    const TEACHER = { username: '__apitest_students_teacher__', password: 'TeacherScope!2026' };
    await transaction(SYSTEM_ACTOR, async (uow) => {
      const hash = await hashPassword(TEACHER.password);
      const existing = await uow.maybeOne<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
        [TEACHER.username],
      );
      const userId =
        existing?.id ??
        (
          await uow.one<{ id: string }>(
            `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
             VALUES ($1, $2, 'staff', false, true) RETURNING id::text AS id`,
            [TEACHER.username, hash],
          )
        ).id;
      if (!existing) {
        await uow.count(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'Teacher'`,
          [userId],
        );
      }
    });
    // Not added to any cleanup list: like the ADMIN fixture above, this user
    // accumulates audit_logs rows on login, and audit_logs is both immutable
    // and RESTRICT-linked to users, so deleting it would fail. It is created
    // idempotently instead, the same way ADMIN is.

    const login = await call('/api/v1/auth/login', {
      method: 'POST',
      auth: false,
      body: { username: TEACHER.username, password: TEACHER.password },
    });
    expect(login.status).toBe(200);
    const teacherToken = login.body.data.accessToken as string;

    const res = await fetch(`${baseUrl}/api/v1/students/${student1Id}`, {
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    expect(res.status).toBe(404);
  });
});
