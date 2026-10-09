/**
 * Student promotion (Module 3's end-of-year workflow) data access.
 *
 * `student_promotions_from_enrollment_id_key` (UNIQUE) is the database's own
 * guarantee that a given enrollment is decided at most once — this layer's
 * own pre-check exists only to give a friendlier error than the raw
 * constraint violation would.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import type { SortMap } from '../../core/db/query-builder';

export type StudentPromotionRow = BaseRow & {
  from_enrollment_id: string;
  to_enrollment_id: string | null;
  action: string;
  decided_by: string | null;
  decided_on: string;
  remarks: string | null;
};

export class StudentPromotionRepository extends BaseRepository<StudentPromotionRow> {
  protected readonly table = 'student_promotions';
  protected readonly writableColumns = ['from_enrollment_id', 'to_enrollment_id', 'action', 'decided_by', 'decided_on', 'remarks'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'decided_on';
  protected readonly sortable: SortMap = { decided_on: { column: 'student_promotions.decided_on', index: 'student_promotions_pkey' } };

  async findForEnrollment(uow: Uow, fromEnrollmentId: string): Promise<StudentPromotionRow | null> {
    return uow.maybeOne<StudentPromotionRow>(`SELECT * FROM student_promotions WHERE from_enrollment_id = $1`, [fromEnrollmentId]);
  }

  async listForStudent(uow: Uow, studentId: string): Promise<StudentPromotionRow[]> {
    return uow.many<StudentPromotionRow>(
      `SELECT sp.* FROM student_promotions sp
         JOIN student_enrollments e ON e.id = sp.from_enrollment_id
        WHERE e.student_id = $1
        ORDER BY sp.decided_on DESC`,
      [studentId],
    );
  }

  /**
   * The worklist a preview shows: active enrollments in the source scope
   * that have not already been decided. Excluding already-decided
   * enrollments at the SQL level (rather than visiting and skipping them) is
   * the same approach Section 3's bulk invoice generation uses.
   */
  async enrollmentsEligibleForPromotion(
    uow: Uow,
    filters: { academicYearId: string; classId: string; sectionId?: string | undefined },
  ): Promise<{ id: string; student_id: string; section_id: string; roll_no: number; first_name: string; last_name: string | null; admission_no: string }[]> {
    const params: unknown[] = [filters.academicYearId, filters.classId];
    let sectionClause = '';
    if (filters.sectionId) { params.push(filters.sectionId); sectionClause = `AND e.section_id = $${params.length}`; }
    return uow.many(
      `SELECT e.id::text AS id, e.student_id::text AS student_id, e.section_id::text AS section_id, e.roll_no,
              s.first_name, s.last_name, s.admission_no
         FROM student_enrollments e
         JOIN students s ON s.id = e.student_id
        WHERE e.academic_year_id = $1 AND e.class_id = $2 AND e.status = 'active' ${sectionClause}
          AND NOT EXISTS (SELECT 1 FROM student_promotions sp WHERE sp.from_enrollment_id = e.id)
        ORDER BY e.roll_no`,
      params,
    );
  }
}
