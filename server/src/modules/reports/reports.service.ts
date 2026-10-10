import { ReportsRepository, type StaffSummaryRow, type StudentSummaryRow } from './reports.repository';
import { readTransaction, Actor } from '../../core/db/uow';

export type StudentSummaryView = { status: string; gender: string; count: number };
const toStudentSummaryView = (r: StudentSummaryRow): StudentSummaryView => ({ status: r.status, gender: r.gender, count: r.count });

export type StaffSummaryView = { status: string; gender: string; count: number };
const toStaffSummaryView = (r: StaffSummaryRow): StaffSummaryView => ({ status: r.status, gender: r.gender, count: r.count });

export class ReportsService {
  constructor(private readonly repo: ReportsRepository) {}

  async getStudentSummary(actor: Actor): Promise<{ summary: StudentSummaryView[] }> {
    return readTransaction(actor, async (uow) => ({ summary: (await this.repo.getStudentSummary(uow)).map(toStudentSummaryView) }));
  }

  async getStaffSummary(actor: Actor): Promise<{ summary: StaffSummaryView[] }> {
    return readTransaction(actor, async (uow) => ({ summary: (await this.repo.getStaffSummary(uow)).map(toStaffSummaryView) }));
  }
}
