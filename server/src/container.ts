import { ReportsRepository } from './modules/reports/reports.repository';
import { ReportsService } from './modules/reports/reports.service';
/**
 * The composition root (Part 4.4).
 *
 * Everything is constructed here and passed down through constructors. No
 * module imports a singleton of anything stateful, which is what lets a test
 * build the same graph with a null cache and a null rate limiter rather than
 * reaching into module internals to reset them.
 */

import {
  InProcessCacheStore,
  NullCacheStore,
  type CacheStore,
} from './core/cache/cache';
import {
  InProcessRateLimiterStore,
  NullRateLimiterStore,
  type RateLimiterStore,
} from './core/rate-limit/rate-limiter';
import { InProcessTokenDenylist, type TokenDenylistStore } from './core/auth/token-denylist';
import { PermissionService } from './core/authz/permission-service';
import { SectionPolicy, StaffPolicy, StudentPolicy, UserPolicy } from './core/policy/policy';
import { AuthRepository } from './modules/auth/auth.repository';
import { AuthService } from './modules/auth/auth.service';
import { RolesRepository } from './modules/roles/roles.repository';
import { RolesService } from './modules/roles/roles.service';
import { SettingsService } from './modules/settings/settings.service';
import { AuditService } from './modules/audit/audit.service';
import {
  AcademicYearRepository,
  ClassRepository,
  ClassSubjectRepository,
  RoomRepository,
  SectionRepository,
  SubjectRepository,
  SubjectTeacherRepository,
  TermRepository,
} from './modules/academic/academic.repository';
import { AcademicService } from './modules/academic/academic.service';
import {
  AdmissionApplicationRepository,
  EnrollmentRepository,
  GuardianRepository,
  StudentRepository,
} from './modules/students/students.repository';
import { StudentsService } from './modules/students/students.service';
import {
  DepartmentRepository,
  DesignationRepository,
  StaffRepository,
} from './modules/staff/staff.repository';
import { StaffService } from './modules/staff/staff.service';
import { StudentAttendanceRepository, StaffAttendanceRepository } from './modules/attendance/attendance.repository';
import { AttendanceService } from './modules/attendance/attendance.service';
import { LeaveTypeRepository, LeaveRequestRepository, StaffLeaveBalanceRepository } from './modules/leave/leave.repository';
import { LeaveService } from './modules/leave/leave.service';
import { PeriodRepository, TimetableEntryRepository, SubstitutionRepository } from './modules/timetable/timetable.repository';
import { TimetableService } from './modules/timetable/timetable.service';
import { NotificationRepository, NotificationLogRepository } from './modules/notifications/notifications.repository';
import { NotificationService } from './modules/notifications/notifications.service';
import {
  FeeCategoryRepository,
  FeeStructureRepository,
  DiscountRepository,
  StudentDiscountRepository,
  FeeInvoiceRepository,
  FeeInvoiceItemRepository,
  PaymentRepository,
  PaymentAllocationRepository,
} from './modules/fees/fees.repository';
import { FeesService } from './modules/fees/fees.service';
import {
  AccountHeadRepository,
  BankAccountRepository,
  VoucherRepository,
  VoucherEntryRepository,
} from './modules/accounting/accounting.repository';
import { AccountingService } from './modules/accounting/accounting.service';
import {
  ExamTypeRepository,
  ExamRepository,
  ExamScheduleRepository,
  MarkRepository,
  GradingScaleRepository,
  GradingScaleRangeRepository,
  ReportCardRepository,
} from './modules/exams/exams.repository';
import { ExamsService } from './modules/exams/exams.service';
import { StudentPromotionRepository } from './modules/promotions/promotions.repository';
import { PromotionsService } from './modules/promotions/promotions.service';
import {
  SalaryComponentRepository,
  SalaryStructureRepository,
  StaffSalaryRepository,
  PayrollRunRepository,
  PayslipRepository,
  PayslipItemRepository,
} from './modules/payroll/payroll.repository';
import { PayrollService } from './modules/payroll/payroll.service';
import {
  ItemCategoryRepository,
  ItemRepository,
  ItemStockRepository,
  StockMovementRepository,
  SupplierRepository,
  PurchaseOrderRepository,
  PurchaseOrderItemRepository,
} from './modules/inventory/inventory.repository';
import { InventoryService } from './modules/inventory/inventory.service';

export type Container = {
  cache: CacheStore;
  rateLimiter: RateLimiterStore;
  denylist: TokenDenylistStore;
  permissions: PermissionService;
  policies: {
    student: StudentPolicy;
    section: SectionPolicy;
    staff: StaffPolicy;
    user: UserPolicy;
  };
  repositories: {
    auth: AuthRepository;
    roles: RolesRepository;
    sections: SectionRepository;
    students: StudentRepository;
    guardians: GuardianRepository;
    enrollments: EnrollmentRepository;
    applications: AdmissionApplicationRepository;
    departments: DepartmentRepository;
    designations: DesignationRepository;
    staff: StaffRepository;
    studentAttendance: StudentAttendanceRepository;
    staffAttendance: StaffAttendanceRepository;
    leaveTypes: LeaveTypeRepository;
    leaveRequests: LeaveRequestRepository;
    staffLeaveBalances: StaffLeaveBalanceRepository;
    periods: PeriodRepository;
    timetableEntries: TimetableEntryRepository;
    substitutions: SubstitutionRepository;
    notifications: NotificationRepository;
    notificationLogs: NotificationLogRepository;
    feeCategories: FeeCategoryRepository;
    feeStructures: FeeStructureRepository;
    discounts: DiscountRepository;
    studentDiscounts: StudentDiscountRepository;
    feeInvoices: FeeInvoiceRepository;
    feeInvoiceItems: FeeInvoiceItemRepository;
    payments: PaymentRepository;
    paymentAllocations: PaymentAllocationRepository;
    accountHeads: AccountHeadRepository;
    bankAccounts: BankAccountRepository;
    vouchers: VoucherRepository;
    voucherEntries: VoucherEntryRepository;
    examTypes: ExamTypeRepository;
    exams: ExamRepository;
    examSchedules: ExamScheduleRepository;
    marks: MarkRepository;
    gradingScales: GradingScaleRepository;
    gradingScaleRanges: GradingScaleRangeRepository;
    reportCards: ReportCardRepository;
    studentPromotions: StudentPromotionRepository;
    salaryComponents: SalaryComponentRepository;
    salaryStructures: SalaryStructureRepository;
    staffSalaries: StaffSalaryRepository;
    payrollRuns: PayrollRunRepository;
    payslips: PayslipRepository;
    payslipItems: PayslipItemRepository;
    itemCategories: ItemCategoryRepository;
    items: ItemRepository;
    itemStock: ItemStockRepository;
    suppliers: SupplierRepository;
    purchaseOrders: PurchaseOrderRepository;
    purchaseOrderItems: PurchaseOrderItemRepository;
    stockMovements: StockMovementRepository;
    reports: ReportsRepository;
  };
  services: {
    auth: AuthService;
    roles: RolesService;
    settings: SettingsService;
    audit: AuditService;
    academic: AcademicService;
    students: StudentsService;
    staff: StaffService;
    attendance: AttendanceService;
    leave: LeaveService;
    timetable: TimetableService;
    notifications: NotificationService;
    fees: FeesService;
    exams: ExamsService;
    promotions: PromotionsService;
    payroll: PayrollService;
    accounting: AccountingService;
    inventory: InventoryService;
    reports: ReportsService;
  };
};

export type ContainerOptions = {
  /**
   * Disable the cache and rate limiter.
   *
   * Tests want both off: a cached permission set leaking between cases looks
   * like an authorization bug, and a tripped rate limiter looks like a logic
   * bug. Neither is what the test is checking.
   */
  forTests?: boolean;
  /**
   * Override the cache implementation independent of `forTests`. For a test
   * that exercises cache-backed behaviour directly (payment idempotency is
   * the one case so far) while still wanting the rate limiter off.
   */
  cache?: CacheStore;
};

export function buildContainer(options: ContainerOptions = {}): Container {
  const cache: CacheStore = options.cache ?? (options.forTests ? new NullCacheStore() : new InProcessCacheStore());
  const rateLimiter: RateLimiterStore = options.forTests
    ? new NullRateLimiterStore()
    : new InProcessRateLimiterStore();

  const denylist = new InProcessTokenDenylist();
  const permissions = new PermissionService(cache);

  const authRepository = new AuthRepository();
  const rolesRepository = new RolesRepository();

  const academicYears = new AcademicYearRepository();
  const terms = new TermRepository();
  const classes = new ClassRepository();
  const sections = new SectionRepository();
  const subjects = new SubjectRepository();
  const classSubjects = new ClassSubjectRepository();
  const subjectTeachers = new SubjectTeacherRepository();
  const rooms = new RoomRepository();

  const studentsRepo = new StudentRepository();
  const guardiansRepo = new GuardianRepository();
  const enrollmentsRepo = new EnrollmentRepository();
  const applicationsRepo = new AdmissionApplicationRepository();

  const departmentsRepo = new DepartmentRepository();
  const designationsRepo = new DesignationRepository();
  const staffRepo = new StaffRepository();
  const studentAttendanceRepo = new StudentAttendanceRepository();
  const staffAttendanceRepo = new StaffAttendanceRepository();
  const leaveTypesRepo = new LeaveTypeRepository();
  const leaveRequestsRepo = new LeaveRequestRepository();
  const staffLeaveBalancesRepo = new StaffLeaveBalanceRepository();
  const periodsRepo = new PeriodRepository();
  const timetableEntriesRepo = new TimetableEntryRepository();
  const substitutionsRepo = new SubstitutionRepository();
  const notificationsRepo = new NotificationRepository();
  const notificationLogsRepo = new NotificationLogRepository();
  const notificationService = new NotificationService(notificationsRepo, notificationLogsRepo);

  const feeCategoriesRepo = new FeeCategoryRepository();
  const feeStructuresRepo = new FeeStructureRepository();
  const discountsRepo = new DiscountRepository();
  const studentDiscountsRepo = new StudentDiscountRepository();
  const feeInvoicesRepo = new FeeInvoiceRepository();
  const feeInvoiceItemsRepo = new FeeInvoiceItemRepository();
  const paymentsRepo = new PaymentRepository();
  const paymentAllocationsRepo = new PaymentAllocationRepository();
  const accountHeadsRepo = new AccountHeadRepository();
  const bankAccountsRepo = new BankAccountRepository();
  const vouchersRepo = new VoucherRepository();
  const voucherEntriesRepo = new VoucherEntryRepository();
  const accountingService = new AccountingService(accountHeadsRepo, bankAccountsRepo, vouchersRepo, voucherEntriesRepo);

  const examTypesRepo = new ExamTypeRepository();
  const examsRepo = new ExamRepository();
  const examSchedulesRepo = new ExamScheduleRepository();
  const marksRepo = new MarkRepository();
  const gradingScalesRepo = new GradingScaleRepository();
  const gradingScaleRangesRepo = new GradingScaleRangeRepository();
  const reportCardsRepo = new ReportCardRepository();
  const studentPromotionsRepo = new StudentPromotionRepository();
  const salaryComponentsRepo = new SalaryComponentRepository();
  const salaryStructuresRepo = new SalaryStructureRepository();
  const staffSalariesRepo = new StaffSalaryRepository();
  const payrollRunsRepo = new PayrollRunRepository();
  const payslipsRepo = new PayslipRepository();
  const payslipItemsRepo = new PayslipItemRepository();

  const settingsService = new SettingsService(cache);

  const itemCategoriesRepo = new ItemCategoryRepository();
  const itemsRepo = new ItemRepository();
  const itemStockRepo = new ItemStockRepository();
  const stockMovementsRepo = new StockMovementRepository();
  const suppliersRepo = new SupplierRepository();
  const purchaseOrdersRepo = new PurchaseOrderRepository();
  const purchaseOrderItemsRepo = new PurchaseOrderItemRepository();


  const studentPolicy = new StudentPolicy(cache, permissions);
  const sectionPolicy = new SectionPolicy(cache, permissions);
  const staffPolicy = new StaffPolicy(cache, permissions);
  const userPolicy = new UserPolicy(cache, permissions);

  const reportsRepo = new ReportsRepository();
  const reportsService = new ReportsService(reportsRepo);

  return {
    cache,
    rateLimiter,
    denylist,
    permissions,
    policies: {
      student: studentPolicy,
      section: sectionPolicy,
      staff: staffPolicy,
      user: userPolicy,
    },
    repositories: {
      auth: authRepository,
      roles: rolesRepository,
      sections,
      students: studentsRepo,
      guardians: guardiansRepo,
      enrollments: enrollmentsRepo,
      applications: applicationsRepo,
      departments: departmentsRepo,
      designations: designationsRepo,
      staff: staffRepo,
      studentAttendance: studentAttendanceRepo,
      staffAttendance: staffAttendanceRepo,
      leaveTypes: leaveTypesRepo,
      leaveRequests: leaveRequestsRepo,
      staffLeaveBalances: staffLeaveBalancesRepo,
      periods: periodsRepo,
      timetableEntries: timetableEntriesRepo,
      substitutions: substitutionsRepo,
      notifications: notificationsRepo,
      notificationLogs: notificationLogsRepo,
      feeCategories: feeCategoriesRepo,
      feeStructures: feeStructuresRepo,
      discounts: discountsRepo,
      studentDiscounts: studentDiscountsRepo,
      feeInvoices: feeInvoicesRepo,
      feeInvoiceItems: feeInvoiceItemsRepo,
      payments: paymentsRepo,
      paymentAllocations: paymentAllocationsRepo,
      accountHeads: accountHeadsRepo,
      bankAccounts: bankAccountsRepo,
      vouchers: vouchersRepo,
      voucherEntries: voucherEntriesRepo,
      examTypes: examTypesRepo,
      exams: examsRepo,
      examSchedules: examSchedulesRepo,
      marks: marksRepo,
      gradingScales: gradingScalesRepo,
      gradingScaleRanges: gradingScaleRangesRepo,
      reportCards: reportCardsRepo,
      studentPromotions: studentPromotionsRepo,
      salaryComponents: salaryComponentsRepo,
      salaryStructures: salaryStructuresRepo,
      staffSalaries: staffSalariesRepo,
      payrollRuns: payrollRunsRepo,
      payslips: payslipsRepo,
      payslipItems: payslipItemsRepo,
      itemCategories: itemCategoriesRepo,
      items: itemsRepo,
      itemStock: itemStockRepo,
      suppliers: suppliersRepo,
      purchaseOrders: purchaseOrdersRepo,
      purchaseOrderItems: purchaseOrderItemsRepo,
      stockMovements: stockMovementsRepo,
      reports: reportsRepo,
    },
    services: {
      auth: new AuthService(authRepository, permissions, denylist),
      roles: new RolesService(rolesRepository, permissions),
      settings: settingsService,
      audit: new AuditService(),
      academic: new AcademicService(
        academicYears,
        terms,
        classes,
        sections,
        subjects,
        classSubjects,
        subjectTeachers,
        rooms,
        cache,
      ),
      students: new StudentsService(
        studentsRepo,
        guardiansRepo,
        enrollmentsRepo,
        sections,
        applicationsRepo,
        studentPolicy,
        permissions,
      ),
      staff: new StaffService(staffRepo, departmentsRepo, designationsRepo, staffPolicy, permissions),
      attendance: new AttendanceService(
        studentAttendanceRepo,
        staffAttendanceRepo,
        enrollmentsRepo,
        sections,
        staffRepo,
        sectionPolicy,
        studentPolicy,
        permissions,
        settingsService,
      ),
      leave: new LeaveService(
        leaveTypesRepo,
        leaveRequestsRepo,
        staffLeaveBalancesRepo,
        enrollmentsRepo,
        staffRepo,
        studentPolicy,
        permissions,
        notificationService,
      ),
      timetable: new TimetableService(
        periodsRepo,
        timetableEntriesRepo,
        substitutionsRepo,
        sections,
        classSubjects,
        rooms,
        staffRepo,
        permissions,
        notificationService,
      ),
      notifications: notificationService,
      fees: new FeesService(
        feeCategoriesRepo,
        feeStructuresRepo,
        discountsRepo,
        studentDiscountsRepo,
        feeInvoicesRepo,
        feeInvoiceItemsRepo,
        paymentsRepo,
        paymentAllocationsRepo,
        enrollmentsRepo,
        studentPolicy,
        permissions,
        accountingService,
        cache,
      ),
      exams: new ExamsService(
        examTypesRepo,
        examsRepo,
        examSchedulesRepo,
        marksRepo,
        gradingScalesRepo,
        gradingScaleRangesRepo,
        reportCardsRepo,
        classSubjects,
        rooms,
        permissions,
      ),
      promotions: new PromotionsService(studentPromotionsRepo, enrollmentsRepo, studentsRepo, sections),
      payroll: new PayrollService(salaryComponentsRepo, salaryStructuresRepo, staffSalariesRepo, payrollRunsRepo, payslipsRepo, payslipItemsRepo, staffRepo, permissions),
      accounting: accountingService,
      inventory: new InventoryService(
        itemCategoriesRepo, itemsRepo, itemStockRepo, stockMovementsRepo, suppliersRepo, purchaseOrdersRepo, purchaseOrderItemsRepo, settingsService,
      ),
      reports: reportsService,
    },
  };
}

