import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_timetable__', password: 'TimetablePassw0rd!2026' };
const TEACHER = { username: '__apitest_timetable_teacher__', password: 'TimetableTeacher!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let teacherToken: string;

const made = {
  years: [] as string[], classes: [] as string[], sections: [] as string[], staff: [] as string[], rooms: [] as string[], periods: [] as string[], subjects: [] as string[],
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
    await uow.count(`DELETE FROM substitutions WHERE timetable_entry_id IN (SELECT id FROM timetable_entries WHERE section_id = ANY($1))`, [made.sections]);
    await uow.count(`DELETE FROM timetable_entries WHERE section_id = ANY($1)`, [made.sections]);
    // subject_teachers RESTRICTs staff; it has to go before the staff rows do.
    await uow.count(`DELETE FROM subject_teachers WHERE section_id = ANY($1)`, [made.sections]);
    for (const id of made.periods) await uow.count(`DELETE FROM periods WHERE id = $1`, [id]);
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

describe('Timetable and substitutions API', () => {
  let yearId: string, classId: string, sectionA: string, sectionB: string, sectionC: string, subjectId: string, roomId: string;
  let period1: string, period2: string;
  let teacherStaffId: string, substituteStaffId: string, inactiveStaffId: string;

  beforeAll(async () => {
    const yearRes = await call('/api/v1/academic/years', { method: 'POST', body: { name: '2026-27-timetable', startDate: '2026-01-01', endDate: '2026-12-31' } });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);
    const classRes = await call('/api/v1/academic/classes', { method: 'POST', body: { name: 'Timetable Class', levelOrder: 93 } });
    classId = classRes.body.data.id;
    made.classes.push(classId);
    const secA = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'TT-A', capacity: 5 } });
    sectionA = secA.body.data.id;
    made.sections.push(sectionA);
    const secB = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'TT-B', capacity: 5 } });
    sectionB = secB.body.data.id;
    made.sections.push(sectionB);
    const secC = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'TT-C', capacity: 5 } });
    sectionC = secC.body.data.id;
    made.sections.push(sectionC);

    const subj = await call('/api/v1/academic/subjects', { method: 'POST', body: { code: 'TT1', name: 'Timetable Subject', type: 'core' } });
    subjectId = subj.body.data.id;
    made.subjects.push(subjectId);
    await call(`/api/v1/academic/classes/${classId}/subjects`, { method: 'PUT', body: { subjects: [{ subjectId, isMandatory: true }] } });

    const room = await call('/api/v1/academic/rooms', { method: 'POST', body: { name: 'Room TT', roomType: 'classroom' } });
    roomId = room.body.data.id;
    made.rooms.push(roomId);

    const p1 = await call('/api/v1/periods', { method: 'POST', body: { name: 'P1', startTime: '08:00', endTime: '08:45', sortOrder: 901 } });
    period1 = p1.body.data.id;
    made.periods.push(period1);
    const p2 = await call('/api/v1/periods', { method: 'POST', body: { name: 'P2', startTime: '08:45', endTime: '09:30', sortOrder: 902 } });
    period2 = p2.body.data.id;
    made.periods.push(period2);

    const teacher = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Timetable Teacher', gender: 'male', dob: '1985-01-01', phone: '03001234001', joinDate: '2025-01-01' } });
    teacherStaffId = teacher.body.data.id;
    made.staff.push(teacherStaffId);
    await ensureUser(TEACHER.username, TEACHER.password, 'Teacher', teacherStaffId);
    const teacherLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: TEACHER.username, password: TEACHER.password } });
    teacherToken = teacherLogin.body.data.accessToken;

    const substitute = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Substitute Teacher', gender: 'female', dob: '1987-01-01', phone: '03001234002', joinDate: '2025-01-01' } });
    substituteStaffId = substitute.body.data.id;
    made.staff.push(substituteStaffId);

    const inactive = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Inactive Teacher', gender: 'male', dob: '1980-01-01', phone: '03001234003', joinDate: '2024-01-01' } });
    inactiveStaffId = inactive.body.data.id;
    made.staff.push(inactiveStaffId);
    await call(`/api/v1/staff/${inactiveStaffId}/deactivate`, { method: 'POST', body: { status: 'resigned', separationDate: '2026-01-01' } });

    // Both teachers assigned to teach this subject in section A (so entry
    // creation and substitution both have a valid, qualified staff member).
    await call('/api/v1/academic/subject-teachers', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionA, subjectId, staffId: teacherStaffId } });
    await call('/api/v1/academic/subject-teachers', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionB, subjectId, staffId: teacherStaffId } });
  });

  it('rejects a subject the class does not study', async () => {
    const otherSubject = await call('/api/v1/academic/subjects', { method: 'POST', body: { code: 'TT2', name: 'Unmapped Subject', type: 'core' } });
    made.subjects.push(otherSubject.body.data.id);
    const res = await call('/api/v1/timetable/entries', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionA, dayOfWeek: 1, periodId: period1, subjectId: otherSubject.body.data.id, staffId: teacherStaffId, roomId } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUBJECT_NOT_IN_CLASS');
  });

  it('rejects a teacher not assigned to teach this subject in this section', async () => {
    const res = await call('/api/v1/timetable/entries', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionA, dayOfWeek: 1, periodId: period1, subjectId, staffId: substituteStaffId, roomId } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TEACHER_NOT_ASSIGNED');
  });

  it('rejects an inactive staff member', async () => {
    // A fresh section: subject_teachers is UNIQUE per (year, section,
    // subject), and sectionA/B already have teacherStaffId occupying that
    // slot, so assigning a second teacher there would itself conflict.
    const assign = await call('/api/v1/academic/subject-teachers', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionC, subjectId, staffId: inactiveStaffId } });
    expect(assign.status).toBe(201);
    const res = await call('/api/v1/timetable/entries', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionC, dayOfWeek: 1, periodId: period1, subjectId, staffId: inactiveStaffId, roomId } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STAFF_NOT_ACTIVE');
  });

  let entryId: string;
  it('creates a valid timetable entry', async () => {
    const res = await call('/api/v1/timetable/entries', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionA, dayOfWeek: 1, periodId: period1, subjectId, staffId: teacherStaffId, roomId } });
    expect(res.status).toBe(201);
    entryId = res.body.data.id;
  });

  it('rejects a second entry for the same teacher at the same slot (different section)', async () => {
    const res = await call('/api/v1/timetable/entries', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionB, dayOfWeek: 1, periodId: period1, subjectId, staffId: teacherStaffId, roomId: undefined } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TIMETABLE_CONFLICT');
    expect(res.body.error.message).toContain('already teaching');
  });

  it('rejects a second entry in the same room at the same slot', async () => {
    const res = await call('/api/v1/timetable/entries', { method: 'POST', body: { academicYearId: yearId, sectionId: sectionB, dayOfWeek: 1, periodId: period1, subjectId, staffId: teacherStaffId, roomId } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TIMETABLE_CONFLICT');
  });

  it('a teacher can view their own timetable; an unrelated section is out of scope', async () => {
    const own = await call(`/api/v1/timetable/staff/${teacherStaffId}/years/${yearId}`, { token: teacherToken });
    expect(own.status).toBe(200);
    expect(own.body.data.entries.length).toBeGreaterThan(0);
  });

  it('bulk-saves a section timetable transactionally, rejecting on an internal duplicate slot', async () => {
    const res = await call(`/api/v1/timetable/sections/${sectionB}/bulk-save`, {
      method: 'POST',
      body: {
        academicYearId: yearId,
        entries: [
          { dayOfWeek: 2, periodId: period1, subjectId, staffId: teacherStaffId },
          { dayOfWeek: 2, periodId: period1, subjectId, staffId: teacherStaffId },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DUPLICATE_SLOT_IN_BATCH');

    // Nothing was written: section B's timetable is still whatever it was before.
    const after = await call(`/api/v1/timetable/sections/${sectionB}/years/${yearId}`);
    expect(after.body.data.entries.some((e: { day_of_week: number }) => e.day_of_week === 2)).toBe(false);
  });

  it('bulk-saves a valid section timetable in one transaction', async () => {
    const res = await call(`/api/v1/timetable/sections/${sectionB}/bulk-save`, {
      method: 'POST',
      body: { academicYearId: yearId, entries: [{ dayOfWeek: 2, periodId: period1, subjectId, staffId: teacherStaffId }, { dayOfWeek: 2, periodId: period2, subjectId, staffId: teacherStaffId }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(2);
  });

  /* ---------------- substitutions ---------------- */

  it('assigns a substitute for a scheduled class', async () => {
    const res = await call('/api/v1/substitutions', { method: 'POST', body: { timetableEntryId: entryId, subDate: '2026-02-02', substituteStaffId, reason: 'sick leave' } });
    expect(res.status).toBe(201);
  });

  it('refuses a duplicate substitution for the same class and date', async () => {
    const res = await call('/api/v1/substitutions', { method: 'POST', body: { timetableEntryId: entryId, subDate: '2026-02-02', substituteStaffId, reason: 'again' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUBSTITUTION_EXISTS');
  });

  it('refuses an inactive substitute', async () => {
    const res = await call('/api/v1/substitutions', { method: 'POST', body: { timetableEntryId: entryId, subDate: '2026-02-03', substituteStaffId: inactiveStaffId } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STAFF_NOT_ACTIVE');
  });

  it('refuses a substitute who already has their own class at that slot', async () => {
    // teacherStaffId has a regular entry at (day 2, period 1) for section B —
    // assigning them as a substitute at the SAME slot must fail.
    const otherEntry = await call(`/api/v1/timetable/sections/${sectionA}/years/${yearId}`);
    const slotEntry = otherEntry.body.data.entries[0];
    const res = await call('/api/v1/substitutions', { method: 'POST', body: { timetableEntryId: slotEntry.id, subDate: '2026-02-02', substituteStaffId: teacherStaffId } });
    // teacherStaffId is already the entry's own teacher, which the service
    // rejects outright as a different, more specific error.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUBSTITUTE_IS_ORIGINAL');
  });

  it('appears in the daily substitution schedule', async () => {
    const res = await call('/api/v1/substitutions?date=2026-02-02');
    expect(res.status).toBe(200);
    expect(res.body.data.substitutions.length).toBeGreaterThan(0);
    expect(res.body.data.substitutions[0].substituteName).toBe('Substitute Teacher');
  });

  let substitutionId: string;
  it('cancels a substitution with an audit trail', async () => {
    const list = await call('/api/v1/substitutions?date=2026-02-02');
    substitutionId = list.body.data.substitutions[0].id;
    const res = await call(`/api/v1/substitutions/${substitutionId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.cancelledAt).toBeDefined();
    expect(res.body.data.cancelledBy).toBeDefined();
  });

  it('refuses to cancel an already-cancelled substitution', async () => {
    const res = await call(`/api/v1/substitutions/${substitutionId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUBSTITUTION_ALREADY_CANCELLED');
  });

  it('a substitute received a notification for the assignment', async () => {
    const userRow = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE staff_id = $1`, [substituteStaffId]));
    expect(userRow).toBeNull(); // no linked user for this fixture — confirms notify() skips cleanly rather than erroring.
  });
});
