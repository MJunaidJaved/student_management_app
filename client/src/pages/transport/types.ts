export type DriverView = { id: string; fullName: string; licenseNo: string; licenseExpiry: string; phone: string; nationalId: string | null; isActive: boolean }
export type VehicleView = { id: string; regNo: string; capacity: number; driverId: string | null; insuranceExpiry: string | null; fitnessExpiry: string | null; isActive: boolean }
export type RouteView = { id: string; name: string; vehicleId: string | null }
export type RouteStopView = { id: string; routeId: string; stopName: string; stopOrder: number; pickupTime: string | null; monthlyFee: string }
export type AllocationView = { id: string; enrollmentId: string; routeStopId: string; startDate: string; endDate: string | null; monthlyFee: string }

export type VehicleOccupancy = { capacity: number; occupied: number }

// These three endpoints return raw repository rows (snake_case) rather than
// a mapped camelCase view — a found-not-fixed inconsistency shared with
// several other report-style endpoints in this backend.
export type RouteSheetRow = { stop_id: string; stop_name: string; stop_order: number; pickup_time: string | null; student_name: string; admission_no: string }
export type StudentsForRouteRow = { enrollment_id: string; student_name: string; admission_no: string; stop_name: string }

export type ComplianceReport = { driversExpiring: DriverView[]; vehiclesExpiring: VehicleView[]; windowDays: number }
