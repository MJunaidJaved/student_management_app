import { Uow } from '../../core/db/uow';

export type StudentSummaryRow = { status: string; gender: string; count: number };
export type StaffSummaryRow = { status: string; gender: string; count: number };

export class ReportsRepository {
  async getStudentSummary(uow: Uow): Promise<StudentSummaryRow[]> {
    return uow.many<StudentSummaryRow>(`
      SELECT status, gender, COUNT(*)::int as count
      FROM students
      WHERE deleted_at IS NULL
      GROUP BY status, gender
      ORDER BY status, gender
    `);
  }

  async getStaffSummary(uow: Uow): Promise<StaffSummaryRow[]> {
    return uow.many<StaffSummaryRow>(`
      SELECT status, gender, COUNT(*)::int as count
      FROM staff
      WHERE deleted_at IS NULL
      GROUP BY status, gender
      ORDER BY status, gender
    `);
  }
}
