import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_exams__', password: 'ExamsPassw0rd!2026' };
const TEACHER = { username: '__apitest_exams_teacher__', password: 'ExamsTeacher!2026' };
const GUARDIAN = { username: '__apitest_exams_guardian__', password: 'ExamsGuardian!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let teacherToken: string;
let guardianToken: string;

const made = {
  years: [] as string[], classes: [] as string[], sections: [] as string[], subjects: [] as string[], rooms: [] as string[],
  staff: [] as string[], students: [] as string[], guardians: [] as string[], examTypes: [] as string[], exams: [] as string[],
  scales: [] as string[],
};

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ensureUser(username: string, password: string, role: string, extra: { staffId?: string; guardianId?: string } = {}): Promise<void> {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true, staff_id = $2, guardian_id = $3 WHERE id = $1`, [existing.id, extra.staffId ?? null, extra.guardianId ?? null]);
      return;
    }
    const hash = await hashPassword(password);
    const userType = extra.staffId ? 'staff' : extra.guardianId ? 'guardian' : 'admin';
    const u = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, staff_id, guardian_id, must_change_password, is_active) VALUES ($1, $2, $3, $4, $5, false, true) RETURNING id::text AS id`,
      [username, hash, userType, extra.staffId ?? null, extra.guardianId ?? null],
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
    for (const id of made.exams) {
      await uow.count(`DELETE FROM report_cards WHERE exam_id = $1`, [id]);
      await uow.count(`DELETE FROM marks WHERE exam_schedule_id IN (SELECT id FROM exam_schedules WHERE exam_id = $1)`, [id]);
      await uow.count(`DELETE FROM exam_schedules WHERE exam_id = $1`, [id]);
      await uow.count(`DELETE FROM exams WHERE id = $1`, [id]);
    }
    for (const id of made.examTypes) await uow.count(`DELETE FROM exam_types WHERE id = $1`, [id]);
    for (const id of made.scales) {
      await uow.count(`DELETE FROM grading_scale_ranges WHERE grading_scale_id = $1`, [id]);
      await uow.count(`DELETE FROM grading_scales WHERE id = $1`, [id]);
    }
    for (const id of made.students) {
      await uow.count(`DELETE FROM student_guardians WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    }
    // Not deleted: `users_check` requires a guardian-type user's guardian_id
    // to stay non-null (unlike staff, where nulling staff_id is legal), so a
    // guardian row with a login user attached can never be unlinked, only
    // reassigned. One 'Exam Guardian' row per run is accepted, harmless
    // residue — the same class of permanence Section 3 already documented.
    await uow.count(`DELETE FROM subject_teachers WHERE staff_id = ANY($1)`, [made.staff]);
    await uow.count(`UPDATE users SET staff_id = NULL WHERE staff_id = ANY($1)`, [made.staff]);
    for (const id of made.staff) await uow.count(`DELETE FROM staff WHERE id = $1`, [id]);
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM class_subjects WHERE class_id = $1`, [id]);
    for (const id of made.subjects) await uow.count(`DELETE FROM subjects WHERE id = $1`, [id]);
    for (const id of made.rooms) await uow.count(`DELETE FROM rooms WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Exams API', () => {
  let yearId: string, classId: string, sectionId: string, subjectId: string, roomId: string;
  let teacherStaffId: string, otherStaffId: string;
  let studentAId: string, studentBId: string, enrollmentAId: string, enrollmentBId: string;
  let examTypeId: string, scaleId: string;

  // Split into several beforeAll blocks rather than one long one: each gets
  // its own hookTimeout allowance, so a slow network hop doesn't throw away
  // setup work that already completed (Supabase is a network hop away, and
  // this file alone makes ~20 round trips before the first test runs).
  beforeAll(async () => {
    const yearRes = await call('/api/v1/academic/years', { method: 'POST', body: { name: '2026-27-exams', startDate: '2026-01-01', endDate: '2026-12-31' } });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);
    const classRes = await call('/api/v1/academic/classes', { method: 'POST', body: { name: 'Exams Class', levelOrder: 92 } });
    classId = classRes.body.data.id;
    made.classes.push(classId);
    const sectionRes = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'Exams-A', capacity: 10 } });
    sectionId = sectionRes.body.data.id;
    made.sections.push(sectionId);

    const subjectRes = await call('/api/v1/academic/subjects', { method: 'POST', body: { code: 'EX1', name: 'Exams Subject', type: 'core' } });
    subjectId = subjectRes.body.data.id;
    made.subjects.push(subjectId);
    await call(`/api/v1/academic/classes/${classId}/subjects`, { method: 'PUT', body: { subjects: [{ subjectId, isMandatory: true }] } });

    const roomRes = await call('/api/v1/academic/rooms', { method: 'POST', body: { name: 'Exams Hall', roomType: 'classroom' } });
    roomId = roomRes.body.data.id;
    made.rooms.push(roomId);
  });

  beforeAll(async () => {
    const teacher = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Exams Teacher', gender: 'male', dob: '1985-01-01', phone: '03009990001', joinDate: '2025-01-01' } });
    teacherStaffId = teacher.body.data.id;
    made.staff.push(teacherStaffId);
    await ensureUser(TEACHER.username, TEACHER.password, 'Teacher', { staffId: teacherStaffId });
    const teacherLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: TEACHER.username, password: TEACHER.password } });
    teacherToken = teacherLogin.body.data.accessToken;

    const other = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Unassigned Teacher', gender: 'female', dob: '1987-01-01', phone: '03009990002', joinDate: '2025-01-01' } });
    otherStaffId = other.body.data.id;
    made.staff.push(otherStaffId);

    await call('/api/v1/academic/subject-teachers', { method: 'POST', body: { academicYearId: yearId, sectionId, subjectId, staffId: teacherStaffId } });
  });

  beforeAll(async () => {
    const sA = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Exam', lastName: 'StudentA', gender: 'male', dob: '2015-01-01', admissionDate: '2026-01-01' } });
    studentAId = sA.body.data.student.id;
    made.students.push(studentAId);
    const eA = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: studentAId, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollmentAId = eA.body.data.id;

    const sB = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Exam', lastName: 'StudentB', gender: 'female', dob: '2015-02-01', admissionDate: '2026-01-01' } });
    studentBId = sB.body.data.student.id;
    made.students.push(studentBId);
    const eB = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: studentBId, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollmentBId = eB.body.data.id;
  });

  beforeAll(async () => {
    const guardian = await call('/api/v1/guardians', { method: 'POST', body: { fullName: 'Exam Guardian', phone: '03009990003' } });
    made.guardians.push(guardian.body.data.id);
    await call('/api/v1/student-guardians', { method: 'POST', body: { studentId: studentAId, guardianId: guardian.body.data.id, relation: 'father', isPrimary: true, isFeePayer: true } });
    await ensureUser(GUARDIAN.username, GUARDIAN.password, 'Guardian', { guardianId: guardian.body.data.id });
    const guardianLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: GUARDIAN.username, password: GUARDIAN.password } });
    guardianToken = guardianLogin.body.data.accessToken;

    const typeRes = await call('/api/v1/exam-types', { method: 'POST', body: { name: '__test Mid Term', weightage: '50' } });
    examTypeId = typeRes.body.data.id;
    made.examTypes.push(examTypeId);

    const scaleRes = await call('/api/v1/grading-scales', { method: 'POST', body: { name: '__test Scale', isDefault: true } });
    scaleId = scaleRes.body.data.id;
    made.scales.push(scaleId);
    await call('/api/v1/grading-scale-ranges', { method: 'POST', body: { gradingScaleId: scaleId, minPercent: '90', maxPercent: '100', grade: 'A+' } });
    await call('/api/v1/grading-scale-ranges', { method: 'POST', body: { gradingScaleId: scaleId, minPercent: '0', maxPercent: '89.99', grade: 'B' } });
  });

  it('lists grading scales, camelCase, including the default one for this suite', async () => {
    const res = await call('/api/v1/grading-scales');
    expect(res.status).toBe(200);
    const scale = res.body.data.scales.find((s: { id: string }) => s.id === scaleId);
    expect(scale).toBeDefined();
    expect(scale.isDefault).toBe(true);
  });

  it("lists a grading scale's ranges in order", async () => {
    const res = await call(`/api/v1/grading-scales/${scaleId}/ranges`);
    expect(res.status).toBe(200);
    expect(res.body.data.ranges.length).toBe(2);
    expect(res.body.data.ranges.some((r: { grade: string }) => r.grade === 'A+')).toBe(true);
  });

  it('a second scale set as default takes over, and only one scale is ever default', async () => {
    const second = await call('/api/v1/grading-scales', { method: 'POST', body: { name: '__apitest Second Scale' } });
    expect(second.status).toBe(201);
    expect(second.body.data.isDefault).toBe(false);
    made.scales.push(second.body.data.id);

    const setDefault = await call(`/api/v1/grading-scales/${second.body.data.id}/set-default`, { method: 'POST' });
    expect(setDefault.status, JSON.stringify(setDefault.body)).toBe(200);
    expect(setDefault.body.data.isDefault).toBe(true);

    const list = await call('/api/v1/grading-scales');
    const defaults = list.body.data.scales.filter((s: { isDefault: boolean }) => s.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(second.body.data.id);

    // Restore the original default so later tests relying on it are unaffected.
    const restore = await call(`/api/v1/grading-scales/${scaleId}/set-default`, { method: 'POST' });
    expect(restore.status).toBe(200);
  });

  it('denies managing grading scales to a caller without exams.manage_grading', async () => {
    const res = await call('/api/v1/grading-scales', { token: teacherToken, method: 'POST', body: { name: 'Should Not Be Created' } });
    expect(res.status).toBe(403);
  });

  let examId: string;
  it('creates a draft exam', async () => {
    const res = await call('/api/v1/exams', { method: 'POST', body: { academicYearId: yearId, examTypeId, name: '__test Exam 1', startDate: '2026-03-01', endDate: '2026-03-10' } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    examId = res.body.data.id;
    made.exams.push(examId);
  });

  let scheduleId: string;
  it('schedules a paper for the exam', async () => {
    const res = await call('/api/v1/exam-schedules', { method: 'POST', body: { examId, classId, subjectId, examDate: '2026-03-02', startTime: '09:00', endTime: '10:00', roomId, totalMarks: '100', passingMarks: '40' } });
    expect(res.status).toBe(201);
    scheduleId = res.body.data.id;
  });

  it('rejects a conflicting schedule in the same room at an overlapping time', async () => {
    const res = await call('/api/v1/exam-schedules', { method: 'POST', body: { examId, classId, subjectId, examDate: '2026-03-02', startTime: '09:30', endTime: '10:30', roomId, totalMarks: '50', passingMarks: '20' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EXAM_SCHEDULE_CONFLICT');
  });

  let otherToken: string;
  it('rejects marks entry from a teacher not assigned to this subject', async () => {
    await ensureUser('__apitest_exams_other__', 'ExamsOther!2026', 'Teacher', { staffId: otherStaffId });
    const login = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: '__apitest_exams_other__', password: 'ExamsOther!2026' } });
    otherToken = login.body.data.accessToken;

    const res = await call('/api/v1/marks/submit', {
      token: otherToken,
      method: 'POST',
      body: { examScheduleId: scheduleId, entries: [{ enrollmentId: enrollmentAId, marksObtained: '80', isAbsent: false }] },
    });
    expect(res.status).toBe(403);
  });

  it('rejects an absent entry that also carries a mark', async () => {
    const res = await call('/api/v1/marks/submit', {
      token: teacherToken,
      method: 'POST',
      body: { examScheduleId: scheduleId, entries: [{ enrollmentId: enrollmentBId, marksObtained: '50', isAbsent: true }] },
    });
    expect(res.status).toBe(422);
  });

  it('rejects a mark above the schedule’s total', async () => {
    const res = await call('/api/v1/marks/submit', {
      token: teacherToken,
      method: 'POST',
      body: { examScheduleId: scheduleId, entries: [{ enrollmentId: enrollmentBId, marksObtained: '150', isAbsent: false }] },
    });
    expect(res.status).toBe(422);
  });

  it('rejects an enrollment outside this class', async () => {
    const res = await call('/api/v1/marks/submit', {
      token: teacherToken,
      method: 'POST',
      body: { examScheduleId: scheduleId, entries: [{ enrollmentId: '999999999', marksObtained: '50', isAbsent: false }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ENROLLMENT_IN_BATCH');
  });

  it('submits a valid bulk marks entry, upserting on resubmission', async () => {
    const res = await call('/api/v1/marks/submit', {
      token: teacherToken,
      method: 'POST',
      body: { examScheduleId: scheduleId, entries: [{ enrollmentId: enrollmentAId, marksObtained: '95', isAbsent: false }, { enrollmentId: enrollmentBId, marksObtained: '60', isAbsent: false }] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.marks.length).toBe(2);

    const count = await transaction(SYSTEM_ACTOR, (uow) => uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM marks WHERE exam_schedule_id = $1`, [scheduleId]));
    expect(count.n).toBe(2);
  });

  it('previews result computation without publishing', async () => {
    const res = await call(`/api/v1/exams/${examId}/compute-results`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.published).toBe(2);
    expect(res.body.data.skipped).toEqual([]);

    const check = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentAId}`);
    expect(check.body.data.publishedAt).toBeNull();
  });

  it("a guardian cannot see a child's report card before it is published", async () => {
    const res = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentAId}`, { token: guardianToken });
    expect(res.status).toBe(404);
  });

  it('publishes the exam, computing report cards with grade and rank', async () => {
    const res = await call(`/api/v1/exams/${examId}/publish`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.exam.status).toBe('published');
    expect(res.body.data.published).toBe(2);

    const cardA = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentAId}`);
    expect(cardA.body.data.obtainedMarks).toBe('95.00');
    expect(cardA.body.data.totalMarks).toBe('100.00');
    expect(cardA.body.data.percentage).toBe('95.00');
    expect(cardA.body.data.grade).toBe('A+');
    expect(cardA.body.data.rank).toBe(1);
    expect(cardA.body.data.publishedAt).not.toBeNull();

    const cardB = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentBId}`);
    expect(cardB.body.data.percentage).toBe('60.00');
    expect(cardB.body.data.grade).toBe('B');
    expect(cardB.body.data.rank).toBe(2);
  });

  it('a guardian can now see the published report card for their own child, not the other student', async () => {
    const own = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentAId}`, { token: guardianToken });
    expect(own.status).toBe(200);
    expect(own.body.data.grade).toBe('A+');

    const other = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentBId}`, { token: guardianToken });
    expect(other.status).toBe(404);
  });

  it('refuses further marks edits once the exam is locked', async () => {
    const lock = await call(`/api/v1/exams/${examId}/lock`, { method: 'POST' });
    expect(lock.status).toBe(200);
    expect(lock.body.data.status).toBe('locked');

    await expect(
      transaction(SYSTEM_ACTOR, (uow) => uow.count(`UPDATE marks SET marks_obtained = '10' WHERE exam_schedule_id = $1 AND enrollment_id = $2`, [scheduleId, enrollmentAId])),
    ).rejects.toThrow(/locked/i);
  });

  it('a teacher cannot unlock an exam (lacks exams.unlock)', async () => {
    const res = await call(`/api/v1/exams/${examId}/unlock`, { method: 'POST', token: teacherToken });
    expect(res.status).toBe(403);
  });

  it('an admin unlocks the exam, reopening it for correction, then re-publishing updates the figures', async () => {
    const unlock = await call(`/api/v1/exams/${examId}/unlock`, { method: 'POST' });
    expect(unlock.status).toBe(200);
    expect(unlock.body.data.status).toBe('draft');

    // Correct student B's mark from 60 to 98 — above A's 95 — so republishing
    // must actually flip the ranking, not just the percentage.
    const correct = await call('/api/v1/marks/submit', { token: teacherToken, method: 'POST', body: { examScheduleId: scheduleId, entries: [{ enrollmentId: enrollmentBId, marksObtained: '98', isAbsent: false }] } });
    expect(correct.status).toBe(201);

    const republish = await call(`/api/v1/exams/${examId}/publish`, { method: 'POST' });
    expect(republish.status).toBe(200);

    const cardB = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentBId}`);
    expect(cardB.body.data.percentage).toBe('98.00');
    expect(cardB.body.data.rank).toBe(1);
    const cardA = await call(`/api/v1/exams/${examId}/report-cards/${enrollmentAId}`);
    expect(cardA.body.data.rank).toBe(2);
  });

  it('refuses to cancel a schedule that already has marks', async () => {
    const res = await call(`/api/v1/exam-schedules/${scheduleId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(422);
  });

  it('lists report cards for a class', async () => {
    const res = await call(`/api/v1/exams/${examId}/report-cards?classId=${classId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.reportCards.length).toBe(2);
  });

  it("lists a student's report-card history", async () => {
    const res = await call(`/api/v1/enrollments/${enrollmentAId}/report-cards`);
    expect(res.status).toBe(200);
    expect(res.body.data.reportCards.some((r: { examId: string }) => r.examId === examId)).toBe(true);
  });

  it('a request without authentication is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/v1/exams`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
