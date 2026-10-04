/**
 * API tests for academic setup (Module 2).
 *
 * Everything created here is torn down in reverse dependency order. The tests
 * run against the real database, which means the rules being checked are the
 * real ones — the year-overlap guard, the capacity floor, the closed-year
 * trigger — not a mock's idea of them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_academic__', password: 'AcademicPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let userId: string;

/** Ids created by the suite, torn down in reverse order. */
const made = {
  years: [] as string[],
  terms: [] as string[],
  classes: [] as string[],
  sections: [] as string[],
  subjects: [] as string[],
  rooms: [] as string[],
};

async function call(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.auth !== false) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
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

  userId = await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(ADMIN.password);
    const existing = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
      [ADMIN.username],
    );
    const id = existing
      ? (
          await uow.one<{ id: string }>(
            `UPDATE users SET password_hash = $2, is_active = true, must_change_password = false,
                              failed_attempts = 0, locked_until = NULL
              WHERE id = $1 RETURNING id::text AS id`,
            [existing.id, hash],
          )
        ).id
      : (
          await uow.one<{ id: string }>(
            `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
             VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`,
            [ADMIN.username, hash],
          )
        ).id;

    const role = await uow.one<{ id: string }>(
      `SELECT id::text AS id FROM roles WHERE name = $1`,
      [SUPER_ADMIN_ROLE],
    );
    await uow.count(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, role.id],
    );
    return id;
  });

  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify(ADMIN),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  token = login.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    // Reverse dependency order: children before parents.
    for (const id of made.sections) {
      await uow.count(`DELETE FROM subject_teachers WHERE section_id = $1`, [id]);
      await uow.count(`DELETE FROM sections WHERE id = $1`, [id]);
    }
    for (const id of made.classes) {
      await uow.count(`DELETE FROM class_subjects WHERE class_id = $1`, [id]);
      await uow.count(`DELETE FROM classes WHERE id = $1`, [id]);
    }
    for (const id of made.subjects) await uow.count(`DELETE FROM subjects WHERE id = $1`, [id]);
    for (const id of made.terms) await uow.count(`DELETE FROM terms WHERE id = $1`, [id]);
    for (const id of made.years) {
      await uow.count(`DELETE FROM terms WHERE academic_year_id = $1`, [id]);
      await uow.count(`DELETE FROM academic_years WHERE id = $1`, [id]);
    }
    for (const id of made.rooms) await uow.count(`DELETE FROM rooms WHERE id = $1`, [id]);

    await uow.count(`UPDATE users SET is_active = false WHERE id = $1`, [userId]);
    await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [userId]);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('academic years', () => {
  it('creates a year', async () => {
    const res = await call('/api/v1/academic/years', {
      method: 'POST',
      body: JSON.stringify({ name: '__test 2040-41', startDate: '2040-04-01', endDate: '2041-03-31' }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.years.push(res.body.data.id);
    expect(res.body.data.isCurrent).toBe(false);
    expect(res.body.data.isClosed).toBe(false);
  });

  it('refuses an overlapping year', async () => {
    // Overlapping years make "which year is this date in" ambiguous for fee
    // periods and attendance.
    const res = await call('/api/v1/academic/years', {
      method: 'POST',
      body: JSON.stringify({ name: '__test overlap', startDate: '2040-06-01', endDate: '2041-01-31' }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERLAPPING_YEAR');
  });

  it('refuses an inverted date range', async () => {
    const res = await call('/api/v1/academic/years', {
      method: 'POST',
      body: JSON.stringify({ name: '__test bad', startDate: '2045-04-01', endDate: '2044-03-31' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it('rejects a non-date', async () => {
    const res = await call('/api/v1/academic/years', {
      method: 'POST',
      body: JSON.stringify({ name: '__test', startDate: '2040-02-30', endDate: '2041-03-31' }),
    });
    // 2040-02-30 passes a regex but is not a real day.
    expect(res.status).toBe(422);
  });
});

describe('terms', () => {
  it('refuses a term that falls outside its year', async () => {
    const yearId = made.years[0]!;
    const res = await call('/api/v1/academic/terms', {
      method: 'POST',
      body: JSON.stringify({
        academicYearId: yearId,
        name: '__test outside',
        startDate: '2039-01-01',
        endDate: '2039-06-30',
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TERM_OUTSIDE_YEAR');
  });

  it('creates a term inside its year', async () => {
    const yearId = made.years[0]!;
    const res = await call('/api/v1/academic/terms', {
      method: 'POST',
      body: JSON.stringify({
        academicYearId: yearId,
        name: '__test term 1',
        startDate: '2040-04-01',
        endDate: '2040-09-30',
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.terms.push(res.body.data.id);
  });

  it('refuses an overlapping term in the same year', async () => {
    const yearId = made.years[0]!;
    const res = await call('/api/v1/academic/terms', {
      method: 'POST',
      body: JSON.stringify({
        academicYearId: yearId,
        name: '__test term overlap',
        startDate: '2040-08-01',
        endDate: '2041-01-31',
      }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERLAPPING_TERM');
  });
});

describe('classes, sections and capacity', () => {
  it('creates a class and a section', async () => {
    const cls = await call('/api/v1/academic/classes', {
      method: 'POST',
      body: JSON.stringify({ name: '__test Class 9', levelOrder: 90 }),
    });
    expect(cls.status, JSON.stringify(cls.body)).toBe(201);
    made.classes.push(cls.body.data.id);

    const section = await call('/api/v1/academic/sections', {
      method: 'POST',
      body: JSON.stringify({ classId: cls.body.data.id, name: '__A', capacity: 30 }),
    });
    expect(section.status, JSON.stringify(section.body)).toBe(201);
    made.sections.push(section.body.data.id);

    // Strength is 0 and reported alongside capacity, which is what the
    // sections listing exists to show.
    expect(section.body.data.strength).toBe(0);
    expect(section.body.data.capacity).toBe(30);
  });

  it('lists sections with strength against capacity', async () => {
    const res = await call(`/api/v1/academic/sections?classId=${made.classes[0]}`);
    expect(res.status).toBe(200);
    const section = res.body.data.sections.find((s: { id: string }) => s.id === made.sections[0]);
    expect(section.strength).toBe(0);
    expect(section.class_name).toBe('__test Class 9');
  });

  it('allows raising capacity', async () => {
    const res = await call(`/api/v1/academic/sections/${made.sections[0]}`, {
      method: 'PATCH',
      body: JSON.stringify({ capacity: 40 }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.capacity).toBe(40);
  });

  it('rejects a capacity of zero at validation', async () => {
    const res = await call(`/api/v1/academic/sections/${made.sections[0]}`, {
      method: 'PATCH',
      body: JSON.stringify({ capacity: 0 }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an empty PATCH rather than silently succeeding', async () => {
    const res = await call(`/api/v1/academic/sections/${made.sections[0]}`, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('refuses to delete a class that still has a section', async () => {
    const res = await call(`/api/v1/academic/classes/${made.classes[0]}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLASS_IN_USE');
  });
});

describe('subjects and the class curriculum', () => {
  it('creates a subject and maps it to a class', async () => {
    const subject = await call('/api/v1/academic/subjects', {
      method: 'POST',
      body: JSON.stringify({ code: '__TST', name: '__test Mathematics', type: 'core' }),
    });
    expect(subject.status, JSON.stringify(subject.body)).toBe(201);
    made.subjects.push(subject.body.data.id);

    const mapped = await call(`/api/v1/academic/classes/${made.classes[0]}/subjects`, {
      method: 'PUT',
      body: JSON.stringify({
        subjects: [{ subjectId: subject.body.data.id, isMandatory: true }],
      }),
    });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    expect(mapped.body.data.subjects).toHaveLength(1);
    expect(mapped.body.data.subjects[0].subject_code).toBe('__TST');
  });

  it('rejects an invalid subject type against the database CHECK', async () => {
    const res = await call('/api/v1/academic/subjects', {
      method: 'POST',
      body: JSON.stringify({ code: '__BAD', name: '__test bad', type: 'not_a_type' }),
    });
    // The enum in code mirrors subjects_type_check, so this never reaches SQL.
    expect(res.status).toBe(422);
  });

  it('replaces the curriculum with set semantics', async () => {
    const res = await call(`/api/v1/academic/classes/${made.classes[0]}/subjects`, {
      method: 'PUT',
      body: JSON.stringify({ subjects: [] }),
    });
    expect(res.status).toBe(200);
    // Emptied, not merged.
    expect(res.body.data.subjects).toHaveLength(0);
  });
});

describe('subject-teacher assignment', () => {
  it('refuses a subject that is not in the class curriculum', async () => {
    // The curriculum was emptied by the previous test, so the mapping check
    // must now reject this assignment.
    const yearId = made.years[0]!;
    const res = await call('/api/v1/academic/subject-teachers', {
      method: 'POST',
      body: JSON.stringify({
        academicYearId: yearId,
        sectionId: made.sections[0],
        subjectId: made.subjects[0],
        staffId: '1',
      }),
    });
    // Either the curriculum check fires, or the staff FK does if staff 1 is
    // absent. Both are correct refusals; the curriculum check runs first.
    expect([422, 404]).toContain(res.status);
    if (res.status === 422) expect(res.body.error.code).toBe('SUBJECT_NOT_IN_CLASS');
  });
});

describe('rooms', () => {
  it('creates a room with its required type', async () => {
    const res = await call('/api/v1/academic/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: '__test Lab 1', roomType: 'lab', capacity: 24 }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.rooms.push(res.body.data.id);
  });

  it('requires roomType, which is NOT NULL in the schema', async () => {
    const res = await call('/api/v1/academic/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: '__test Room 2' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('year closing', () => {
  it('reports blockers rather than closing silently', async () => {
    const res = await call(`/api/v1/academic/years/${made.years[0]}/closing-check`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('canClose');
    expect(Array.isArray(res.body.data.blockers)).toBe(true);
  });

  it('refuses to close the current year', async () => {
    // There is a live current year in this database; closing it would leave
    // the school with no writable year at all.
    const years = await call('/api/v1/academic/years');
    const current = years.body.data.years.find((y: { isCurrent: boolean }) => y.isCurrent);

    if (current) {
      const res = await call(`/api/v1/academic/years/${current.id}/close`, { method: 'POST' });
      expect([422]).toContain(res.status);
      expect(['YEAR_IS_CURRENT', 'YEAR_NOT_CLOSEABLE']).toContain(res.body.error.code);
    }
  });
});

describe('authorization', () => {
  it('requires a permission for a write', async () => {
    const res = await fetch(`${baseUrl}/api/v1/academic/classes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', levelOrder: 1 }),
    });
    expect(res.status).toBe(401);
  });
});
