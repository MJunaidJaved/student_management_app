import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_leave__', password: 'LeavePassw0rd!2026' };
const TEACHER = { username: '__apitest_leave_teacher__', password: 'LeaveTeacher!2026' };
const SECOND_STAFF = { username: '__apitest_leave_staff2__', password: 'LeaveStaff2!2026' };
const PRINCIPAL = { username: '__apitest_leave_principal__', password: 'LeavePrincipal!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let teacherToken: string;
let secondStaffToken: string;
let principalToken: string;
let teacherStaffId: string;
let secondStaffId: string;
let principalStaffId: string;

const made = { years: [] as string[], classes: [] as string[], sections: [] as string[], students: [] as string[], guardians: [] as string[], staff: [] as string[], leaveTypes: [] as string[] };

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ensureUser(username: string, password: string, role: string, staffId?: string): Promise<string> {
  return transaction(SYSTEM_ACTOR, async (uow) => {
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true, staff_id = $2 WHERE id = $1`, [existing.id, staffId ?? null]);
      return existing.id;
    }
    const hash = await hashPassword(password);
    const userType = staffId ? 'staff' : 'admin';
    const u = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, staff_id, must_change_password, is_active) VALUES ($1, $2, $3, $4, false, true) RETURNING id::text AS id`,
      [username, hash, userType, staffId ?? null],
    );
    await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [u.id, role]);
    return u.id;
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

  const staffRes = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Leave Teacher', gender: 'male', dob: '1988-01-01', phone: '03001231111', joinDate: '2025-01-01' } });
  teacherStaffId = staffRes.body.data.id;
  made.staff.push(teacherStaffId);
  await ensureUser(TEACHER.username, TEACHER.password, 'Teacher', teacherStaffId);
  const teacherLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: TEACHER.username, password: TEACHER.password } });
  if (teacherLogin.status !== 200) throw new Error('Teacher login failed: ' + JSON.stringify(teacherLogin.body));
  teacherToken = teacherLogin.body.data.accessToken;

  const staff2Res = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Second Staff', gender: 'female', dob: '1991-01-01', phone: '03001232222', joinDate: '2025-01-01' } });
  secondStaffId = staff2Res.body.data.id;
  made.staff.push(secondStaffId);
  await ensureUser(SECOND_STAFF.username, SECOND_STAFF.password, 'Teacher', secondStaffId);
  const staff2Login = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: SECOND_STAFF.username, password: SECOND_STAFF.password } });
  if (staff2Login.status !== 200) throw new Error('Second staff login failed: ' + JSON.stringify(staff2Login.body));
  secondStaffToken = staff2Login.body.data.accessToken;

  // A staff member who ALSO holds Principal (the only role with
  // leave.approve_staff): the one account that can reach the self-approval
  // check, rather than being stopped by the permission gate first.
  const principalStaffRes = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Leave Principal', gender: 'female', dob: '1975-01-01', phone: '03001233333', joinDate: '2020-01-01' } });
  principalStaffId = principalStaffRes.body.data.id;
  made.staff.push(principalStaffId);
  await ensureUser(PRINCIPAL.username, PRINCIPAL.password, 'Principal', principalStaffId);
  const principalLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: PRINCIPAL.username, password: PRINCIPAL.password } });
  if (principalLogin.status !== 200) throw new Error('Principal login failed: ' + JSON.stringify(principalLogin.body));
  principalToken = principalLogin.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    // notification_logs RESTRICTs both guardians and users, and every leave
    // decision in this suite wrote one — these have to go before anything
    // they reference, or the whole cleanup transaction rolls back and every
    // row below (including the academic year) is left behind for the next
    // test file to collide with.
    const staffUserIds = (
      await uow.many<{ id: string }>(`SELECT id::text AS id FROM users WHERE staff_id = ANY($1)`, [[teacherStaffId, secondStaffId, principalStaffId]])
    ).map((r) => r.id);
    const notificationIds = (
      await uow.many<{ id: string }>(
        `SELECT DISTINCT notification_id::text AS id FROM notification_logs WHERE guardian_id = ANY($1) OR user_id = ANY($2)`,
        [made.guardians, staffUserIds],
      )
    ).map((r) => r.id);
    await uow.count(`DELETE FROM notification_logs WHERE guardian_id = ANY($1) OR user_id = ANY($2)`, [made.guardians, staffUserIds]);
    await uow.count(`DELETE FROM notifications WHERE id = ANY($1)`, [notificationIds]);

    for (const id of made.students) {
      await uow.count(`DELETE FROM leave_requests WHERE enrollment_id IN (SELECT id FROM student_enrollments WHERE student_id = $1)`, [id]);
      await uow.count(`DELETE FROM student_guardians WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
    }
    await uow.count(`DELETE FROM leave_requests WHERE staff_id = ANY($1)`, [[teacherStaffId, secondStaffId, principalStaffId]]);
    await uow.count(`DELETE FROM staff_leave_balances WHERE staff_id = ANY($1)`, [[teacherStaffId, secondStaffId, principalStaffId]]);
    for (const id of made.students) await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    for (const id of made.guardians) await uow.count(`DELETE FROM guardians WHERE id = $1`, [id]);
    for (const id of made.leaveTypes) await uow.count(`DELETE FROM leave_types WHERE id = $1`, [id]);
    // sections.class_teacher_id RESTRICTs staff (teacherStaffId is set as a
    // class teacher in beforeAll) — sections have to go before staff.
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    await uow.count(`UPDATE users SET staff_id = NULL WHERE staff_id = ANY($1)`, [[teacherStaffId, secondStaffId, principalStaffId]]);
    for (const id of made.staff) await uow.count(`DELETE FROM staff WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Leave API', () => {
  let studentLeaveTypeId: string;
  let staffLeaveTypeId: string;
  let yearId: string, classId: string, sectionId: string, studentId: string, enrollmentId: string, guardianId: string;

  beforeAll(async () => {
    const lt1 = await call('/api/v1/leave-types', { method: 'POST', body: { name: '__test sick leave (student)', appliesTo: 'student', daysPerYear: 10 } });
    studentLeaveTypeId = lt1.body.data.id;
    made.leaveTypes.push(studentLeaveTypeId);
    const lt2 = await call('/api/v1/leave-types', { method: 'POST', body: { name: '__test casual leave (staff)', appliesTo: 'staff', daysPerYear: 14 } });
    staffLeaveTypeId = lt2.body.data.id;
    made.leaveTypes.push(staffLeaveTypeId);

    const yearRes = await call('/api/v1/academic/years', { method: 'POST', body: { name: '2026-27-leave', startDate: '2026-01-01', endDate: '2026-12-31' } });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);
    const classRes = await call('/api/v1/academic/classes', { method: 'POST', body: { name: 'Leave Class', levelOrder: 92 } });
    classId = classRes.body.data.id;
    made.classes.push(classId);
    const secRes = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'Leave-A', capacity: 5 } });
    sectionId = secRes.body.data.id;
    made.sections.push(sectionId);
    await call(`/api/v1/academic/sections/${sectionId}`, { method: 'PATCH', body: { classTeacherId: teacherStaffId } });

    const s = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Leave', lastName: 'Student', gender: 'male', dob: '2015-01-01', admissionDate: '2026-01-01' } });
    studentId = s.body.data.student.id;
    made.students.push(studentId);
    const e = await call('/api/v1/enrollments', { method: 'POST', body: { studentId, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollmentId = e.body.data.id;

    const g = await call('/api/v1/guardians', { method: 'POST', body: { fullName: 'Leave Guardian', phone: '03005551234' } });
    guardianId = g.body.data.id;
    made.guardians.push(guardianId);
    await call('/api/v1/student-guardians', { method: 'POST', body: { studentId, guardianId, relation: 'father', isPrimary: true, isFeePayer: true } });
  });

  it('lists leave types, including the ones created for this suite', async () => {
    const res = await call('/api/v1/leave-types');
    expect(res.status).toBe(200);
    expect(res.body.data.leaveTypes.some((t: { id: string }) => t.id === studentLeaveTypeId)).toBe(true);
    expect(res.body.data.leaveTypes.some((t: { id: string }) => t.id === staffLeaveTypeId)).toBe(true);
  });

  it('edits a leave type', async () => {
    const res = await call('/api/v1/leave-types', { method: 'POST', body: { name: '__apitest editable leave', appliesTo: 'staff', daysPerYear: 5 } });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    made.leaveTypes.push(id);

    const edited = await call(`/api/v1/leave-types/${id}`, { method: 'PATCH', body: { daysPerYear: 7 } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.daysPerYear).toBe(7);
  });

  it('deletes a leave type that has no requests or balances attached', async () => {
    const created = await call('/api/v1/leave-types', { method: 'POST', body: { name: '__apitest disposable leave', appliesTo: 'staff', daysPerYear: 3 } });
    const id = created.body.data.id;

    const deleted = await call(`/api/v1/leave-types/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const listed = await call('/api/v1/leave-types');
    expect(listed.body.data.leaveTypes.some((t: { id: string }) => t.id === id)).toBe(false);
  });

  it('denies managing leave types to a caller without leave.manage_types', async () => {
    const res = await call('/api/v1/leave-types', { token: teacherToken, method: 'POST', body: { name: 'Should Not Be Created', appliesTo: 'staff', daysPerYear: 1 } });
    expect(res.status).toBe(403);
  });

  it('rejects an inverted date range', async () => {
    const res = await call('/api/v1/leave/student-requests', { method: 'POST', body: { enrollmentId, leaveTypeId: studentLeaveTypeId, fromDate: '2026-03-10', toDate: '2026-03-05' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it('submits a student leave request', async () => {
    const res = await call('/api/v1/leave/student-requests', { method: 'POST', body: { enrollmentId, leaveTypeId: studentLeaveTypeId, fromDate: '2026-03-10', toDate: '2026-03-12', reason: 'fever' } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
  });

  it('rejects an overlapping student leave request', async () => {
    const res = await call('/api/v1/leave/student-requests', { method: 'POST', body: { enrollmentId, leaveTypeId: studentLeaveTypeId, fromDate: '2026-03-11', toDate: '2026-03-15' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERLAPPING_LEAVE');
  });

  it('the assigned class teacher can approve the student leave; an unrelated teacher cannot', async () => {
    // Set up a second section this teacher does NOT own, to prove scoping.
    const otherSection = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'Leave-B', capacity: 5 } });
    made.sections.push(otherSection.body.data.id);

    const list = await call('/api/v1/leave/requests?applicantType=student&status=pending', { token: teacherToken });
    expect(list.status).toBe(200);
    const requestId = list.body.data.items[0].id;

    const byOther = await call(`/api/v1/leave/student-requests/${requestId}/decide`, { method: 'POST', token: secondStaffToken, body: { decision: 'approved' } });
    expect(byOther.status).toBe(404); // not assigned to this section

    const res = await call(`/api/v1/leave/student-requests/${requestId}/decide`, { method: 'POST', token: teacherToken, body: { decision: 'approved' } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
  });

  it('the guardian’s notification was recorded for the decision', async () => {
    // No direct guardian login in this suite; verify the notification_logs
    // row exists for the guardian directly, which is what the read endpoints
    // are themselves built on.
    const row = await transaction(SYSTEM_ACTOR, (uow) =>
      uow.maybeOne<{ n: number }>(`SELECT count(*)::int AS n FROM notification_logs WHERE guardian_id = $1`, [guardianId]),
    );
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });

  it('sets a staff leave balance, then submits and approves staff leave against it', async () => {
    const balance = await call('/api/v1/staff-leave-balances', { method: 'POST', body: { staffId: teacherStaffId, leaveTypeId: staffLeaveTypeId, academicYearId: yearId, allotted: 5 } });
    expect(balance.status).toBe(201);

    const submitted = await call('/api/v1/leave/staff-requests', { method: 'POST', token: teacherToken, body: { leaveTypeId: staffLeaveTypeId, fromDate: '2026-05-01', toDate: '2026-05-03', reason: 'personal' } });
    expect(submitted.status).toBe(201);
    const requestId = submitted.body.data.id;

    // A Teacher does not hold leave.approve_staff at all, so this is stopped
    // at the permission gate — a real check, just not the segregation one.
    const notAnApprover = await call(`/api/v1/leave/staff-requests/${requestId}/decide`, { method: 'POST', token: teacherToken, body: { decision: 'approved' } });
    expect(notAnApprover.status).toBe(403);

    const approved = await call(`/api/v1/leave/staff-requests/${requestId}/decide`, { method: 'POST', body: { decision: 'approved' } }); // admin
    expect(approved.status).toBe(200);

    const balances = await call(`/api/v1/staff/${teacherStaffId}/leave-balances`, { token: teacherToken });
    const row = balances.body.data.balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === staffLeaveTypeId);
    expect(Number(row.used)).toBe(3); // May 1-3 inclusive
  });

  it('refuses staff leave beyond the remaining balance', async () => {
    const res = await call('/api/v1/leave/staff-requests', { method: 'POST', token: teacherToken, body: { leaveTypeId: staffLeaveTypeId, fromDate: '2026-06-01', toDate: '2026-06-10', reason: 'long trip' } });
    expect(res.status).toBe(201); // submission itself is fine; the check is at approval
    const approved = await call(`/api/v1/leave/staff-requests/${res.body.data.id}/decide`, { method: 'POST', body: { decision: 'approved' } });
    expect(approved.status).toBe(422);
    expect(approved.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('cancelling an approved staff leave restores the balance', async () => {
    const list = await call(`/api/v1/leave/requests?applicantType=staff&status=approved&staffId=${teacherStaffId}`);
    const requestId = list.body.data.items[0].id;
    const before = await call(`/api/v1/staff/${teacherStaffId}/leave-balances`, { token: teacherToken });
    const usedBefore = Number(before.body.data.balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === staffLeaveTypeId).used);

    const res = await call(`/api/v1/leave/requests/${requestId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');

    const after = await call(`/api/v1/staff/${teacherStaffId}/leave-balances`, { token: teacherToken });
    const usedAfter = Number(after.body.data.balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === staffLeaveTypeId).used);
    expect(usedAfter).toBe(usedBefore - 3);
  });

  it('rejects an illegal transition (deciding an already-decided request)', async () => {
    const list = await call(`/api/v1/leave/requests?applicantType=staff&status=cancelled&staffId=${teacherStaffId}`);
    const requestId = list.body.data.items[0].id;
    const res = await call(`/api/v1/leave/staff-requests/${requestId}/decide`, { method: 'POST', body: { decision: 'approved' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_LEAVE_TRANSITION');
  });

  it('segregation of duties: a Principal cannot approve their own leave request, even though they hold the permission', async () => {
    const submitted = await call('/api/v1/leave/staff-requests', { method: 'POST', token: principalToken, body: { leaveTypeId: staffLeaveTypeId, fromDate: '2026-08-01', toDate: '2026-08-02', reason: 'self' } });
    expect(submitted.status).toBe(201);

    const res = await call(`/api/v1/leave/staff-requests/${submitted.body.data.id}/decide`, { method: 'POST', token: principalToken, body: { decision: 'approved' } });
    expect(res.status).toBe(403);

    // A different approver (admin) can still decide it.
    const decided = await call(`/api/v1/leave/staff-requests/${submitted.body.data.id}/decide`, { method: 'POST', body: { decision: 'rejected' } });
    expect(decided.status).toBe(200);
  });

  it('a staff member cannot submit a leave type that does not apply to them', async () => {
    const res = await call('/api/v1/leave/staff-requests', { method: 'POST', token: teacherToken, body: { leaveTypeId: studentLeaveTypeId, fromDate: '2026-07-01', toDate: '2026-07-02' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LEAVE_TYPE_MISMATCH');
  });
});
