/**
 * Transport (Module 13).
 *
 * Capacity and "one active allocation per enrollment" are both enforced by
 * the schema itself (see the repository header), so `allocate` just inserts
 * and lets the database refuse an over-capacity or duplicate allocation with
 * a translated, friendly error rather than re-checking either here.
 */

import { transaction, readTransaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, NotFoundError } from '../../core/errors';
import type { EnrollmentRepository } from '../students/students.repository';
import type { PermissionService } from '../../core/authz/permission-service';
import {
  DriverRepository,
  VehicleRepository,
  RouteRepository,
  RouteStopRepository,
  StudentTransportRepository,
  type DriverRow,
  type VehicleRow,
  type RouteRow,
  type RouteStopRow,
  type StudentTransportRow,
} from './transport.repository';

/* ---------------- views ---------------- */

export type DriverView = { id: string; fullName: string; licenseNo: string; licenseExpiry: string; phone: string; nationalId: string | null; isActive: boolean };
const toDriverView = (r: DriverRow): DriverView => ({ id: r.id, fullName: r.full_name, licenseNo: r.license_no, licenseExpiry: r.license_expiry, phone: r.phone, nationalId: r.national_id, isActive: r.is_active });

export type VehicleView = { id: string; regNo: string; capacity: number; driverId: string | null; insuranceExpiry: string | null; fitnessExpiry: string | null; isActive: boolean };
const toVehicleView = (r: VehicleRow): VehicleView => ({ id: r.id, regNo: r.reg_no, capacity: r.capacity, driverId: r.driver_id, insuranceExpiry: r.insurance_expiry, fitnessExpiry: r.fitness_expiry, isActive: r.is_active });

export type RouteView = { id: string; name: string; vehicleId: string | null };
const toRouteView = (r: RouteRow): RouteView => ({ id: r.id, name: r.name, vehicleId: r.vehicle_id });

export type RouteStopView = { id: string; routeId: string; stopName: string; stopOrder: number; pickupTime: string | null; monthlyFee: string };
const toStopView = (r: RouteStopRow): RouteStopView => ({ id: r.id, routeId: r.route_id, stopName: r.stop_name, stopOrder: r.stop_order, pickupTime: r.pickup_time, monthlyFee: r.monthly_fee });

export type AllocationView = { id: string; enrollmentId: string; routeStopId: string; startDate: string; endDate: string | null; monthlyFee: string };
const toAllocationView = (r: StudentTransportRow): AllocationView => ({ id: r.id, enrollmentId: r.enrollment_id, routeStopId: r.route_stop_id, startDate: r.start_date, endDate: r.end_date, monthlyFee: r.monthly_fee });

/** Days ahead a compliance report flags an expiring license, insurance or fitness certificate. */
const COMPLIANCE_WINDOW_DAYS = 30;

export class TransportService {
  constructor(
    private readonly drivers: DriverRepository,
    private readonly vehicles: VehicleRepository,
    private readonly routes: RouteRepository,
    private readonly stops: RouteStopRepository,
    private readonly allocations: StudentTransportRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly permissions: PermissionService,
  ) {}

  /* ---------------- fleet ---------------- */

  async listDrivers(actor: Actor): Promise<DriverView[]> {
    return readTransaction(actor, async (uow) => (await this.drivers.listAll(uow)).map(toDriverView));
  }

  async createDriver(actor: Actor, input: { fullName: string; licenseNo: string; licenseExpiry: string; phone: string; nationalId?: string | undefined }): Promise<DriverView> {
    return transaction(actor, async (uow) =>
      toDriverView(await this.drivers.create(uow, { full_name: input.fullName, license_no: input.licenseNo, license_expiry: input.licenseExpiry, phone: input.phone, national_id: input.nationalId ?? null, is_active: true })),
    );
  }

  async listVehicles(actor: Actor): Promise<VehicleView[]> {
    return readTransaction(actor, async (uow) => (await this.vehicles.listAll(uow)).map(toVehicleView));
  }

  async createVehicle(actor: Actor, input: { regNo: string; capacity: number; driverId?: string | undefined; insuranceExpiry?: string | undefined; fitnessExpiry?: string | undefined }): Promise<VehicleView> {
    return transaction(actor, async (uow) =>
      toVehicleView(await this.vehicles.create(uow, { reg_no: input.regNo, capacity: input.capacity, driver_id: input.driverId ?? null, insurance_expiry: input.insuranceExpiry ?? null, fitness_expiry: input.fitnessExpiry ?? null, is_active: true })),
    );
  }

  async vehicleOccupancy(actor: Actor, id: string) {
    return readTransaction(actor, (uow) => this.vehicles.occupancy(uow, id));
  }

  async listRoutes(actor: Actor): Promise<RouteView[]> {
    return readTransaction(actor, async (uow) => (await this.routes.listAll(uow)).map(toRouteView));
  }

  async createRoute(actor: Actor, input: { name: string; vehicleId?: string | undefined }): Promise<RouteView> {
    return transaction(actor, async (uow) => {
      if (input.vehicleId) await this.vehicles.getById(uow, input.vehicleId);
      return toRouteView(await this.routes.create(uow, { name: input.name, vehicle_id: input.vehicleId ?? null }));
    });
  }

  async listStops(actor: Actor, routeId: string): Promise<RouteStopView[]> {
    return readTransaction(actor, async (uow) => (await this.stops.listForRoute(uow, routeId)).map(toStopView));
  }

  async createStop(actor: Actor, input: { routeId: string; stopName: string; stopOrder: number; pickupTime?: string | undefined; monthlyFee: string }): Promise<RouteStopView> {
    return transaction(actor, async (uow) => {
      await this.routes.getById(uow, input.routeId);
      return toStopView(await this.stops.create(uow, { route_id: input.routeId, stop_name: input.stopName, stop_order: input.stopOrder, pickup_time: input.pickupTime ?? null, monthly_fee: input.monthlyFee }));
    });
  }

  async routeSheet(actor: Actor, routeId: string) {
    return readTransaction(actor, async (uow) => {
      await this.routes.getById(uow, routeId);
      return this.routes.sheet(uow, routeId);
    });
  }

  async studentsForRoute(actor: Actor, routeId: string) {
    return readTransaction(actor, async (uow) => {
      await this.routes.getById(uow, routeId);
      return this.allocations.studentsForRoute(uow, routeId);
    });
  }

  /* ---------------- allocations ---------------- */

  /**
   * Allocate an enrollment to a stop. The monthly fee is copied from the
   * stop at allocation time, as a snapshot — a later change to the stop's
   * listed fee must not silently reprice an allocation already in effect.
   */
  async allocate(actor: Actor, input: { enrollmentId: string; routeStopId: string; startDate: string }): Promise<AllocationView> {
    return transaction(actor, async (uow) => {
      const enrollment = await this.enrollments.getById(uow, input.enrollmentId);
      if (enrollment.status !== 'active') {
        throw new BusinessRuleError('Only an active enrollment can be allocated to transport.', 'ENROLLMENT_NOT_ACTIVE');
      }
      const stop = await this.stops.getById(uow, input.routeStopId);
      const row = await this.allocations.create(uow, {
        enrollment_id: input.enrollmentId, route_stop_id: input.routeStopId, start_date: input.startDate, end_date: null, monthly_fee: stop.monthly_fee,
      });
      return toAllocationView(row);
    });
  }

  async endAllocation(actor: Actor, id: string, endDate: string): Promise<AllocationView> {
    return transaction(actor, async (uow) => {
      const existing = await this.allocations.getById(uow, id);
      if (existing.end_date !== null) throw new BusinessRuleError('This allocation has already ended.', 'ALREADY_ENDED');
      if (endDate < existing.start_date) {
        throw new BusinessRuleError('The end date cannot be before the allocation started.', 'INVALID_RANGE');
      }
      return toAllocationView(await this.allocations.end(uow, id, endDate));
    });
  }

  /** End the current allocation and start a new one, as one transaction — the "change" operation. */
  async changeAllocation(actor: Actor, id: string, input: { newRouteStopId: string; effectiveDate: string }): Promise<AllocationView> {
    return transaction(actor, async (uow) => {
      const existing = await this.allocations.getById(uow, id);
      if (existing.end_date !== null) throw new BusinessRuleError('This allocation has already ended.', 'ALREADY_ENDED');
      const dayBefore = addDays(input.effectiveDate, -1);
      await this.allocations.end(uow, id, dayBefore);
      const stop = await this.stops.getById(uow, input.newRouteStopId);
      const row = await this.allocations.create(uow, {
        enrollment_id: existing.enrollment_id, route_stop_id: input.newRouteStopId, start_date: input.effectiveDate, end_date: null, monthly_fee: stop.monthly_fee,
      });
      return toAllocationView(row);
    });
  }

  async historyForEnrollment(actor: Actor, enrollmentId: string): Promise<AllocationView[]> {
    return readTransaction(actor, async (uow) => {
      await this.assertCanViewEnrollment(uow, actor, enrollmentId);
      return (await this.allocations.history(uow, enrollmentId)).map(toAllocationView);
    });
  }

  private async assertCanViewEnrollment(uow: Uow, actor: Actor, enrollmentId: string): Promise<void> {
    const enrollment = await this.enrollments.findById(uow, enrollmentId);
    if (!enrollment) throw new NotFoundError('Enrollment');

    const held = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
    if (actor.userType === 'admin' || held.has('transport.read')) return;
    if (actor.userType === 'student' && String(actor.studentId) === enrollment.student_id) return;
    if (actor.userType === 'guardian' && actor.guardianId != null) {
      const link = await uow.maybeOne<{ ok: boolean }>(`SELECT true AS ok FROM student_guardians WHERE guardian_id = $1 AND student_id = $2`, [actor.guardianId, enrollment.student_id]);
      if (link) return;
    }
    throw new NotFoundError('Enrollment');
  }

  /** A guardian's own child, or a student their own record — "my transport" for the portal. */
  async myAllocation(actor: Actor, enrollmentId: string): Promise<AllocationView | null> {
    return readTransaction(actor, async (uow) => {
      await this.assertCanViewEnrollment(uow, actor, enrollmentId);
      const row = await this.allocations.findActive(uow, enrollmentId);
      return row ? toAllocationView(row) : null;
    });
  }

  /* ---------------- compliance ---------------- */

  async complianceReport(actor: Actor) {
    return readTransaction(actor, async (uow) => ({
      driversExpiring: (await this.drivers.expiringWithin(uow, COMPLIANCE_WINDOW_DAYS)).map(toDriverView),
      vehiclesExpiring: (await this.vehicles.expiringWithin(uow, COMPLIANCE_WINDOW_DAYS)).map(toVehicleView),
      windowDays: COMPLIANCE_WINDOW_DAYS,
    }));
  }
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
