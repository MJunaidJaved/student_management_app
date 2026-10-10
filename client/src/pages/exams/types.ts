export type ExamTypeView = { id: string; name: string; weightage: string | null }

export type ExamStatus = 'draft' | 'published' | 'locked'
export type ExamView = {
  id: string
  academicYearId: string
  termId: string | null
  examTypeId: string
  name: string
  startDate: string
  endDate: string
  status: ExamStatus
}

export type ExamScheduleView = {
  id: string
  examId: string
  classId: string
  subjectId: string
  examDate: string
  startTime: string
  endTime: string
  roomId: string | null
  totalMarks: string
  passingMarks: string
}

export type MarkView = {
  id: string
  examScheduleId: string
  enrollmentId: string
  marksObtained: string | null
  isAbsent: boolean
  isLocked: boolean
}

export type GradingScaleView = { id: string; name: string; isDefault: boolean }

export type GradingRangeView = {
  id: string
  gradingScaleId: string
  minPercent: string
  maxPercent: string
  grade: string
  gpaPoints: string | null
  remark: string | null
}

export type ReportCardView = {
  id: string
  examId: string
  enrollmentId: string
  totalMarks: string
  obtainedMarks: string
  percentage: string
  grade: string | null
  rank: number | null
  remarks: string | null
  publishedAt: string | null
}

export type ReportCardListItem = ReportCardView & {
  firstName: string
  lastName: string | null
  rollNo: number
  classId: string
  sectionId: string
}

export type ClassListEntry = {
  id: string
  studentId: string
  academicYearId: string
  classId: string
  sectionId: string
  rollNo: number
  status: string
  enrolledOn: string
  firstName: string
  lastName: string | null
  admissionNo: string
}
