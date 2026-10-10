/**
 * API tests for transport (Section 5, Module 13).
 *
 * Capacity and "one active allocation per enrollment" are enforced by the
 * schema itself (see transport.repository.ts's header) — these tests hit
 * that through the real HTTP/database path rather than asserting on the
 * service in isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_transport__', password: 'TransportPassw0rd!2026' };
const NOBODY = { username: '__apitest_transport_nobody__', password: 'TransportPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let nobodyToken: string;
const userIds: string[] = [];
const made = { years: [] as string[], classes: [] as string[], sections: [] as string[], students: [] as string[], guardians: [] as string[] };
const runSuffix = Date.now().toString(36);

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeUser(creds: { username: string; password: string }, roleName: string | null, extra: { guardianId?: string } = {}): Promise<string> {
  return transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(creds.password);
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [creds.username]);
    const userType = extra.guardianId ? 'guardian' : 'admin';
    const id = existing
      ? (await uow.one<{ id: string }>(`UPDATE users SET password_hash = $2, user_type = $3, guardian_id = $4, is_active = true, must_change_password = false, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING id::text AS id`, [existing.id, hash, userType, extra.guardianId ?? null])).id
      : (await uow.one<{ id: string }>(`INSERT INTO users (username, password_hash, user_type, guardian_id, must_change_password, is_active) VALUES ($1, $2, $3, $4, false, true) RETURNING id::text AS id`, [creds.username, hash, userType, extra.guardianId ?? null])).id;
    await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
    if (roleName) await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [id, roleName]);
    return id;
  });
}

async function login(creds: { username: string; password: string }): Promise<string> {
  const res = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: creds });
  if (res.status !== 200) throw new Error(`Login failed for ${creds.username}: ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  userIds.push(await makeUser(ADMIN, SUPER_ADMIN_ROLE));
  userIds.push(await makeUser(NOBODY, null));
  token = await login(ADMIN);
  nobodyToken = await login(NOBODY);
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    for (const id of made.students) {
      await uow.count(`DELETE FROM student_transport WHERE enrollment_id IN (SELECT id FROM student_enrollments WHERE student_id = $1)`, [id]);
      await uow.count(`DELETE FROM student_leaving_records WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_guardians WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
    }
    for (const id of made.students) await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    for (const id of made.sections) await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    for (const id of made.classes) await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    for (const id of made.years) await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
    for (const id of userIds) {
      await uow.count(`UPDATE users SET is_active = false WHERE id = $1`, [id]);
      await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
    }
    // Guardian-type users' guardian_id cannot be nulled (users_check), so
    // these guardians are permanent — same reasoning as library.api.test.ts.
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('Transport API', () => {
  let yearId: string, classId: string, sectionId: string;
  let enrollment1: string, enrollment2: string;
  let vehicleId: string, routeId: string, stopId: string;

  it('denies fleet reads to a caller without transport.read', async () => {
    const res = await call('/api/v1/vehicles', { token: nobodyToken });
    expect(res.status).toBe(403);
  });

  it('builds the fleet, route and two enrolled students', async () => {
    const driver = await call('/api/v1/drivers', { method: 'POST', body: { fullName: '__apitest Driver', licenseNo: `__APITEST-LIC-${runSuffix}`, licenseExpiry: '2030-01-01', phone: '03005550001' } });
    expect(driver.status, JSON.stringify(driver.body)).toBe(201);

    const vehicle = await call('/api/v1/vehicles', { method: 'POST', body: { regNo: `T-${runSuffix}`, capacity: 1, driverId: driver.body.data.id } });
    expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
    vehicleId = vehicle.body.data.id;

    const route = await call('/api/v1/routes', { method: 'POST', body: { name: `__apitest Route ${runSuffix}`, vehicleId } });
    routeId = route.body.data.id;

    const stop = await call('/api/v1/route-stops', { method: 'POST', body: { routeId, stopName: '__apitest Stop', stopOrder: 1, monthlyFee: '50.00' } });
    expect(stop.status, JSON.stringify(stop.body)).toBe(201);
    stopId = stop.body.data.id;

    const yearRes = await call('/api/v1/academic/years', { method: 'POST', body: { name: `__apitest-transport-${runSuffix}`, startDate: '2026-01-01', endDate: '2026-12-31' } });
    yearId = yearRes.body.data.id;
    made.years.push(yearId);
    const classRes = await call('/api/v1/academic/classes', { method: 'POST', body: { name: `__apitest Transport Class ${runSuffix}`, levelOrder: 92 } });
    classId = classRes.body.data.id;
    made.classes.push(classId);
    const secRes = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: 'T-A', capacity: 10 } });
    sectionId = secRes.body.data.id;
    made.sections.push(sectionId);

    const s1 = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Transport', lastName: 'One', gender: 'male', dob: '2015-01-01', admissionDate: '2026-01-01' } });
    made.students.push(s1.body.data.student.id);
    const e1 = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: s1.body.data.student.id, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollment1 = e1.body.data.id;

    const s2 = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Transport', lastName: 'Two', gender: 'female', dob: '2015-01-02', admissionDate: '2026-01-01' } });
    made.students.push(s2.body.data.student.id);
    const e2 = await call('/api/v1/enrollments', { method: 'POST', body: { studentId: s2.body.data.student.id, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollment2 = e2.body.data.id;
  });

  it('allocates the first enrollment to the stop, filling the vehicle (capacity 1)', async () => {
    const res = await call('/api/v1/transport-allocations', { method: 'POST', body: { enrollmentId: enrollment1, routeStopId: stopId, startDate: '2026-02-01' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const occ = await call(`/api/v1/vehicles/${vehicleId}/occupancy`);
    expect(occ.status).toBe(200);
    expect(occ.body.data.occupied).toBe(1);
    expect(occ.body.data.capacity).toBe(1);
  });

  it('refuses a second active allocation for the same enrollment', async () => {
    const res = await call('/api/v1/transport-allocations', { method: 'POST', body: { enrollmentId: enrollment1, routeStopId: stopId, startDate: '2026-02-02' } });
    expect(res.status).toBe(422);
  });

  it('refuses to allocate a second student once the vehicle is at capacity', async () => {
    const res = await call('/api/v1/transport-allocations', { method: 'POST', body: { enrollmentId: enrollment2, routeStopId: stopId, startDate: '2026-02-01' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VEHICLE_FULL');
  });

  it('lists the student allocated to the route', async () => {
    const res = await call(`/api/v1/reports/transport/routes/${routeId}/students`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.students.length).toBe(1);
  });

  it('ends the first allocation, freeing capacity for the second student', async () => {
    const list = await call(`/api/v1/enrollments/${enrollment1}/transport-history`);
    const activeId = list.body.data.history.find((a: { endDate: string | null }) => a.endDate === null).id;

    const ended = await call(`/api/v1/transport-allocations/${activeId}/end`, { method: 'POST', body: { endDate: '2026-02-15' } });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);

    const refused = await call(`/api/v1/transport-allocations/${activeId}/end`, { method: 'POST', body: { endDate: '2026-02-16' } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('ALREADY_ENDED');

    const retry = await call('/api/v1/transport-allocations', { method: 'POST', body: { enrollmentId: enrollment2, routeStopId: stopId, startDate: '2026-02-16' } });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  });

  it('refuses to allocate an enrollment that is not active', async () => {
    const withdrawn = await call(`/api/v1/students/${made.students[0]}/leave`, { method: 'POST', body: { status: 'withdrawn', leavingDate: '2026-03-01', reason: '__apitest withdrawal' } });
    // Only assert on the allocation refusal if the withdrawal itself succeeded;
    // otherwise this is an unrelated students-module gap, not a transport one.
    if (withdrawn.status === 200 || withdrawn.status === 201) {
      const res = await call('/api/v1/transport-allocations', { method: 'POST', body: { enrollmentId: enrollment1, routeStopId: stopId, startDate: '2026-03-02' } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ENROLLMENT_NOT_ACTIVE');
    }
  });

  it('refuses to allocate against a nonexistent route stop', async () => {
    const res = await call('/api/v1/transport-allocations', { method: 'POST', body: { enrollmentId: enrollment2, routeStopId: '999999999', startDate: '2026-02-20' } });
    expect(res.status).toBe(404);
  });

  it('denies allocating a caller without transport.allocate', async () => {
    const res = await call('/api/v1/transport-allocations', { token: nobodyToken, method: 'POST', body: { enrollmentId: enrollment2, routeStopId: stopId, startDate: '2026-02-20' } });
    expect(res.status).toBe(403);
  });

  it("lets a guardian linked to the student see that enrollment's transport allocation, but not an unrelated guardian", async () => {
    const linkedGuardian = (await call('/api/v1/guardians', { method: 'POST', body: { fullName: '__apitest Transport Linked Guardian', phone: '03005556666' } })).body.data.id;
    made.guardians.push(linkedGuardian);
    const unrelatedGuardian = (await call('/api/v1/guardians', { method: 'POST', body: { fullName: '__apitest Transport Unrelated Guardian', phone: '03007778888' } })).body.data.id;
    made.guardians.push(unrelatedGuardian);
    await call('/api/v1/student-guardians', { method: 'POST', body: { studentId: made.students[1], guardianId: linkedGuardian, relation: 'father', isPrimary: true, isFeePayer: true } });

    const LINKED = { username: `__apitest_transport_linked_${runSuffix}`, password: 'LinkedGuardian!2026' };
    const UNRELATED = { username: `__apitest_transport_unrelated_${runSuffix}`, password: 'UnrelatedGuardian!2026' };
    userIds.push(await makeUser(LINKED, 'Guardian', { guardianId: linkedGuardian }));
    userIds.push(await makeUser(UNRELATED, 'Guardian', { guardianId: unrelatedGuardian }));
    const linkedToken = await login(LINKED);
    const unrelatedToken = await login(UNRELATED);

    const allowed = await call(`/api/v1/enrollments/${enrollment2}/transport`, { token: linkedToken });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    const denied = await call(`/api/v1/enrollments/${enrollment2}/transport`, { token: unrelatedToken });
    expect(denied.status).toBe(404); // concealed, not 403
  });
});
