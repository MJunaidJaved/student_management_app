/**
 * Timetable data access (Module 9): periods, timetable entries, substitutions.
 *
 * The schema already carries the final guard: three UNIQUE constraints on
 * `timetable_entries` — `(year, room, day, period)`, `(year, section, day,
 * period)`, `(year, staff, day, period)` — so a double-booking cannot commit
 * even if every check here were skipped. The queries below exist to name
 * *which* dimension clashes and with what, before the database has to say no
 * with a generic constraint-name error (Part 9.4: precise conflict messages).
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder } from '../../core/db/query-builder';
import type { SortMap } from '../../core/db/query-builder';
import { BusinessRuleError } from '../../core/errors';

/* ------------------------------------------------------------------ *
 * Periods
 * ------------------------------------------------------------------ */

export type PeriodRow = BaseRow & { name: string; start_time: string; end_time: string; sort_order: number };

export class PeriodRepository extends BaseRepository<PeriodRow> {
  protected readonly table = 'periods';
  protected readonly writableColumns = ['name', 'start_time', 'end_time', 'sort_order'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'sort_order';
  protected readonly sortable: SortMap = { sort_order: { column: 'periods.sort_order', index: 'periods_sort_order_key' } };

  async listAll(uow: Uow): Promise<PeriodRow[]> {
    return uow.many<PeriodRow>(`SELECT * FROM periods ORDER BY sort_order`);
  }

  async referenceCounts(uow: Uow, id: string): Promise<{ entries: number }> {
    return uow.one(`SELECT (SELECT count(*)::int FROM timetable_entries WHERE period_id = $1) AS entries`, [id]);
  }

  async hardDelete(uow: Uow, id: string): Promise<void> {
    const affected = await uow.count(`DELETE FROM periods WHERE id = $1`, [id]);
    if (affected === 0) throw new BusinessRuleError('Period not found.', 'NOT_FOUND');
  }
}

/* ------------------------------------------------------------------ *
 * Timetable entries
 * ------------------------------------------------------------------ */

export type TimetableEntryRow = BaseRow & {
  academic_year_id: string;
  section_id: string;
  day_of_week: number;
  period_id: string;
  subject_id: string;
  staff_id: string;
  room_id: string | null;
};

export class TimetableEntryRepository extends BaseRepository<TimetableEntryRow> {
  protected readonly table = 'timetable_entries';
  protected readonly writableColumns = [
    'academic_year_id',
    'section_id',
    'day_of_week',
    'period_id',
    'subject_id',
    'staff_id',
    'room_id',
  ] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'day_of_week';
  protected readonly sortable: SortMap = { day_of_week: { column: 'timetable_entries.day_of_week', index: 'timetable_entries_pkey' } };

  /**
   * Named conflicts for a prospective slot, across all three dimensions the
   * database itself enforces. `excludeId` lets an update check against every
   * entry except the one being edited.
   */
  async findConflicts(
    uow: Uow,
    input: { academicYearId: string; dayOfWeek: number; periodId: string; sectionId: string; staffId: string; roomId: string | null },
    excludeId?: string,
  ): Promise<{ dimension: 'section' | 'staff' | 'room'; entry: TimetableEntryRow & { section_name: string; staff_name: string; subject_name: string } }[]> {
    const rows = await uow.many<TimetableEntryRow & { section_name: string; staff_name: string; subject_name: string }>(
      `SELECT te.*, sec.name AS section_name, st.full_name AS staff_name, sub.name AS subject_name
         FROM timetable_entries te
         JOIN sections sec ON sec.id = te.section_id
         JOIN staff st     ON st.id = te.staff_id
         JOIN subjects sub ON sub.id = te.subject_id
        WHERE te.academic_year_id = $1 AND te.day_of_week = $2 AND te.period_id = $3
          AND (te.section_id = $4 OR te.staff_id = $5 OR ($6::bigint IS NOT NULL AND te.room_id = $6))
          AND ($7::bigint IS NULL OR te.id <> $7::bigint)`,
      [input.academicYearId, input.dayOfWeek, input.periodId, input.sectionId, input.staffId, input.roomId, excludeId ?? null],
    );
    return rows.map((entry) => ({
      dimension: entry.section_id === input.sectionId ? 'section' : entry.staff_id === input.staffId ? 'staff' : 'room',
      entry,
    }));
  }

  async listForSection(uow: Uow, sectionId: string, yearId: string): Promise<(TimetableEntryRow & { subject_name: string; staff_name: string; period_name: string; room_name: string | null })[]> {
    return uow.many(
      `SELECT te.*, sub.name AS subject_name, st.full_name AS staff_name, p.name AS period_name, r.name AS room_name
         FROM timetable_entries te
         JOIN subjects sub ON sub.id = te.subject_id
         JOIN staff st     ON st.id = te.staff_id
         JOIN periods p    ON p.id = te.period_id
    LEFT JOIN rooms r      ON r.id = te.room_id
        WHERE te.section_id = $1 AND te.academic_year_id = $2
        ORDER BY te.day_of_week, p.sort_order`,
      [sectionId, yearId],
    );
  }

  async listForStaff(uow: Uow, staffId: string, yearId: string): Promise<(TimetableEntryRow & { subject_name: string; section_name: string; period_name: string })[]> {
    return uow.many(
      `SELECT te.*, sub.name AS subject_name, sec.name AS section_name, p.name AS period_name
         FROM timetable_entries te
         JOIN subjects sub ON sub.id = te.subject_id
         JOIN sections sec ON sec.id = te.section_id
         JOIN periods p    ON p.id = te.period_id
        WHERE te.staff_id = $1 AND te.academic_year_id = $2
        ORDER BY te.day_of_week, p.sort_order`,
      [staffId, yearId],
    );
  }

  async listForRoom(uow: Uow, roomId: string, yearId: string): Promise<(TimetableEntryRow & { subject_name: string; section_name: string; period_name: string })[]> {
    return uow.many(
      `SELECT te.*, sub.name AS subject_name, sec.name AS section_name, p.name AS period_name
         FROM timetable_entries te
         JOIN subjects sub ON sub.id = te.subject_id
         JOIN sections sec ON sec.id = te.section_id
         JOIN periods p    ON p.id = te.period_id
        WHERE te.room_id = $1 AND te.academic_year_id = $2
        ORDER BY te.day_of_week, p.sort_order`,
      [roomId, yearId],
    );
  }

  /** The one regular entry for a (section, day, period) slot — what a substitution replaces. */
  async findBySlot(uow: Uow, sectionId: string, yearId: string, dayOfWeek: number, periodId: string): Promise<TimetableEntryRow | null> {
    return uow.maybeOne<TimetableEntryRow>(
      `SELECT * FROM timetable_entries WHERE section_id = $1 AND academic_year_id = $2 AND day_of_week = $3 AND period_id = $4`,
      [sectionId, yearId, dayOfWeek, periodId],
    );
  }

  /**
   * Replace a whole section's timetable in one transaction (Module 9: bulk
   * save). Delete-then-insert, not a diff, because the caller sends the
   * complete, intended timetable for the section — the same "set semantics"
   * the class-subject curriculum already uses in the academic module.
   */
  async replaceForSection(
    uow: Uow,
    sectionId: string,
    yearId: string,
    rows: readonly { day_of_week: number; period_id: string; subject_id: string; staff_id: string; room_id: string | null }[],
  ): Promise<TimetableEntryRow[]> {
    await uow.count(`DELETE FROM timetable_entries WHERE section_id = $1 AND academic_year_id = $2`, [sectionId, yearId]);
    if (rows.length === 0) return [];
    return this.createMany(
      uow,
      rows.map((r) => ({
        academic_year_id: yearId,
        section_id: sectionId,
        day_of_week: r.day_of_week,
        period_id: r.period_id,
        subject_id: r.subject_id,
        staff_id: r.staff_id,
        room_id: r.room_id,
      })),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Substitutions
 * ------------------------------------------------------------------ */

export type SubstitutionRow = BaseRow & {
  timetable_entry_id: string;
  sub_date: string;
  substitute_staff_id: string;
  reason: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

export class SubstitutionRepository extends BaseRepository<SubstitutionRow> {
  protected readonly table = 'substitutions';
  protected readonly writableColumns = ['timetable_entry_id', 'sub_date', 'substitute_staff_id', 'reason'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'sub_date';
  protected readonly sortable: SortMap = { sub_date: { column: 'substitutions.sub_date', index: 'substitutions_timetable_entry_id_sub_date_key' } };

  async findForEntryAndDate(uow: Uow, timetableEntryId: string, date: string): Promise<SubstitutionRow | null> {
    return uow.maybeOne<SubstitutionRow>(`SELECT * FROM substitutions WHERE timetable_entry_id = $1 AND sub_date = $2`, [timetableEntryId, date]);
  }

  /**
   * Is this staff member already committed elsewhere at this date and slot —
   * either their own regular period, or another active substitution?
   */
  async substituteConflicts(
    uow: Uow,
    substituteStaffId: string,
    date: string,
    dayOfWeek: number,
    periodId: string,
    excludeId?: string,
  ): Promise<{ kind: 'regular' | 'substitution'; sectionName: string }[]> {
    const regular = await uow.many<{ section_name: string }>(
      `SELECT sec.name AS section_name
         FROM timetable_entries te
         JOIN sections sec ON sec.id = te.section_id
        WHERE te.staff_id = $1 AND te.day_of_week = $2 AND te.period_id = $3`,
      [substituteStaffId, dayOfWeek, periodId],
    );
    const already = await uow.many<{ section_name: string }>(
      `SELECT sec.name AS section_name
         FROM substitutions s
         JOIN timetable_entries te ON te.id = s.timetable_entry_id
         JOIN sections sec ON sec.id = te.section_id
        WHERE s.substitute_staff_id = $1 AND s.sub_date = $2 AND te.day_of_week = $3 AND te.period_id = $4
          AND s.cancelled_at IS NULL
          AND ($5::bigint IS NULL OR s.id <> $5::bigint)`,
      [substituteStaffId, date, dayOfWeek, periodId, excludeId ?? null],
    );
    return [
      ...regular.map((r) => ({ kind: 'regular' as const, sectionName: r.section_name })),
      ...already.map((r) => ({ kind: 'substitution' as const, sectionName: r.section_name })),
    ];
  }

  async listForDate(uow: Uow, date: string): Promise<(SubstitutionRow & { section_name: string; subject_name: string; period_name: string; original_staff_name: string; substitute_name: string })[]> {
    return uow.many(
      `SELECT s.*, sec.name AS section_name, sub.name AS subject_name, p.name AS period_name,
              orig.full_name AS original_staff_name, repl.full_name AS substitute_name
         FROM substitutions s
         JOIN timetable_entries te ON te.id = s.timetable_entry_id
         JOIN sections sec ON sec.id = te.section_id
         JOIN subjects sub ON sub.id = te.subject_id
         JOIN periods p    ON p.id = te.period_id
         JOIN staff orig   ON orig.id = te.staff_id
         JOIN staff repl   ON repl.id = s.substitute_staff_id
        WHERE s.sub_date = $1
        ORDER BY p.sort_order`,
      [date],
    );
  }

  async listForStaff(
    uow: Uow,
    staffId: string,
    page: { limit: number; cursorDate?: string | undefined; cursorId?: string | undefined },
  ): Promise<(SubstitutionRow & { section_name: string; subject_name: string })[]> {
    const where = new ConditionBuilder();
    where.add('s.substitute_staff_id = ?', staffId);
    if (page.cursorDate && page.cursorId) {
      where.add('(s.sub_date, s.id) < (?::date, ?::bigint)', page.cursorDate, page.cursorId);
    }
    return uow.many(
      `SELECT s.*, sec.name AS section_name, sub.name AS subject_name
         FROM substitutions s
         JOIN timetable_entries te ON te.id = s.timetable_entry_id
         JOIN sections sec ON sec.id = te.section_id
         JOIN subjects sub ON sub.id = te.subject_id
        ${where.where()}
        ORDER BY s.sub_date DESC, s.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  async cancel(uow: Uow, id: string, cancelledBy: string): Promise<SubstitutionRow> {
    return uow.one<SubstitutionRow>(
      `UPDATE substitutions SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL RETURNING *`,
      [id, cancelledBy],
      'Substitution',
    );
  }
}
