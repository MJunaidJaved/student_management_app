export type ApplicationStatus = 'enquiry' | 'applied' | 'test' | 'accepted' | 'rejected' | 'enrolled'

export type AdmissionApplicationView = {
  id: string
  applicationNo: string
  applicantName: string
  dob: string
  gender: string | null
  guardianName: string
  guardianPhone: string
  appliedClassId: string
  status: ApplicationStatus
  studentId: string | null
  remarks: string | null
}

// Mirrors APPLICATION_TRANSITIONS in server/src/core/db/enums.ts exactly —
// `enrolled` is reached only via the convert endpoint, never set directly.
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  enquiry: ['applied', 'rejected'],
  applied: ['test', 'accepted', 'rejected'],
  test: ['accepted', 'rejected'],
  accepted: ['rejected'],
  rejected: [],
  enrolled: [],
}
