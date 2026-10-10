// Mirrors server/src/modules/students/students.service.ts's view types exactly.

export type StudentView = {
  id: string
  admissionNo: string
  firstName: string
  lastName: string | null
  gender: string
  dob: string
  status: string
  admissionDate: string
  phone: string | null
  address: string | null
  bloodGroup: string | null
  religion: string | null
  previousSchool: string | null
  photoPath: string | null
  nationalId: string | null
}

export type GuardianLinkView = {
  id: string
  fullName: string
  nationalId: string | null
  phone: string
  email: string | null
  occupation: string | null
  address: string | null
  linkId: string
  relation: string
  isPrimary: boolean
  isFeePayer: boolean
}

export type EnrollmentView = {
  id: string
  studentId: string
  academicYearId: string
  classId: string
  sectionId: string
  rollNo: number
  status: string
}

export type StudentDetail = StudentView & {
  guardians: GuardianLinkView[]
  enrollment: EnrollmentView | null
}
