/**
 * API tests for library circulation (Section 5, Module 12).
 *
 * Runs against the real database, including borrower-ownership checks: a
 * guardian linked to the borrowing student can see the issue, an unrelated
 * guardian cannot (404, matching the project's "conceal, don't 403" rule for
 * out-of-scope records — see students.api.test.ts's own version of this).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_library__', password: 'LibraryPassw0rd!2026' };
const NOBODY = { username: '__apitest_library_nobody__', password: 'LibraryPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let nobodyToken: string;
const userIds: string[] = [];
const made = { students: [] as string[], guardians: [] as string[] };
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

async function makeStudent(firstName: string): Promise<string> {
  const res = await call('/api/v1/students', { method: 'POST', body: { firstName, lastName: '__apitest', gender: 'male', dob: '2015-01-01', admissionDate: '2026-01-01' } });
  const id = res.body.data.student.id;
  made.students.push(id);
  return id;
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
      await uow.count(`DELETE FROM library_fines WHERE book_issue_id IN (SELECT id FROM book_issues WHERE student_id = $1)`, [id]);
      await uow.count(`DELETE FROM book_issues WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_guardians WHERE student_id = $1`, [id]);
      await uow.count(`DELETE FROM student_enrollments WHERE student_id = $1`, [id]);
    }
    for (const id of made.students) await uow.count(`DELETE FROM students WHERE id = $1`, [id]);
    for (const id of userIds) {
      await uow.count(`UPDATE users SET is_active = false WHERE id = $1`, [id]);
      await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
    }
    // Guardian-type users' guardian_id cannot be nulled (users_check), so it
    // is left as-is — same reasoning as exams.api.test.ts's 'Exam Guardian'.
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('Library API', () => {
  let categoryId: string;
  let bookId: string; // one copy, for availability tests
  let student1: string;
  let student2: string;
  let student3: string;
  let issue1: string;

  it('denies catalog reads to a caller without library.read', async () => {
    const res = await call('/api/v1/books', { token: nobodyToken });
    expect(res.status).toBe(403);
  });

  it('creates a category and a single-copy book', async () => {
    const cat = await call('/api/v1/book-categories', { method: 'POST', body: { name: `__apitest Fiction ${runSuffix}` } });
    expect(cat.status, JSON.stringify(cat.body)).toBe(201);
    categoryId = cat.body.data.id;

    const book = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC-${runSuffix}`, title: '__apitest Book One', categoryId, copiesTotal: 1 } });
    expect(book.status, JSON.stringify(book.body)).toBe(201);
    bookId = book.body.data.id;

    student1 = await makeStudent('LibOne');
    student2 = await makeStudent('LibTwo');
    student3 = await makeStudent('LibThree');
  });

  it('issues the only copy to a student', async () => {
    const res = await call('/api/v1/book-issues', { method: 'POST', body: { bookId, borrowerType: 'student', borrowerId: student1 } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    issue1 = res.body.data.id;
    expect(res.body.data.status).toBe('issued');
  });

  it('refuses to issue the same book while its only copy is out', async () => {
    const res = await call('/api/v1/book-issues', { method: 'POST', body: { bookId, borrowerType: 'student', borrowerId: student2 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_COPIES_AVAILABLE');
  });

  it('refuses to return an issue that was never issued (unknown id)', async () => {
    const res = await call('/api/v1/book-issues/999999999/return', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns the book, making the copy available again', async () => {
    const res = await call(`/api/v1/book-issues/${issue1}/return`, { method: 'POST' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.issue.status).toBe('returned');
    expect(res.body.data.fine).toBeNull(); // returned same day, within grace

    const reissue = await call('/api/v1/book-issues', { method: 'POST', body: { bookId, borrowerType: 'student', borrowerId: student2 } });
    expect(reissue.status, JSON.stringify(reissue.body)).toBe(201);
    issue1 = reissue.body.data.id;
  });

  it('refuses a second return of an already-returned issue', async () => {
    const firstReturn = await call(`/api/v1/book-issues/${issue1}/return`, { method: 'POST' });
    expect(firstReturn.status).toBe(200);
    const secondReturn = await call(`/api/v1/book-issues/${issue1}/return`, { method: 'POST' });
    expect(secondReturn.status).toBe(422);
    expect(secondReturn.body.error.code).toBe('NOT_ISSUED');
  });

  it('enforces the per-borrower borrowing limit (library.max_books_student = 2)', async () => {
    const book2 = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC2-${runSuffix}`, title: '__apitest Book Two', categoryId, copiesTotal: 5 } });
    const book3 = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC3-${runSuffix}`, title: '__apitest Book Three', categoryId, copiesTotal: 5 } });
    const book4 = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC4-${runSuffix}`, title: '__apitest Book Four', categoryId, copiesTotal: 5 } });

    const i1 = await call('/api/v1/book-issues', { method: 'POST', body: { bookId: book2.body.data.id, borrowerType: 'student', borrowerId: student3 } });
    expect(i1.status, JSON.stringify(i1.body)).toBe(201);
    const i2 = await call('/api/v1/book-issues', { method: 'POST', body: { bookId: book3.body.data.id, borrowerType: 'student', borrowerId: student3 } });
    expect(i2.status, JSON.stringify(i2.body)).toBe(201);
    const i3 = await call('/api/v1/book-issues', { method: 'POST', body: { bookId: book4.body.data.id, borrowerType: 'student', borrowerId: student3 } });
    expect(i3.status).toBe(422);
    expect(i3.body.error.code).toBe('BORROWING_LIMIT_REACHED');
  });

  it('renews a currently-issued, non-overdue book and increments its renewal count', async () => {
    const book = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC-RENEW-${runSuffix}`, title: '__apitest Renewable Book', categoryId, copiesTotal: 1 } });
    const issue = await call('/api/v1/book-issues', { method: 'POST', body: { bookId: book.body.data.id, borrowerType: 'student', borrowerId: student1 } });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);

    const res = await call(`/api/v1/book-issues/${issue.body.data.id}/renew`, { method: 'POST' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.renewalCount).toBe(1);
  });

  it('marks a book lost and creates a fine for the replacement cost', async () => {
    const book = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC-LOST-${runSuffix}`, title: '__apitest Lost Book', categoryId, copiesTotal: 1 } });
    const issue = await call('/api/v1/book-issues', { method: 'POST', body: { bookId: book.body.data.id, borrowerType: 'student', borrowerId: student2 } });
    const lost = await call(`/api/v1/book-issues/${issue.body.data.id}/mark-lost`, { method: 'POST', body: { replacementCost: '25.00' } });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.data.fine.amount).toBe('25.00');
    expect(lost.body.data.fine.status).toBe('unpaid');

    // An unpaid fine blocks further borrowing for that student.
    const book2 = await call('/api/v1/books', { method: 'POST', body: { accessionNo: `__APITEST-ACC-AFTERLOST-${runSuffix}`, title: '__apitest After Lost', categoryId, copiesTotal: 5 } });
    const blocked = await call('/api/v1/book-issues', { method: 'POST', body: { bookId: book2.body.data.id, borrowerType: 'student', borrowerId: student2 } });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('HAS_UNPAID_FINE');

    const waived = await call(`/api/v1/library-fines/${lost.body.data.fine.id}/waive`, { method: 'POST', body: { reason: '__apitest waived' } });
    expect(waived.status, JSON.stringify(waived.body)).toBe(200);
    expect(waived.body.data.status).toBe('waived');
  });

  it('lets a guardian linked to the borrower see the issue history, but not an unrelated guardian', async () => {
    const linkedGuardian = (await call('/api/v1/guardians', { method: 'POST', body: { fullName: '__apitest Linked Guardian', phone: '03001112222' } })).body.data.id;
    made.guardians.push(linkedGuardian);
    const unrelatedGuardian = (await call('/api/v1/guardians', { method: 'POST', body: { fullName: '__apitest Unrelated Guardian', phone: '03003334444' } })).body.data.id;
    made.guardians.push(unrelatedGuardian);
    await call('/api/v1/student-guardians', { method: 'POST', body: { studentId: student1, guardianId: linkedGuardian, relation: 'mother', isPrimary: true, isFeePayer: true } });

    const LINKED = { username: `__apitest_lib_linked_${runSuffix}`, password: 'LinkedGuardian!2026' };
    const UNRELATED = { username: `__apitest_lib_unrelated_${runSuffix}`, password: 'UnrelatedGuardian!2026' };
    userIds.push(await makeUser(LINKED, 'Guardian', { guardianId: linkedGuardian }));
    userIds.push(await makeUser(UNRELATED, 'Guardian', { guardianId: unrelatedGuardian }));
    const linkedToken = await login(LINKED);
    const unrelatedToken = await login(UNRELATED);

    const allowed = await call(`/api/v1/borrowers/student/${student1}/book-issues`, { token: linkedToken });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    const denied = await call(`/api/v1/borrowers/student/${student1}/book-issues`, { token: unrelatedToken });
    expect(denied.status).toBe(404); // concealed, not 403 — matches the project's ownership convention
  });

  it('denies issuing a book to a caller without library.issue', async () => {
    const res = await call('/api/v1/book-issues', { token: nobodyToken, method: 'POST', body: { bookId, borrowerType: 'student', borrowerId: student1 } });
    expect(res.status).toBe(403);
  });
});
