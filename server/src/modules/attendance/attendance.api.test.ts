import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_attendance__', password: 'AttendancePassw0rd!2026' };
const TEACHER = { username: '__apitest_attendance_teacher__', password: 'TeacherAttend!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let teacherToken: string;
let teacherStaffId: string;

const made = { years: [] as string[], classes: [] as string[], sections: [] as string[], students: [] as string[], staff: [] as string[] };

/** A Monday at least a week in the past: always a weekday, always eligible for the edit-past path. */
function pastMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The next Saturday at or after the given date — always a non-school day. */
function nextSaturday(from: string): string {
  const d = new Date(`${from}T00:00:00Z`);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(ADMIN.password);
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [ADMIN.username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true WHERE id = $1`, [existing.id]);
    } else {
      const u = await uow.one<{ id: string }>(`INSERT INTO users (username, password_hash, user_type, must_change_password, is_active) VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`, [ADMIN.username, hash]);
      await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [u.id, SUPER_ADMIN_ROLE]);
    }
  });
  const adminLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: ADMIN.username, password: ADMIN.password } });
  if (adminLogin.status !== 200) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin.body));
  token = adminLogin.body.data.accessToken;

  // A real staff record + a Teacher-role user linked to it, so attendance.mark
  // is exercised by an actual teacher, not just an admin bypass.
  const staffRes = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Attendance Teacher', gender: 'female', dob: '1990-01-01', phone: '03001230001', joinDate: '2026-01-01' } });
  teacherStaffId = staffRes.body.data.id;
  made.staff.push(teacherStaffId);

  await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(TEACHER.password);
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [TEACHER.username]);
    const userId = existing
      ? existing.id
      : (await uow.one<{ id: string }>(`INSERT INTO users (username, password_hash, user_type, staff_id, must_change_password, is_active) VALUES ($1, $2, 'staff', $3, false, true) RETURNING id::text AS id`, [TEACHER.username, hash, teacherStaffId])).id;
    if (!existing) {
      await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'Teacher'`, [userId]);
    } else {
      await uow.count(`UPDATE users SET staff_id = $2 WHERE id = $1`, [userId, teacherStaffId]);
    }
  });
  const teacherLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: TEACHER.username, password: TEACHER.password } });
  if (teacherLogin.status !== 200) throw new Error('Teacher login failed: ' + JSON.stringify(teacherLogin.body));
  teacherToken = teacherLogin.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    await uow.count(`DELETE FROM staff_attendance WHERE staff_id = $1`, [teacherStaffId]);
    for (const id of made.students) {
      await uow.count(`DELETE FROM student_attendance WHERE enrollment_id IN (SELECT id FROM student_enrollments WHERE student_id = $1)`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
    }
    for (const id of made.students) await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    // sections.class_teacher_id RESTRICTs staff (one section here names
    // teacherStaffId as its class teacher) — sections have to go first.
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    await uow.count(`UPDATE users SET staff_id = NULL WHERE staff_id = $1`, [teacherStaffId]);
    for (const id of made.staff) await uow.count(`DELETE FROM staff WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Attendance API', () => {
  let yearId: string, classId: string, sectionId: string;
  let enrollment1: string, enrollment2: string;
  // Today: a Teacher holds attendance.mark but not attendance.edit_past, so
  // only today's own date needs no special permission. This assumes the
  // suite runs on a weekday, which the weekend-rejection test below checks
  // independently via nextSaturday() rather than relying on this date.
  const date = todayIso();

  beforeAll(async () => {
    const yearRes = await call('/api/v1/academic/years', { method: 'POST', body: { name: '2026-27-attendance', startDate: '2026-01-01', endDate: '2026-12-31' } });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);
    const classRes = await call('/api/v1/academic/classes', { method: 'POST', body: { name: 'Attendance Class', levelOrder: 91 } });
    classId = classRes.body.data.id;
    made.classes.push(classId);
    const secRes = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'Att-A', capacity: 5 } });
    sectionId = secRes.body.data.id;
    made.sections.push(sectionId);
    // Make the teacher this section's class teacher so attendance.mark's
    // scope check (SectionPolicy.canMarkAttendance -> teacherSectionIds)
    // passes for them.
    const patchSection = await call(`/api/v1/academic/sections/${sectionId}`, { method: 'PATCH', body: { classTeacherId: teacherStaffId } });
    if (patchSection.status !== 200) throw new Error('Could not set class teacher: ' + JSON.stringify(patchSection.body));

    const s1 = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Att', lastName: 'One', gender: 'male', dob: '2015-01-01', admissionDate: '2026-01-01' } });
    made.students.push(s1.body.data.student.id);
    const e1 = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: s1.body.data.student.id, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollment1 = e1.body.data.id;

    const s2 = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Att', lastName: 'Two', gender: 'female', dob: '2015-01-02', admissionDate: '2026-01-01' } });
    made.students.push(s2.body.data.student.id);
    const e2 = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: s2.body.data.student.id, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollment2 = e2.body.data.id;
  });

  it('an unauthenticated submit is rejected before any business logic runs', async () => {
    const noAuth = await fetch(`${baseUrl}/api/v1/attendance/students/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectionId, academicYearId: yearId, date, entries: [{ enrollmentId: enrollment1, status: 'present' }] }),
    });
    expect(noAuth.status).toBe(401);
  });

  it('gets an empty sheet for the section before anything is submitted', async () => {
    const res = await call(`/api/v1/attendance/students/sections/${sectionId}/years/${yearId}?date=${date}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sheet.length).toBe(2);
    expect(res.body.data.sheet.every((s: { status: string | null }) => s.status === null)).toBe(true);
  });

  it('rejects a batch containing an enrollment outside the section (atomic: nothing is written)', async () => {
    const res = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      token: teacherToken,
      body: { sectionId, academicYearId: yearId, date, reason: 'backfill', entries: [{ enrollmentId: enrollment1, status: 'present' }, { enrollmentId: '999999999', status: 'present' }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ENROLLMENT_IN_BATCH');

    const sheet = await call(`/api/v1/attendance/students/sections/${sectionId}/years/${yearId}?date=${date}`);
    expect(sheet.body.data.sheet.every((s: { status: string | null }) => s.status === null)).toBe(true);
  });

  it('submits a valid section sheet in one bulk upsert', async () => {
    const res = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      token: teacherToken,
      body: {
        sectionId,
        academicYearId: yearId,
        date,
        reason: 'backfill for test',
        entries: [{ enrollmentId: enrollment1, status: 'present' }, { enrollmentId: enrollment2, status: 'absent', remarks: 'sick' }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(2);

    const sheet = await call(`/api/v1/attendance/students/sections/${sectionId}/years/${yearId}?date=${date}`);
    const byId = new Map(sheet.body.data.sheet.map((s: { enrollmentId: string; status: string }) => [s.enrollmentId, s.status]));
    expect(byId.get(enrollment1)).toBe('present');
    expect(byId.get(enrollment2)).toBe('absent');
  });

  it('correcting the same date is an upsert, not a duplicate row', async () => {
    const res = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      token: teacherToken,
      body: { sectionId, academicYearId: yearId, date, reason: 'correction', entries: [{ enrollmentId: enrollment1, status: 'late' }] },
    });
    expect(res.status).toBe(200);
    const history = await call(`/api/v1/attendance/students/enrollments/${enrollment1}`);
    expect(history.body.data.items.filter((i: { attDate: string }) => i.attDate.startsWith(date)).length).toBe(1);
    expect(history.body.data.items[0].status).toBe('late');
  });

  it('gives a section attendance summary with correct counts', async () => {
    const res = await call(`/api/v1/attendance/students/sections/${sectionId}/years/${yearId}/summary?date=${date}`);
    expect(res.status).toBe(200);
    expect(res.body.data.late).toBe(1);
    expect(res.body.data.absent).toBe(1);
    expect(res.body.data.total).toBe(2);
  });

  it('a teacher cannot see a section they are not assigned to (404, not 403)', async () => {
    const otherSection = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'Att-B', capacity: 5 } });
    made.sections.push(otherSection.body.data.id);
    const res = await call(`/api/v1/attendance/students/sections/${otherSection.body.data.id}/years/${yearId}?date=${date}`, { token: teacherToken });
    expect(res.status).toBe(404);
  });

  it('a teacher cannot edit a past date without edit-past, but an admin can with a reason', async () => {
    const past = pastMonday();
    const byTeacher = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      token: teacherToken,
      body: { sectionId, academicYearId: yearId, date: past, reason: 'backfill', entries: [{ enrollmentId: enrollment1, status: 'present' }] },
    });
    expect(byTeacher.status).toBe(403);

    const withoutReason = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      body: { sectionId, academicYearId: yearId, date: past, entries: [{ enrollmentId: enrollment1, status: 'present' }] },
    });
    expect(withoutReason.status).toBe(422);

    const byAdmin = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      body: { sectionId, academicYearId: yearId, date: past, reason: 'backfilling a missed day', entries: [{ enrollmentId: enrollment1, status: 'present' }] },
    });
    expect(byAdmin.status).toBe(200);
  });

  it('rejects attendance on a weekend', async () => {
    const saturday = nextSaturday(date);
    const res = await call('/api/v1/attendance/students/submit', {
      method: 'POST',
      token: teacherToken,
      body: { sectionId, academicYearId: yearId, date: saturday, reason: 'x', entries: [{ enrollmentId: enrollment1, status: 'present' }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_A_SCHOOL_DAY');
  });

  /* ---------------- staff attendance ---------------- */

  it('submits staff attendance and retrieves it back', async () => {
    const res = await call('/api/v1/attendance/staff/submit', {
      method: 'POST',
      body: { date, reason: 'backfill', entries: [{ staffId: teacherStaffId, status: 'present', checkIn: '08:00', checkOut: '14:00' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(1);

    const own = await call(`/api/v1/attendance/staff/${teacherStaffId}`, { token: teacherToken });
    expect(own.status).toBe(200);
    expect(own.body.data.items[0].status).toBe('present');
  });

  it('rejects check-out before check-in', async () => {
    const res = await call('/api/v1/attendance/staff/submit', {
      method: 'POST',
      body: { date, reason: 'x', entries: [{ staffId: teacherStaffId, status: 'present', checkIn: '14:00', checkOut: '08:00' }] },
    });
    expect(res.status).toBe(422);
  });

  it('refuses attendance for a deactivated staff member', async () => {
    const resigned = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Resigned Person', gender: 'male', dob: '1985-01-01', phone: '03001239999', joinDate: '2025-01-01' } });
    made.staff.push(resigned.body.data.id);
    await call(`/api/v1/staff/${resigned.body.data.id}/deactivate`, { method: 'POST', body: { status: 'resigned', separationDate: '2026-01-01' } });

    const res = await call('/api/v1/attendance/staff/submit', {
      method: 'POST',
      body: { date, reason: 'x', entries: [{ staffId: resigned.body.data.id, status: 'present' }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STAFF_NOT_ACTIVE');
  });

  it('a staff member cannot read someone else’s attendance history (404, not 403)', async () => {
    const ownHistory = await call(`/api/v1/attendance/staff/${teacherStaffId}`, { token: teacherToken });
    expect(ownHistory.status).toBe(200); // reading your own is fine

    const other = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Other Staff', gender: 'female', dob: '1992-01-01', phone: '03001237777', joinDate: '2026-01-01' } });
    made.staff.push(other.body.data.id);
    const blocked = await call(`/api/v1/attendance/staff/${other.body.data.id}`, { token: teacherToken });
    expect(blocked.status).toBe(404);
  });
});
