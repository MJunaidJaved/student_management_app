/**
 * Staff and HR (Module 7).
 *
 * Deliberately narrow for this phase: records, departments, designations,
 * search, and the resigned/terminated lifecycle. Contracts, documents, leave
 * balances, self-service and workload views are out of scope and are not
 * touched here (see the phase scope note in the project's working notes).
 *
 * `deactivate` records a separation date and an optional reason on `staff`
 * itself (migration 009 — `staff` had neither column, which is why this was
 * not built the first time around). The status change, and both new columns,
 * are also captured by the existing `trg_audit_staff` trigger.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ConflictError } from '../../core/errors';
import { enforce, type PolicyContext, type StaffPolicy } from '../../core/policy/policy';
import type { PermissionService } from '../../core/authz/permission-service';
import { classifySearchTerm } from '../../core/search/search-expressions';
import {
  DepartmentRepository,
  DesignationRepository,
  StaffRepository,
  type DepartmentRow,
  type DesignationRow,
  type StaffRow,
} from './staff.repository';

export type DesignationView = { id: string; name: string; departmentId: string | null };
const toDesignationView = (r: DesignationRow): DesignationView => ({ id: r.id, name: r.name, departmentId: r.department_id });

export type StaffView = {
  id: string;
  employeeNo: string;
  fullName: string;
  gender: string;
  dob: string;
  phone: string;
  email: string | null;
  address: string | null;
  departmentId: string | null;
  designationId: string | null;
  joinDate: string;
  status: string;
  photoPath: string | null;
  /** Masked unless the caller may see sensitive staff fields (Part 7.2). */
  nationalId: string | null;
  separationDate: string | null;
  separationReason: string | null;
};

function toStaffView(row: StaffRow, showSensitive: boolean): StaffView {
  return {
    id: row.id,
    employeeNo: row.employee_no,
    fullName: row.full_name,
    gender: row.gender,
    dob: row.dob,
    phone: row.phone,
    email: row.email,
    address: row.address,
    departmentId: row.department_id,
    designationId: row.designation_id,
    joinDate: row.join_date,
    status: row.status,
    photoPath: row.photo_path,
    nationalId:
      row.national_id === null
        ? null
        : showSensitive
          ? row.national_id
          : `••••${row.national_id.slice(-4)}`,
    separationDate: row.separation_date,
    separationReason: row.separation_reason,
  };
}

export class StaffService {
  constructor(
    private readonly staff: StaffRepository,
    private readonly departments: DepartmentRepository,
    private readonly designations: DesignationRepository,
    private readonly policy: StaffPolicy,
    private readonly permissions: PermissionService,
  ) {}

  private async context(uow: Uow, actor: Actor): Promise<PolicyContext> {
    const permissions =
      actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
    return { actor, uow, permissions };
  }

  /* ---------------- departments ---------------- */

  async listDepartments(actor: Actor): Promise<DepartmentRow[]> {
    return readTransaction(actor, (uow) => this.departments.listAll(uow));
  }

  async createDepartment(actor: Actor, name: string): Promise<DepartmentRow> {
    return transaction(actor, (uow) => this.departments.create(uow, { name }));
  }

  async updateDepartment(actor: Actor, id: string, name: string): Promise<DepartmentRow> {
    return transaction(actor, (uow) => this.departments.update(uow, id, { name }));
  }

  async deleteDepartment(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const counts = await this.departments.referenceCounts(uow, id);
      if (counts.staff > 0 || counts.designations > 0) {
        throw new BusinessRuleError(
          `That department still has ${counts.staff} staff member(s) and ` +
            `${counts.designations} designation(s). Reassign them first.`,
          'DEPARTMENT_IN_USE',
        );
      }
      await this.departments.hardDelete(uow, id);
    });
  }

  /* ---------------- designations ---------------- */

  async listDesignations(actor: Actor): Promise<DesignationView[]> {
    return readTransaction(actor, async (uow) => (await this.designations.listAll(uow)).map(toDesignationView));
  }

  async createDesignation(
    actor: Actor,
    input: { name: string; departmentId?: string | null | undefined },
  ): Promise<DesignationView> {
    return transaction(actor, async (uow) =>
      toDesignationView(await this.designations.create(uow, { name: input.name, department_id: input.departmentId ?? null })),
    );
  }

  async updateDesignation(
    actor: Actor,
    id: string,
    input: { name?: string | undefined; departmentId?: string | null | undefined },
  ): Promise<DesignationView> {
    return transaction(actor, async (uow) =>
      toDesignationView(await this.designations.update(uow, id, { name: input.name, department_id: input.departmentId })),
    );
  }

  async deleteDesignation(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const counts = await this.designations.referenceCounts(uow, id);
      if (counts.staff > 0) {
        throw new BusinessRuleError(
          `That designation still has ${counts.staff} staff member(s). Reassign them first.`,
          'DESIGNATION_IN_USE',
        );
      }
      await this.designations.hardDelete(uow, id);
    });
  }

  /* ---------------- staff ---------------- */

  async getById(actor: Actor, id: string): Promise<StaffView> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canView(ctx, id), 'Staff');

      const row = await this.staff.getById(uow, id);
      const sensitive = await this.policy.canViewSensitive(ctx, id);
      return toStaffView(row, sensitive.allowed);
    });
  }

  async list(
    actor: Actor,
    filters: {
      departmentId?: string | undefined;
      designationId?: string | undefined;
      status?: string | undefined;
      gender?: string | undefined;
    },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: unknown[]; nextCursor: string | null; hasMore: boolean }> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      // Listing is always the HR-wide view; a route with no declared
      // permission cannot be reached (Part 7.1), so reaching here already
      // means the caller holds staff.read.
      void ctx;

      let cursorCreatedAt: string | undefined;
      let cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as {
          v: string;
          i: string;
        };
        cursorCreatedAt = decoded.v;
        cursorId = decoded.i;
      }

      const rows = await this.staff.listFiltered(uow, filters, {
        limit: page.limit,
        cursorCreatedAt,
        cursorId,
      });

      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];

      return {
        items: items.map((r) => ({
          ...toStaffView(r, false),
          departmentName: r.department_name,
          designationName: r.designation_name,
        })),
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({ k: 'created_at', v: last.created_at, i: last.id }),
                'utf8',
              ).toString('base64url')
            : null,
      };
    });
  }

  /** Unified search: employee number, phone, national ID, then name (Part 9.1). */
  async search(
    actor: Actor,
    term: string,
    options: { limit: number; typeahead?: boolean },
  ): Promise<{ kind: string; staff: unknown[] }> {
    return readTransaction(actor, async (uow) => {
      const kind = classifySearchTerm(term);

      switch (kind) {
        case 'admission_no': {
          // The same shape as an employee number (letters/digits with a
          // separator); classifySearchTerm names it generically.
          const row = await this.staff.findByEmployeeNo(uow, term.trim());
          return { kind: 'employee_no', staff: row ? [minimal(row)] : [] };
        }
        case 'national_id': {
          const row = await this.staff.findByNationalId(uow, term.replace(/\D/g, ''));
          return { kind, staff: row ? [minimal(row)] : [] };
        }
        case 'phone': {
          const rows = await this.staff.findByPhone(uow, term.replace(/[\s()-]/g, ''));
          return { kind, staff: rows.map(minimal) };
        }
        default: {
          const rows = await this.staff.searchByName(uow, term, {
            limit: options.limit,
            prefixOnly: options.typeahead ?? false,
          });
          return { kind, staff: rows };
        }
      }
    });
  }

  async create(
    actor: Actor,
    input: {
      fullName: string;
      gender: string;
      dob: string;
      phone: string;
      joinDate: string;
      nationalId?: string | null | undefined;
      email?: string | null | undefined;
      address?: string | null | undefined;
      departmentId?: string | null | undefined;
      designationId?: string | null | undefined;
    },
  ): Promise<StaffView> {
    return transaction(actor, async (uow) => {
      if (input.nationalId) {
        const existing = await this.staff.findByNationalId(uow, input.nationalId);
        if (existing) {
          throw new ConflictError(
            `A staff member with that national ID already exists (${existing.full_name}).`,
            'STAFF_EXISTS',
          );
        }
      }
      if (input.departmentId) await assertDepartmentExists(uow, this.departments, input.departmentId);
      if (input.designationId) await assertDesignationExists(uow, this.designations, input.designationId);

      const row = await this.staff.create(uow, {
        full_name: input.fullName,
        gender: input.gender,
        dob: input.dob,
        national_id: input.nationalId ?? null,
        phone: input.phone,
        email: input.email ?? null,
        address: input.address ?? null,
        department_id: input.departmentId ?? null,
        designation_id: input.designationId ?? null,
        join_date: input.joinDate,
      });
      return toStaffView(row, true);
    });
  }

  async update(actor: Actor, id: string, input: Record<string, unknown>): Promise<StaffView> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canView(ctx, id), 'Staff');

      if (input.departmentId) {
        await assertDepartmentExists(uow, this.departments, input.departmentId as string);
      }
      if (input.designationId) {
        await assertDesignationExists(uow, this.designations, input.designationId as string);
      }

      const row = await this.staff.update(uow, id, {
        full_name: input.fullName,
        gender: input.gender,
        dob: input.dob,
        national_id: input.nationalId,
        phone: input.phone,
        email: input.email,
        address: input.address,
        department_id: input.departmentId,
        designation_id: input.designationId,
      });
      return toStaffView(row, true);
    });
  }

  /**
   * Record a resignation or termination.
   *
   * Blocks further status changes once the staff member has left, and
   * disables the linked user account (if one exists) while keeping it and
   * every historical record intact — only `is_active` changes.
   */
  async deactivate(
    actor: Actor,
    id: string,
    input: { status: 'resigned' | 'terminated'; separationDate: string; reason?: string | undefined },
  ): Promise<StaffView> {
    return transaction(actor, async (uow) => {
      const current = await this.staff.getById(uow, id);
      if (current.status !== 'active') {
        throw new BusinessRuleError(
          `This staff member is already ${current.status}.`,
          'STAFF_NOT_ACTIVE',
        );
      }

      await this.staff.separate(uow, id, input.status, input.separationDate, input.reason ?? null);
      await uow.count(`UPDATE users SET is_active = false WHERE staff_id = $1`, [id]);

      const row = await this.staff.getById(uow, id);
      return toStaffView(row, true);
    });
  }

  /** Soft delete, refused if any history exists (mirrors students). */
  async softDelete(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      await this.staff.getById(uow, id);
      const history = await this.staff.historyCounts(uow, id);
      const total = history.contracts + history.attendance + history.assignments + history.payslips;
      if (total > 0) {
        throw new BusinessRuleError(
          `This staff member has history (${history.assignments} teaching assignment(s), ` +
            `${history.contracts} contract(s), ${history.attendance} attendance record(s), ` +
            `${history.payslips} payslip(s)) and cannot be deleted. Deactivate instead.`,
          'STAFF_HAS_HISTORY',
        );
      }
      await this.staff.softDelete(uow, id);
    });
  }
}

async function assertDepartmentExists(
  uow: Uow,
  departments: DepartmentRepository,
  id: string,
): Promise<void> {
  await departments.getById(uow, id);
}

async function assertDesignationExists(
  uow: Uow,
  designations: DesignationRepository,
  id: string,
): Promise<void> {
  await designations.getById(uow, id);
}

function minimal(
  row: StaffRow,
): { id: string; employee_no: string; full_name: string; status: string } {
  return { id: row.id, employee_no: row.employee_no, full_name: row.full_name, status: row.status };
}
