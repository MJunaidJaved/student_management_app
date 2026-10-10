export type SalaryComponentView = { id: string; name: string; type: 'earning' | 'deduction'; calcType: 'fixed' | 'percent' }
export type SalaryStructureView = { id: string; name: string; description: string | null }
export type StaffSalaryView = {
  id: string
  staffId: string
  salaryStructureId: string | null
  basicSalary: string
  effectiveFrom: string
  effectiveTo: string | null
}

export type PayrollRunStatus = 'draft' | 'approved' | 'paid'
export type PayrollRunView = { id: string; payMonth: number; payYear: number; status: PayrollRunStatus; runBy: string | null; approvedBy: string | null }

export type PayslipView = { id: string; payrollRunId: string; staffId: string; gross: string; totalDeductions: string; net: string; paidOn: string | null }
export type PayslipListItem = PayslipView & { fullName: string; employeeNo: string }
export type PayslipItemView = { id: string; payslipId: string; salaryComponentId: string; componentName: string; type: string; amount: string; reason: string | null }
export type PayslipDetail = PayslipView & { items: PayslipItemView[] }

export const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
