/**
 * Transport (Module 13) data access.
 *
 * Vehicle capacity is enforced by the schema's own `check_vehicle_capacity`
 * trigger on `student_transport` (counting active allocations on the whole
 * route, against the route's vehicle), and `uq_one_active_transport`
 * (a partial unique index on `enrollment_id WHERE end_date IS NULL`) is what
 * guarantees one active allocation per enrollment. Both are translated into
 * friendly errors by `translate-error.ts` (`VEHICLE_FULL`, and the
 * `uq_one_active_transport` hint), so this repository does not duplicate
 * either check — it just inserts and lets the database be the guard.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import type { SortMap } from '../../core/db/query-builder';

export type DriverRow = BaseRow & { full_name: string; license_no: string; license_expiry: string; phone: string; national_id: string | null; is_active: boolean };

export class DriverRepository extends BaseRepository<DriverRow> {
  protected readonly table = 'drivers';
  protected readonly writableColumns = ['full_name', 'license_no', 'license_expiry', 'phone', 'national_id', 'is_active'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'full_name';
  protected readonly sortable: SortMap = { full_name: { column: 'drivers.full_name', index: 'drivers_pkey' } };

  async listAll(uow: Uow, includeInactive = false): Promise<DriverRow[]> {
    return uow.many<DriverRow>(`SELECT * FROM drivers ${includeInactive ? '' : 'WHERE is_active'} ORDER BY full_name`);
  }

  /** Licenses expiring within `days` — Part 5.9's document-expiry reminder. */
  async expiringWithin(uow: Uow, days: number): Promise<DriverRow[]> {
    return uow.many<DriverRow>(`SELECT * FROM drivers WHERE is_active AND license_expiry <= CURRENT_DATE + $1::int ORDER BY license_expiry`, [days]);
  }
}

export type VehicleRow = BaseRow & { reg_no: string; capacity: number; driver_id: string | null; insurance_expiry: string | null; fitness_expiry: string | null; is_active: boolean };

export class VehicleRepository extends BaseRepository<VehicleRow> {
  protected readonly table = 'vehicles';
  protected readonly writableColumns = ['reg_no', 'capacity', 'driver_id', 'insurance_expiry', 'fitness_expiry', 'is_active'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'reg_no';
  protected readonly sortable: SortMap = { reg_no: { column: 'vehicles.reg_no', index: 'vehicles_pkey' } };

  async listAll(uow: Uow, includeInactive = false): Promise<VehicleRow[]> {
    return uow.many<VehicleRow>(`SELECT * FROM vehicles ${includeInactive ? '' : 'WHERE is_active'} ORDER BY reg_no`);
  }

  async expiringWithin(uow: Uow, days: number): Promise<VehicleRow[]> {
    return uow.many<VehicleRow>(
      `SELECT * FROM vehicles WHERE is_active AND (insurance_expiry <= CURRENT_DATE + $1::int OR fitness_expiry <= CURRENT_DATE + $1::int) ORDER BY LEAST(insurance_expiry, fitness_expiry)`,
      [days],
    );
  }

  async occupancy(uow: Uow, id: string): Promise<{ capacity: number; occupied: number }> {
    const row = await uow.one<{ capacity: number; occupied: number }>(
      `SELECT v.capacity,
              (SELECT count(*)::int FROM student_transport st
                 JOIN route_stops rs ON rs.id = st.route_stop_id
                 JOIN routes r ON r.id = rs.route_id
                WHERE r.vehicle_id = v.id AND st.end_date IS NULL) AS occupied
         FROM vehicles v WHERE v.id = $1`,
      [id],
    );
    return row;
  }
}

export type RouteRow = BaseRow & { name: string; vehicle_id: string | null };

export class RouteRepository extends BaseRepository<RouteRow> {
  protected readonly table = 'routes';
  protected readonly writableColumns = ['name', 'vehicle_id'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'routes.name', index: 'routes_name_key' } };

  async listAll(uow: Uow): Promise<RouteRow[]> {
    return uow.many<RouteRow>(`SELECT * FROM routes ORDER BY name`);
  }

  /** The driver's printable route sheet: stops in order, with who boards where. */
  async sheet(uow: Uow, id: string): Promise<{ stop_id: string; stop_name: string; stop_order: number; pickup_time: string | null; student_name: string; admission_no: string }[]> {
    return uow.many(
      `SELECT rs.id::text AS stop_id, rs.stop_name, rs.stop_order, rs.pickup_time::text AS pickup_time,
              s.first_name || COALESCE(' ' || s.last_name, '') AS student_name, s.admission_no
         FROM route_stops rs
         JOIN student_transport st ON st.route_stop_id = rs.id AND st.end_date IS NULL
         JOIN student_enrollments e ON e.id = st.enrollment_id
         JOIN students s ON s.id = e.student_id
        WHERE rs.route_id = $1
        ORDER BY rs.stop_order, student_name`,
      [id],
    );
  }
}

export type RouteStopRow = BaseRow & { route_id: string; stop_name: string; stop_order: number; pickup_time: string | null; monthly_fee: string };

export class RouteStopRepository extends BaseRepository<RouteStopRow> {
  protected readonly table = 'route_stops';
  protected readonly writableColumns = ['route_id', 'stop_name', 'stop_order', 'pickup_time', 'monthly_fee'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'stop_order';
  protected readonly sortable: SortMap = { stop_order: { column: 'route_stops.stop_order', index: 'route_stops_route_id_stop_order_key' } };

  async listForRoute(uow: Uow, routeId: string): Promise<RouteStopRow[]> {
    return uow.many<RouteStopRow>(`SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_order`, [routeId]);
  }
}

export type StudentTransportRow = BaseRow & { enrollment_id: string; route_stop_id: string; start_date: string; end_date: string | null; monthly_fee: string };

export class StudentTransportRepository extends BaseRepository<StudentTransportRow> {
  protected readonly table = 'student_transport';
  protected readonly writableColumns = ['enrollment_id', 'route_stop_id', 'start_date', 'end_date', 'monthly_fee'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'student_transport.id', index: 'student_transport_pkey' } };

  async findActive(uow: Uow, enrollmentId: string): Promise<StudentTransportRow | null> {
    return uow.maybeOne<StudentTransportRow>(`SELECT * FROM student_transport WHERE enrollment_id = $1 AND end_date IS NULL`, [enrollmentId]);
  }

  /** The allocation active on a given date, for the fee-generation integration (Module 5/13). */
  async findActiveOn(uow: Uow, enrollmentId: string, date: string): Promise<StudentTransportRow | null> {
    return uow.maybeOne<StudentTransportRow>(
      `SELECT * FROM student_transport WHERE enrollment_id = $1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2)`,
      [enrollmentId, date],
    );
  }

  async history(uow: Uow, enrollmentId: string): Promise<StudentTransportRow[]> {
    return uow.many<StudentTransportRow>(`SELECT * FROM student_transport WHERE enrollment_id = $1 ORDER BY start_date DESC`, [enrollmentId]);
  }

  async end(uow: Uow, id: string, endDate: string): Promise<StudentTransportRow> {
    return uow.one<StudentTransportRow>(`UPDATE student_transport SET end_date = $2 WHERE id = $1 RETURNING *`, [id, endDate], 'Transport allocation');
  }

  async studentsForRoute(uow: Uow, routeId: string): Promise<{ enrollment_id: string; student_name: string; admission_no: string; stop_name: string }[]> {
    return uow.many(
      `SELECT st.enrollment_id::text AS enrollment_id, s.first_name || COALESCE(' ' || s.last_name, '') AS student_name, s.admission_no, rs.stop_name
         FROM student_transport st
         JOIN route_stops rs ON rs.id = st.route_stop_id
         JOIN student_enrollments e ON e.id = st.enrollment_id
         JOIN students s ON s.id = e.student_id
        WHERE rs.route_id = $1 AND st.end_date IS NULL
        ORDER BY rs.stop_order, student_name`,
      [routeId],
    );
  }
}
