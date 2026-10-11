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

export type SubjectTeacherAssignment = {
  id: string
  academicYearId: string
  sectionId: string
  subjectId: string
  staffId: string
  subjectName: string
  sectionName: string
  className: string
  staffName: string
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
