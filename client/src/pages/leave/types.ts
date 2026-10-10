export type LeaveApplicantType = 'student' | 'staff'
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export type LeaveTypeView = {
  id: string
  name: string
  appliesTo: 'student' | 'staff' | 'both'
  daysPerYear: number | null
}

export type LeaveRequestView = {
  id: string
  applicantType: LeaveApplicantType
  enrollmentId: string | null
  staffId: string | null
  leaveTypeId: string
  fromDate: string
  toDate: string
  reason: string | null
  status: LeaveStatus
  decidedBy: string | null
  decidedAt: string | null
}

export type StaffLeaveBalanceView = {
  id: string
  staffId: string
  leaveTypeId: string
  leaveTypeName: string
  academicYearId: string
  allotted: string
  used: string
}
