/**
 * Policy-layer tests (Part 13, replacing the RLS tests).
 *
 * Row-level security is disabled by decision, so these checks are the only
 * thing standing between one family's data and another's. Part 13 says to
 * verify exactly four properties, and each has a test below:
 *
 *   1. a guardian cannot read another family's rows
 *   2. a teacher cannot act on another teacher's section
 *   3. a student cannot read another student's data
 *   4. out-of-scope records return 404, not 403
 *
 * The `Uow` is stubbed rather than seeded. The branching logic is what is under
 * test — which relationships grant access and which do not — and a stub makes
 * every case reachable, including combinations that would take a lot of fixture
 * data to construct. The SQL those branches run is covered by the integration
 * tests that use a real database.
 */

import { describe, expect, it } from 'vitest';
import {
  SectionPolicy,
  StaffPolicy,
  StudentPolicy,
  enforce,
  type PolicyContext,
} from './policy';
import { NullCacheStore } from '../cache/cache';
import { NotFoundError, ForbiddenError } from '../errors';
import type { Actor, Uow } from '../db/uow';
import type { PermissionService } from '../authz/permission-service';

/**
 * A Uow that answers from a script of canned rows.
 *
 * Keyed by a fragment of the SQL, so a test says what the database contains
 * rather than mimicking query text exactly.
 */
function stubUow(responses: Array<[match: string, rows: unknown[]]>): Uow {
  const answer = (sql: string): unknown[] => {
    for (const [match, rows] of responses) {
      if (sql.includes(match)) return rows;
    }
    return [];
  };

  return {
    many: async (sql: string) => answer(sql),
    maybeOne: async (sql: string) => answer(sql)[0] ?? null,
    one: async (sql: string) => {
      const row = answer(sql)[0];
      if (!row) throw new NotFoundError();
      return row;
    },
    count: async () => 0,
    nextSequenceValue: async () => '1',
    raw: null,
  } as unknown as Uow;
}

const permissions = {} as PermissionService;
const cache = new NullCacheStore();

function ctx(actor: Partial<Actor>, held: string[], uow: Uow): PolicyContext {
  return {
    actor: { userId: 1, userType: 'staff', ...actor } as Actor,
    uow,
    permissions: new Set(held),
  };
}

describe('enforce', () => {
  it('turns an out-of-scope result into 404, never 403', () => {
    // The central rule: a 403 on /students/812 confirms that student exists.
    expect(() => enforce({ allowed: false, reason: 'out-of-scope' }, 'Student')).toThrow(
      NotFoundError,
    );
  });

  it('turns a missing record into the identical 404', () => {
    let outOfScope: Error | null = null;
    let missing: Error | null = null;
    try {
      enforce({ allowed: false, reason: 'out-of-scope' }, 'Student');
    } catch (e) {
      outOfScope = e as Error;
    }
    try {
      enforce({ allowed: false, reason: 'not-found' }, 'Student');
    } catch (e) {
      missing = e as Error;
    }
    // Indistinguishable from outside, which is the whole point.
    expect(outOfScope!.message).toBe(missing!.message);
    expect((outOfScope as NotFoundError).code).toBe((missing as NotFoundError).code);
  });

  it('uses 403 only for a genuine permission refusal', () => {
    expect(() => enforce({ allowed: false, reason: 'forbidden' }, 'Student')).toThrow(
      ForbiddenError,
    );
  });

  it('passes an allowed result through', () => {
    expect(() => enforce({ allowed: true }, 'Student')).not.toThrow();
  });
});

describe('StudentPolicy — guardian scope', () => {
  const policy = new StudentPolicy(cache, permissions);

  /** Student 100 exists; guardian 7 is linked to students 100 and 101. */
  const uow = stubUow([
    ['FROM students WHERE id', [{ id: '100' }]],
    ['FROM student_guardians WHERE guardian_id', [{ student_id: '100' }, { student_id: '101' }]],
  ]);

  it('allows a guardian to read their own child', async () => {
    const result = await policy.canView(ctx({ userType: 'guardian', guardianId: 7 }, [], uow), '100');
    expect(result.allowed).toBe(true);
  });

  it('refuses a guardian another family’s child', async () => {
    // Student 999 exists in the database but is not linked to guardian 7.
    const other = stubUow([
      ['FROM students WHERE id', [{ id: '999' }]],
      ['FROM student_guardians WHERE guardian_id', [{ student_id: '100' }]],
    ]);
    const result = await policy.canView(
      ctx({ userType: 'guardian', guardianId: 7 }, [], other),
      '999',
    );
    expect(result).toEqual({ allowed: false, reason: 'out-of-scope' });
  });

  it('refuses a guardian with no linked children at all', async () => {
    const none = stubUow([
      ['FROM students WHERE id', [{ id: '100' }]],
      ['FROM student_guardians WHERE guardian_id', []],
    ]);
    const result = await policy.canView(ctx({ userType: 'guardian', guardianId: 7 }, [], none), '100');
    expect(result.allowed).toBe(false);
  });

  it('refuses a guardian whose token carries no guardian id', async () => {
    // A malformed or tampered token must not fall through to "allowed".
    const result = await policy.canView(
      ctx({ userType: 'guardian', guardianId: null }, [], uow),
      '100',
    );
    expect(result.allowed).toBe(false);
  });

  it('never lets a guardian edit, even their own child', async () => {
    const result = await policy.canEdit(ctx({ userType: 'guardian', guardianId: 7 }, [], uow), '100');
    expect(result.allowed).toBe(false);
  });

  it('reports a genuinely missing student as not-found', async () => {
    const empty = stubUow([['FROM students WHERE id', []]]);
    const result = await policy.canView(
      ctx({ userType: 'guardian', guardianId: 7 }, [], empty),
      '404',
    );
    expect(result).toEqual({ allowed: false, reason: 'not-found' });
  });
});

describe('StudentPolicy — student scope', () => {
  const policy = new StudentPolicy(cache, permissions);
  const uow = stubUow([['FROM students WHERE id', [{ id: '100' }]]]);

  it('allows a student to read themselves', async () => {
    const result = await policy.canView(ctx({ userType: 'student', studentId: 100 }, [], uow), '100');
    expect(result.allowed).toBe(true);
  });

  it('refuses a student another student’s record', async () => {
    const result = await policy.canView(ctx({ userType: 'student', studentId: 101 }, [], uow), '100');
    expect(result).toEqual({ allowed: false, reason: 'out-of-scope' });
  });

  it('never lets a student edit their own record', async () => {
    const result = await policy.canEdit(ctx({ userType: 'student', studentId: 100 }, [], uow), '100');
    expect(result.allowed).toBe(false);
  });
});

describe('StudentPolicy — broad permission', () => {
  const policy = new StudentPolicy(cache, permissions);
  const uow = stubUow([['FROM students WHERE id', [{ id: '999' }]]]);

  it('allows a holder of students.read_all', async () => {
    const result = await policy.canView(ctx({ userType: 'staff', staffId: 3 }, ['students.read_all'], uow), '999');
    expect(result.allowed).toBe(true);
  });

  it('allows an admin regardless of scope', async () => {
    const result = await policy.canView(ctx({ userType: 'admin' }, [], uow), '999');
    expect(result.allowed).toBe(true);
  });

  it('still 404s a missing student for an admin', async () => {
    // Existence is checked before scope, so broad rights give a true 404
    // rather than a misleading success.
    const empty = stubUow([['FROM students WHERE id', []]]);
    const result = await policy.canView(ctx({ userType: 'admin' }, [], empty), '404');
    expect(result).toEqual({ allowed: false, reason: 'not-found' });
  });
});

describe('SectionPolicy — teacher scope', () => {
  const policy = new SectionPolicy(cache, permissions);

  /** Section 5 exists; teacher 3 is assigned to sections 5 and 6. */
  const uow = stubUow([
    ['FROM sections WHERE id', [{ id: '5' }]],
    ['subject_teachers', [{ section_id: '5' }, { section_id: '6' }]],
  ]);

  it('allows a teacher to mark their own section', async () => {
    const result = await policy.canMarkAttendance(ctx({ staffId: 3 }, ['attendance.mark'], uow), '5');
    expect(result.allowed).toBe(true);
  });

  it('refuses a teacher a section that is not theirs', async () => {
    const other = stubUow([
      ['FROM sections WHERE id', [{ id: '9' }]],
      ['subject_teachers', [{ section_id: '5' }]],
    ]);
    const result = await policy.canMarkAttendance(
      ctx({ staffId: 3 }, ['attendance.mark'], other),
      '9',
    );
    expect(result).toEqual({ allowed: false, reason: 'out-of-scope' });
  });

  it('holding attendance.mark does not by itself grant another section', async () => {
    // The permission grants the action; the policy grants the scope. Conflating
    // them would let any teacher mark any section.
    const other = stubUow([
      ['FROM sections WHERE id', [{ id: '9' }]],
      ['subject_teachers', []],
    ]);
    const result = await policy.canMarkAttendance(
      ctx({ staffId: 3 }, ['attendance.mark'], other),
      '9',
    );
    expect(result.allowed).toBe(false);
  });

  it('allows any section to a holder of attendance.mark_override', async () => {
    const other = stubUow([['FROM sections WHERE id', [{ id: '9' }]]]);
    const result = await policy.canMarkAttendance(
      ctx({ staffId: 3 }, ['attendance.mark_override'], other),
      '9',
    );
    expect(result.allowed).toBe(true);
  });

  it('refuses a guardian outright', async () => {
    const result = await policy.canMarkAttendance(
      ctx({ userType: 'guardian', guardianId: 7 }, [], uow),
      '5',
    );
    expect(result.allowed).toBe(false);
  });
});

describe('StaffPolicy — own record versus HR', () => {
  const policy = new StaffPolicy(cache, permissions);
  const uow = stubUow([['FROM staff WHERE id', [{ id: '3' }]]]);

  it('allows a staff member their own record', async () => {
    const result = await policy.canView(ctx({ staffId: 3 }, [], uow), '3');
    expect(result.allowed).toBe(true);
  });

  it('refuses a staff member someone else’s record', async () => {
    const result = await policy.canView(ctx({ staffId: 4 }, [], uow), '3');
    expect(result).toEqual({ allowed: false, reason: 'out-of-scope' });
  });

  it('allows an HR permission holder any record', async () => {
    const result = await policy.canView(ctx({ staffId: 4 }, ['staff.read'], uow), '3');
    expect(result.allowed).toBe(true);
  });

  it('gates salary and national ID behind a separate permission', async () => {
    // staff.read is not enough for sensitive fields; that is the point of
    // having two codes.
    const readOnly = await policy.canViewSensitive(ctx({ staffId: 4 }, ['staff.read'], uow), '3');
    expect(readOnly.allowed).toBe(false);

    const withSensitive = await policy.canViewSensitive(
      ctx({ staffId: 4 }, ['staff.read_sensitive'], uow),
      '3',
    );
    expect(withSensitive.allowed).toBe(true);
  });

  it('lets a staff member see their own sensitive fields', async () => {
    const result = await policy.canViewSensitive(ctx({ staffId: 3 }, [], uow), '3');
    expect(result.allowed).toBe(true);
  });
});
