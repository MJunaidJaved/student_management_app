export type DriverView = { id: string; fullName: string; licenseNo: string; licenseExpiry: string; phone: string; nationalId: string | null; isActive: boolean }
export type VehicleView = { id: string; regNo: string; capacity: number; driverId: string | null; insuranceExpiry: string | null; fitnessExpiry: string | null; isActive: boolean }
export type RouteView = { id: string; name: string; vehicleId: string | null }
export type RouteStopView = { id: string; routeId: string; stopName: string; stopOrder: number; pickupTime: string | null; monthlyFee: string }
export type AllocationView = { id: string; enrollmentId: string; routeStopId: string; startDate: string; endDate: string | null; monthlyFee: string }

export type VehicleOccupancy = { capacity: number; occupied: number }

export type RouteSheetRow = { stopId: string; stopName: string; stopOrder: number; pickupTime: string | null; studentName: string; admissionNo: string }
export type StudentsForRouteRow = { enrollmentId: string; studentName: string; admissionNo: string; stopName: string }

export type ComplianceReport = { driversExpiring: DriverView[]; vehiclesExpiring: VehicleView[]; windowDays: number }
