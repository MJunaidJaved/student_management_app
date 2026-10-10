import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, phone, moneyAmount } from '../../core/http/validate';
import { handler, actorOf, created, okBody } from '../../core/base/base-controller';
import type { TransportService } from './transport.service';

const idSchema = { params: z.object({ id: idParam }).strict() };
const enrollmentParams = { params: z.object({ enrollmentId: idParam }).strict() };

const driverBody = z.object({ fullName: text(120), licenseNo: text(40), licenseExpiry: isoDate, phone, nationalId: text(40).optional() }).strict();
const vehicleBody = z.object({ regNo: text(20), capacity: z.coerce.number().int().min(1).max(200), driverId: idParam.optional(), insuranceExpiry: isoDate.optional(), fitnessExpiry: isoDate.optional() }).strict();
const routeBody = z.object({ name: text(80), vehicleId: idParam.optional() }).strict();
const stopBody = z.object({ routeId: idParam, stopName: text(120), stopOrder: z.coerce.number().int().min(1).max(500), pickupTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Must be HH:MM or HH:MM:SS.').optional(), monthlyFee: moneyAmount }).strict();
const routeIdQuery = { params: z.object({ id: idParam }).strict() };

const allocateBody = z.object({ enrollmentId: idParam, routeStopId: idParam, startDate: isoDate }).strict();
const endBody = z.object({ endDate: isoDate }).strict();
const changeBody = z.object({ newRouteStopId: idParam, effectiveDate: isoDate }).strict();

export function transportRoutes(transport: TransportService): RouteDeclaration[] {
  return [
    /* ---------------- fleet ---------------- */
    { method: 'get', path: '/drivers', summary: 'List active drivers', permission: 'transport.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ drivers: await transport.listDrivers(actorOf(req)) })) },
    {
      method: 'post', path: '/drivers', summary: 'Register a driver', permission: 'transport.manage_fleet', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: driverBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof driverBody }>(req); return created(await transport.createDriver(actorOf(req), body)); }),
    },
    { method: 'get', path: '/vehicles', summary: 'List active vehicles', permission: 'transport.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ vehicles: await transport.listVehicles(actorOf(req)) })) },
    {
      method: 'post', path: '/vehicles', summary: 'Register a vehicle', permission: 'transport.manage_fleet', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: vehicleBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof vehicleBody }>(req); return created(await transport.createVehicle(actorOf(req), body)); }),
    },
    {
      method: 'get', path: '/vehicles/:id/occupancy', summary: 'A vehicle’s capacity versus its current occupancy', permission: 'transport.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: routeIdQuery,
      handler: handler(async (req) => { const { params } = validated<typeof routeIdQuery>(req); return okBody(await transport.vehicleOccupancy(actorOf(req), params.id)); }),
    },

    /* ---------------- routes and stops ---------------- */
    { method: 'get', path: '/routes', summary: 'List transport routes', permission: 'transport.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ routes: await transport.listRoutes(actorOf(req)) })) },
    {
      method: 'post', path: '/routes', summary: 'Create a transport route', permission: 'transport.manage_fleet', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: routeBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof routeBody }>(req); return created(await transport.createRoute(actorOf(req), body)); }),
    },
    {
      method: 'get', path: '/routes/:id/stops', summary: 'List a route’s ordered stops', permission: 'transport.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: routeIdQuery,
      handler: handler(async (req) => { const { params } = validated<typeof routeIdQuery>(req); return okBody({ stops: await transport.listStops(actorOf(req), params.id) }); }),
    },
    {
      method: 'post', path: '/route-stops', summary: 'Add a stop to a route', permission: 'transport.manage_fleet', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: stopBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof stopBody }>(req); return created(await transport.createStop(actorOf(req), body)); }),
    },
    {
      method: 'get', path: '/routes/:id/sheet', summary: 'A printable route sheet: stops in order with who boards where', permission: 'transport.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: routeIdQuery,
      handler: handler(async (req) => { const { params } = validated<typeof routeIdQuery>(req); return okBody({ sheet: await transport.routeSheet(actorOf(req), params.id) }); }),
    },
    {
      method: 'get', path: '/reports/transport/routes/:id/students', summary: 'Students currently allocated to a route', permission: 'transport.read', ownership: 'none', rateLimit: 'expensive',
      schemas: routeIdQuery,
      handler: handler(async (req) => { const { params } = validated<typeof routeIdQuery>(req); return okBody({ students: await transport.studentsForRoute(actorOf(req), params.id) }); }),
    },

    /* ---------------- allocations ---------------- */
    {
      method: 'post', path: '/transport-allocations', summary: 'Allocate an enrollment to a route stop', permission: 'transport.allocate', ownership: 'none', rateLimit: 'money',
      schemas: { body: allocateBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof allocateBody }>(req); return created(await transport.allocate(actorOf(req), body)); }),
      errors: ['ENROLLMENT_NOT_ACTIVE', 'VEHICLE_FULL', 'DUPLICATE'],
    },
    {
      method: 'post', path: '/transport-allocations/:id/end', summary: 'End a transport allocation', permission: 'transport.allocate', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: endBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof endBody }>(req); return okBody(await transport.endAllocation(actorOf(req), params.id, body.endDate)); }),
      errors: ['ALREADY_ENDED', 'INVALID_RANGE'],
    },
    {
      method: 'post', path: '/transport-allocations/:id/change', summary: 'End the current allocation and start a new one on another stop', permission: 'transport.allocate', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: changeBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof changeBody }>(req); return okBody(await transport.changeAllocation(actorOf(req), params.id, body)); }),
      errors: ['ALREADY_ENDED', 'VEHICLE_FULL'],
    },
    {
      method: 'get', path: '/enrollments/:enrollmentId/transport', summary: 'The current transport allocation for an enrollment (self, a guardian of the student, or a transport.read holder)',
      permission: 'transport.read_own', ownership: 'guardian-children', rateLimit: 'userStandard',
      schemas: enrollmentParams,
      handler: handler(async (req) => { const { params } = validated<typeof enrollmentParams>(req); return okBody({ allocation: await transport.myAllocation(actorOf(req), params.enrollmentId) }); }),
    },
    {
      method: 'get', path: '/enrollments/:enrollmentId/transport-history', summary: "An enrollment's transport allocation history",
      permission: 'transport.read_own', ownership: 'guardian-children', rateLimit: 'userStandard',
      schemas: enrollmentParams,
      handler: handler(async (req) => { const { params } = validated<typeof enrollmentParams>(req); return okBody({ history: await transport.historyForEnrollment(actorOf(req), params.enrollmentId) }); }),
    },

    /* ---------------- compliance ---------------- */
    { method: 'get', path: '/reports/transport/compliance', summary: 'Drivers and vehicles with an expiring license, insurance or fitness certificate', permission: 'transport.read_compliance', ownership: 'none', rateLimit: 'expensive', handler: handler(async (req) => okBody(await transport.complianceReport(actorOf(req)))) },
  ];
}
