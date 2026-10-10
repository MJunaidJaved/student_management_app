// Mirrors server/src/modules/staff/staff.service.ts's view types.

export type StaffView = {
  id: string
  employeeNo: string
  fullName: string
  gender: string
  dob: string
  phone: string
  email: string | null
  address: string | null
  departmentId: string | null
  designationId: string | null
  joinDate: string
  status: string
  photoPath: string | null
  nationalId: string | null
  separationDate: string | null
  separationReason: string | null
}

export type StaffRow = StaffView & { departmentName: string | null; designationName: string | null }

export type Department = { id: string; name: string }
export type Designation = { id: string; name: string; departmentId: string | null }
