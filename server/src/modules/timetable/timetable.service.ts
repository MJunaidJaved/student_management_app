/**
 * Timetable and substitutions (Module 9).
 *
 * Validates what the academic module already owns (class-subject mapping,
 * subject-teacher assignment, section/room/staff existence) by calling into
 * it rather than re-deriving any of it here — this module adds scheduling on
 * top, it does not duplicate setup.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../core/errors';
import type { PermissionService } from '../../core/authz/permission-service';
import { assertYearOpen, type ClassSubjectRepository, type SectionRepository, type RoomRepository } from '../academic/academic.repository';
import { StaffRepository } from '../staff/staff.repository';
import type { NotificationService } from '../notifications/notifications.service';
import {
  PeriodRepository,
  TimetableEntryRepository,
  SubstitutionRepository,
  type PeriodRow,
  type TimetableEntryRow,
  type SubstitutionRow,
} from './timetable.repository';

export type PeriodView = { id: string; name: string; startTime: string; endTime: string; sortOrder: number };
function toPeriodView(r: PeriodRow): PeriodView {
  return { id: r.id, name: r.name, startTime: r.start_time, endTime: r.end_time, sortOrder: r.sort_order };
}

export type TimetableEntryView = {
  id: string;
  academicYearId: string;
  sectionId: string;
  dayOfWeek: number;
  periodId: string;
  subjectId: string;
  staffId: string;
  roomId: string | null;
};

function toEntryView(row: TimetableEntryRow): TimetableEntryView {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    sectionId: row.section_id,
    dayOfWeek: row.day_of_week,
    periodId: row.period_id,
    subjectId: row.subject_id,
    staffId: row.staff_id,
    roomId: row.room_id,
  };
}

/** A grid cell: the entry plus the names a timetable view displays. */
export type TimetableGridEntryView = TimetableEntryView & {
  subjectName: string;
  periodName: string;
  staffName?: string;
  sectionName?: string;
  roomName?: string | null;
};

function toGridEntryView(
  row: TimetableEntryRow & { subject_name: string; period_name: string; staff_name?: string; section_name?: string; room_name?: string | null },
): TimetableGridEntryView {
  return {
    ...toEntryView(row),
    subjectName: row.subject_name,
    periodName: row.period_name,
    ...(row.staff_name !== undefined ? { staffName: row.staff_name } : {}),
    ...(row.section_name !== undefined ? { sectionName: row.section_name } : {}),
    ...(row.room_name !== undefined ? { roomName: row.room_name } : {}),
  };
}

export type SubstitutionView = {
  id: string;
  timetableEntryId: string;
  subDate: string;
  substituteStaffId: string;
  reason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
};

function toSubstitutionView(row: SubstitutionRow): SubstitutionView {
  return {
    id: row.id,
    timetableEntryId: row.timetable_entry_id,
    subDate: row.sub_date,
    substituteStaffId: row.substitute_staff_id,
    reason: row.reason,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

/** One readable sentence per conflict, naming who or what is already busy. */
function describeConflicts(
  conflicts: { dimension: 'section' | 'staff' | 'room'; entry: TimetableEntryRow & { section_name: string; staff_name: string; subject_name: string } }[],
): string {
  return conflicts
    .map((c) => {
      if (c.dimension === 'staff') return `${c.entry.staff_name} is already teaching ${c.entry.subject_name} in ${c.entry.section_name} at that slot.`;
      if (c.dimension === 'room') return `That room is already booked for ${c.entry.subject_name} in ${c.entry.section_name} at that slot.`;
      return `Section ${c.entry.section_name} already has ${c.entry.subject_name} at that slot.`;
    })
    .join(' ');
}

export class TimetableService {
  constructor(
    private readonly periods: PeriodRepository,
    private readonly entries: TimetableEntryRepository,
    private readonly substitutions: SubstitutionRepository,
    private readonly sections: SectionRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly rooms: RoomRepository,
    private readonly staff: StaffRepository,
    private readonly permissions: PermissionService,
    private readonly notifications: NotificationService,
  ) {}

  /* ---------------- periods ---------------- */

  async listPeriods(actor: Actor): Promise<PeriodView[]> {
    return readTransaction(actor, async (uow) => (await this.periods.listAll(uow)).map(toPeriodView));
  }

  async createPeriod(actor: Actor, input: { name: string; startTime: string; endTime: string; sortOrder: number }): Promise<PeriodView> {
    return transaction(actor, async (uow) =>
      toPeriodView(await this.periods.create(uow, { name: input.name, start_time: input.startTime, end_time: input.endTime, sort_order: input.sortOrder })),
    );
  }

  async updatePeriod(actor: Actor, id: string, input: { name?: string | undefined; startTime?: string | undefined; endTime?: string | undefined; sortOrder?: number | undefined }): Promise<PeriodView> {
    return transaction(actor, async (uow) =>
      toPeriodView(await this.periods.update(uow, id, { name: input.name, start_time: input.startTime, end_time: input.endTime, sort_order: input.sortOrder })),
    );
  }

  async deletePeriod(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const counts = await this.periods.referenceCounts(uow, id);
      if (counts.entries > 0) {
        throw new BusinessRuleError(`That period still has ${counts.entries} timetable entr(y/ies). Remove them first.`, 'PERIOD_IN_USE');
      }
      await this.periods.hardDelete(uow, id);
    });
  }

  /* ---------------- validation shared by create/update/bulk-save ---------------- */

  /** Returns the section's class id, having checked everything but slot conflicts. */
  private async validateEntryReferences(
    uow: Uow,
    input: { academicYearId: string; sectionId: string; subjectId: string; staffId: string; roomId: string | null },
  ): Promise<void> {
    await assertYearOpen(uow, input.academicYearId);
    const section = await this.sections.getById(uow, input.sectionId);

    const mapped = await this.classSubjects.isMapped(uow, section.class_id, input.subjectId);
    if (!mapped) {
      throw new BusinessRuleError('That subject is not part of this class’s curriculum.', 'SUBJECT_NOT_IN_CLASS');
    }

    const assigned = await uow.maybeOne<{ ok: boolean }>(
      `SELECT true AS ok FROM subject_teachers
        WHERE academic_year_id = $1 AND section_id = $2 AND subject_id = $3 AND staff_id = $4`,
      [input.academicYearId, input.sectionId, input.subjectId, input.staffId],
    );
    if (!assigned) {
      throw new BusinessRuleError('That staff member is not assigned to teach this subject in this section.', 'TEACHER_NOT_ASSIGNED');
    }

    const staffRow = await this.staff.getById(uow, input.staffId);
    if (staffRow.status !== 'active') {
      throw new BusinessRuleError('That staff member is not currently active and cannot be scheduled.', 'STAFF_NOT_ACTIVE');
    }

    if (input.roomId) await this.rooms.getById(uow, input.roomId);
  }

  /* ---------------- entries ---------------- */

  async createEntry(
    actor: Actor,
    input: { academicYearId: string; sectionId: string; dayOfWeek: number; periodId: string; subjectId: string; staffId: string; roomId?: string | undefined },
  ): Promise<TimetableEntryView> {
    return transaction(actor, async (uow) => {
      await this.validateEntryReferences(uow, { ...input, roomId: input.roomId ?? null });
      await this.periods.getById(uow, input.periodId);

      const conflicts = await this.entries.findConflicts(uow, { ...input, roomId: input.roomId ?? null });
      if (conflicts.length > 0) {
        throw new BusinessRuleError(describeConflicts(conflicts), 'TIMETABLE_CONFLICT');
      }

      const row = await this.entries.create(uow, {
        academic_year_id: input.academicYearId,
        section_id: input.sectionId,
        day_of_week: input.dayOfWeek,
        period_id: input.periodId,
        subject_id: input.subjectId,
        staff_id: input.staffId,
        room_id: input.roomId ?? null,
      });
      return toEntryView(row);
    });
  }

  async updateEntry(
    actor: Actor,
    id: string,
    input: { subjectId?: string | undefined; staffId?: string | undefined; roomId?: string | null | undefined; dayOfWeek?: number | undefined; periodId?: string | undefined },
  ): Promise<TimetableEntryView> {
    return transaction(actor, async (uow) => {
      const existing = await this.entries.getById(uow, id);
      const merged = {
        academicYearId: existing.academic_year_id,
        sectionId: existing.section_id,
        dayOfWeek: input.dayOfWeek ?? existing.day_of_week,
        periodId: input.periodId ?? existing.period_id,
        subjectId: input.subjectId ?? existing.subject_id,
        staffId: input.staffId ?? existing.staff_id,
        roomId: input.roomId === undefined ? existing.room_id : input.roomId,
      };
      await this.validateEntryReferences(uow, merged);
      if (merged.periodId !== existing.period_id) await this.periods.getById(uow, merged.periodId);

      const conflicts = await this.entries.findConflicts(uow, merged, id);
      if (conflicts.length > 0) {
        throw new BusinessRuleError(describeConflicts(conflicts), 'TIMETABLE_CONFLICT');
      }

      const row = await this.entries.update(uow, id, {
        day_of_week: merged.dayOfWeek,
        period_id: merged.periodId,
        subject_id: merged.subjectId,
        staff_id: merged.staffId,
        room_id: merged.roomId,
      });
      return toEntryView(row);
    });
  }

  async deleteEntry(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      await this.entries.getById(uow, id);
      await uow.count(`DELETE FROM timetable_entries WHERE id = $1`, [id]);
    });
  }

  /**
   * Replace a whole section's timetable in one transaction.
   *
   * Every entry is validated — references, then no two submitted entries
   * share a (day, period), then no cross-section staff/room clash — before
   * the old timetable is deleted. If any check fails nothing is deleted, so
   * a bad batch leaves the section's existing timetable exactly as it was.
   */
  async bulkSaveSection(
    actor: Actor,
    input: {
      sectionId: string;
      academicYearId: string;
      entries: { dayOfWeek: number; periodId: string; subjectId: string; staffId: string; roomId?: string | undefined }[];
    },
  ): Promise<{ saved: number }> {
    return transaction(actor, async (uow) => {
      await assertYearOpen(uow, input.academicYearId);
      await this.sections.getById(uow, input.sectionId);

      const seenSlots = new Set<string>();
      for (const e of input.entries) {
        await this.validateEntryReferences(uow, { academicYearId: input.academicYearId, sectionId: input.sectionId, subjectId: e.subjectId, staffId: e.staffId, roomId: e.roomId ?? null });
        await this.periods.getById(uow, e.periodId);
        const slotKey = `${e.dayOfWeek}:${e.periodId}`;
        if (seenSlots.has(slotKey)) {
          throw new BusinessRuleError('Two entries in this batch target the same day and period.', 'DUPLICATE_SLOT_IN_BATCH');
        }
        seenSlots.add(slotKey);
      }

      // The old timetable is gone from here on; any conflict found below is
      // genuinely external (another section's staff or room), never this
      // section's own soon-to-be-replaced rows.
      await uow.count(`DELETE FROM timetable_entries WHERE section_id = $1 AND academic_year_id = $2`, [input.sectionId, input.academicYearId]);

      const allConflicts: string[] = [];
      for (const e of input.entries) {
        const conflicts = await this.entries.findConflicts(uow, {
          academicYearId: input.academicYearId,
          sectionId: input.sectionId,
          dayOfWeek: e.dayOfWeek,
          periodId: e.periodId,
          staffId: e.staffId,
          roomId: e.roomId ?? null,
        });
        if (conflicts.length > 0) allConflicts.push(describeConflicts(conflicts));
      }
      if (allConflicts.length > 0) {
        // Throwing rolls back the DELETE above too — the transaction is one
        // unit, so the section's prior timetable is left exactly as it was.
        throw new BusinessRuleError(allConflicts.join(' '), 'TIMETABLE_CONFLICT');
      }

      const rows = await this.entries.replaceForSection(
        uow,
        input.sectionId,
        input.academicYearId,
        input.entries.map((e) => ({ day_of_week: e.dayOfWeek, period_id: e.periodId, subject_id: e.subjectId, staff_id: e.staffId, room_id: e.roomId ?? null })),
      );
      return { saved: rows.length };
    });
  }

  async getForSection(actor: Actor, sectionId: string, yearId: string) {
    return readTransaction(actor, async (uow) => {
      const permissions = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
      if (actor.userType !== 'admin' && !permissions.has('timetable.manage')) {
        if (actor.userType !== 'staff') throw new NotFoundError('Section');
        const assigned = await uow.maybeOne<{ ok: boolean }>(
          `SELECT true AS ok FROM subject_teachers st JOIN academic_years ay ON ay.id = st.academic_year_id
            WHERE st.staff_id = $1 AND st.section_id = $2 AND ay.is_current
           UNION
           SELECT true FROM sections WHERE id = $2 AND class_teacher_id = $1 AND deleted_at IS NULL`,
          [actor.staffId, sectionId],
        );
        if (!assigned) throw new NotFoundError('Section');
      }
      return (await this.entries.listForSection(uow, sectionId, yearId)).map(toGridEntryView);
    });
  }

  async getForStaff(actor: Actor, staffId: string, yearId: string) {
    return readTransaction(actor, async (uow) => {
      const permissions = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
      if (actor.userType !== 'admin' && !permissions.has('timetable.manage') && String(actor.staffId) !== staffId) {
        throw new NotFoundError('Staff');
      }
      return (await this.entries.listForStaff(uow, staffId, yearId)).map(toGridEntryView);
    });
  }

  async getForRoom(actor: Actor, roomId: string, yearId: string) {
    return readTransaction(actor, async (uow) => (await this.entries.listForRoom(uow, roomId, yearId)).map(toGridEntryView));
  }

  /* ---------------- substitutions ---------------- */

  async createSubstitution(
    actor: Actor,
    input: { timetableEntryId: string; subDate: string; substituteStaffId: string; reason?: string | undefined },
  ): Promise<SubstitutionView> {
    return transaction(actor, async (uow) => {
      const entry = await this.entries.getById(uow, input.timetableEntryId);
      if (entry.staff_id === input.substituteStaffId) {
        throw new BusinessRuleError('The substitute cannot be the same teacher who is already assigned.', 'SUBSTITUTE_IS_ORIGINAL');
      }
      const substitute = await this.staff.getById(uow, input.substituteStaffId);
      if (substitute.status !== 'active') {
        throw new BusinessRuleError('That staff member is not currently active and cannot substitute.', 'STAFF_NOT_ACTIVE');
      }

      const existing = await this.substitutions.findForEntryAndDate(uow, input.timetableEntryId, input.subDate);
      if (existing && !existing.cancelled_at) {
        throw new BusinessRuleError('A substitution already exists for this class and date.', 'SUBSTITUTION_EXISTS');
      }

      const conflicts = await this.substitutions.substituteConflicts(uow, input.substituteStaffId, input.subDate, entry.day_of_week, entry.period_id);
      if (conflicts.length > 0) {
        throw new BusinessRuleError(
          `That substitute is already committed at that time (${conflicts.map((c) => c.sectionName).join(', ')}).`,
          'SUBSTITUTE_CONFLICT',
        );
      }

      const row = existing
        ? await uow.one<SubstitutionRow>(
            `UPDATE substitutions SET substitute_staff_id = $2, reason = $3, cancelled_at = NULL, cancelled_by = NULL WHERE id = $1 RETURNING *`,
            [existing.id, input.substituteStaffId, input.reason ?? null],
          )
        : await this.substitutions.create(uow, {
            timetable_entry_id: input.timetableEntryId,
            sub_date: input.subDate,
            substitute_staff_id: input.substituteStaffId,
            reason: input.reason ?? null,
          });

      const recipient = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE staff_id = $1`, [input.substituteStaffId]);
      await this.notifications.notify(uow, {
        title: 'Substitution assigned',
        body: `You are covering a class on ${input.subDate}.`,
        targetType: 'staff',
        targetId: input.substituteStaffId,
        createdBy: actor.userId === null ? null : String(actor.userId),
        recipients: recipient ? [{ userId: recipient.id }] : [],
      });

      return toSubstitutionView(row);
    });
  }

  async cancelSubstitution(actor: Actor, id: string): Promise<SubstitutionView> {
    return transaction(actor, async (uow) => {
      const row = await this.substitutions.getById(uow, id);
      if (row.cancelled_at) {
        throw new BusinessRuleError('That substitution is already cancelled.', 'SUBSTITUTION_ALREADY_CANCELLED');
      }
      if (actor.userId === null) throw new ForbiddenError('Sign in to continue.');
      const updated = await this.substitutions.cancel(uow, id, String(actor.userId));
      return toSubstitutionView(updated);
    });
  }

  async getDailySubstitutions(actor: Actor, date: string) {
    return readTransaction(actor, async (uow) => {
      const rows = await this.substitutions.listForDate(uow, date);
      return rows.map((r) => ({
        id: r.id,
        timetableEntryId: r.timetable_entry_id,
        subDate: r.sub_date,
        sectionName: r.section_name,
        subjectName: r.subject_name,
        periodName: r.period_name,
        originalStaffName: r.original_staff_name,
        substituteName: r.substitute_name,
        reason: r.reason,
        cancelledAt: r.cancelled_at,
      }));
    });
  }

  async getSubstitutionsForStaff(actor: Actor, staffId: string, page: { limit: number; cursor?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      const permissions = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
      if (actor.userType !== 'admin' && !permissions.has('substitutions.manage') && String(actor.staffId) !== staffId) {
        throw new NotFoundError('Staff');
      }
      let cursorDate: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorDate = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.substitutions.listForStaff(uow, staffId, { limit: page.limit, cursorDate, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({ ...toSubstitutionView(r), sectionName: r.section_name, subjectName: r.subject_name })),
        hasMore,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.sub_date, i: last.id }), 'utf8').toString('base64url') : null,
      };
    });
  }
}
