export type PeriodView = { id: string; name: string; startTime: string; endTime: string; sortOrder: number }

export type TimetableEntryView = {
  id: string
  academicYearId: string
  sectionId: string
  dayOfWeek: number
  periodId: string
  subjectId: string
  staffId: string
  roomId: string | null
}

export type RoomView = { id: string; name: string; capacity: number | null; roomType: string }

// `/academic/years/:id/subject-teachers` returns the repository row shape
// unmapped (snake_case, plus audit columns) rather than the camelCase view
// every other endpoint uses — a found-not-fixed backend inconsistency.
export type SubjectTeacherAssignment = {
  id: string
  academic_year_id: string
  section_id: string
  subject_id: string
  staff_id: string
  subject_name: string
  section_name: string
  class_name: string
  staff_name: string
}

export type SubstitutionListItem = {
  id: string
  timetableEntryId: string
  subDate: string
  sectionName: string
  subjectName: string
  periodName: string
  originalStaffName: string
  substituteName: string
  reason: string | null
  cancelledAt: string | null
}

export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
