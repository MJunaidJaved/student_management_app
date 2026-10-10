import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, moneyAmount } from '../../core/http/validate';
import { handler, actorOf, created, okBody } from '../../core/base/base-controller';
import type { InventoryService } from './inventory.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

/** A moved quantity: strictly positive, at most 2 decimal places. */
const quantity = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => /^\d{1,8}(\.\d{1,2})?$/.test(v) && v !== '0' && v !== '0.00', 'Must be a positive amount, at most 2 decimal places.');

/** A non-negative quantity, such as a reorder level: zero is legal (the DB's own CHECK allows it). */
const nonNegativeQuantity = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => /^\d{1,8}(\.\d{1,2})?$/.test(v), 'Must be a non-negative amount, at most 2 decimal places.');

const signedQuantity = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
  .refine((v) => /^-?\d{1,8}(\.\d{1,2})?$/.test(v), 'Must be a decimal amount, at most 2 decimal places.');

const page = { limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().optional() };

const categoryBody = z.object({ name: text(80) }).strict();
const supplierBody = z.object({ name: text(120), phone: text(20).optional(), email: z.string().email().optional(), address: text(300).optional(), taxNo: text(40).optional() }).strict();
const itemBody = z.object({ sku: text(40), name: text(120), categoryId: idParam, unit: text(20), reorderLevel: nonNegativeQuantity }).strict();
const itemsListQuery = z.object({ ...page, categoryId: idParam.optional(), search: text(120).optional() }).strict();
const movementsListQuery = z.object({ ...page }).strict();

const poItem = z.object({ itemId: idParam, quantity, unitCost: moneyAmount }).strict();
const createPoBody = z.object({ supplierId: idParam, orderDate: isoDate, items: z.array(poItem).min(1).max(100) }).strict();
const receivePoBody = z.object({ items: z.array(z.object({ itemId: idParam, quantity }).strict()).min(1).max(100) }).strict();
const poListQuery = z.object({ ...page, status: z.enum(['draft', 'ordered', 'received', 'cancelled']).optional(), supplierId: idParam.optional() }).strict();

const issueStockBody = z.object({ itemId: idParam, quantity, referenceType: text(40).optional(), referenceId: idParam.optional() }).strict();
const adjustStockBody = z.object({ itemId: idParam, quantityDelta: signedQuantity, reason: text(300) }).strict();

export function inventoryRoutes(inventory: InventoryService): RouteDeclaration[] {
  return [
    /* ---------------- categories ---------------- */
    { method: 'get', path: '/item-categories', summary: 'List item categories', permission: 'inventory.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ categories: await inventory.listCategories(actorOf(req)) })) },
    {
      method: 'post', path: '/item-categories', summary: 'Create an item category', permission: 'inventory.manage_items', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: categoryBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof categoryBody }>(req); return created(await inventory.createCategory(actorOf(req), body)); }),
    },

    /* ---------------- suppliers ---------------- */
    { method: 'get', path: '/suppliers', summary: 'List suppliers', permission: 'inventory.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ suppliers: await inventory.listSuppliers(actorOf(req)) })) },
    {
      method: 'post', path: '/suppliers', summary: 'Create a supplier', permission: 'inventory.manage_suppliers', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: supplierBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof supplierBody }>(req); return created(await inventory.createSupplier(actorOf(req), body)); }),
    },

    /* ---------------- items and stock ---------------- */
    {
      method: 'get', path: '/items', summary: 'List items with their current stock', permission: 'inventory.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: itemsListQuery },
      handler: handler(async (req) => {
        const { query } = validated<{ query: typeof itemsListQuery }>(req);
        const result = await inventory.listItems(actorOf(req), { categoryId: query.categoryId, search: query.search }, { limit: query.limit, cursorId: query.cursor });
        return okBody(result);
      }),
    },
    {
      method: 'post', path: '/items', summary: 'Create an item', permission: 'inventory.manage_items', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: itemBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof itemBody }>(req); return created(await inventory.createItem(actorOf(req), body)); }),
    },
    { method: 'get', path: '/items/low-stock', summary: 'Items at or below their reorder level', permission: 'inventory.read_reports', ownership: 'none', rateLimit: 'expensive', handler: handler(async (req) => okBody({ items: await inventory.lowStockReport(actorOf(req)) })) },
    {
      method: 'get', path: '/items/:id/movements', summary: "An item's stock movement history", permission: 'inventory.read_reports', ownership: 'none', rateLimit: 'userStandard',
      schemas: { ...idSchema, query: movementsListQuery },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: typeof idSchema.params; query: typeof movementsListQuery }>(req);
        return okBody(await inventory.listMovementsForItem(actorOf(req), params.id, { limit: query.limit, cursorId: query.cursor }));
      }),
    },
    { method: 'get', path: '/stock/reconcile', summary: 'Compare the cached stock summary against the movement ledger', permission: 'inventory.read_reports', ownership: 'none', rateLimit: 'expensive', handler: handler(async (req) => okBody({ drift: await inventory.reconcileStock(actorOf(req)) })) },
    {
      method: 'post', path: '/stock/issue', summary: 'Issue stock to a department or student', permission: 'inventory.issue_stock', ownership: 'none', rateLimit: 'money',
      schemas: { body: issueStockBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof issueStockBody }>(req); return okBody(await inventory.issueStock(actorOf(req), body)); }),
      errors: ['INSUFFICIENT_STOCK'],
    },
    {
      method: 'post', path: '/stock/adjust', summary: 'Record a manual stock adjustment', permission: 'inventory.adjust_stock', ownership: 'none', rateLimit: 'money',
      schemas: { body: adjustStockBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof adjustStockBody }>(req); return okBody(await inventory.adjustStock(actorOf(req), body)); }),
      errors: ['INSUFFICIENT_STOCK'],
    },

    /* ---------------- purchase orders ---------------- */
    {
      method: 'get', path: '/purchase-orders', summary: 'List purchase orders', permission: 'inventory.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: poListQuery },
      handler: handler(async (req) => {
        const { query } = validated<{ query: typeof poListQuery }>(req);
        return okBody(await inventory.listPurchaseOrders(actorOf(req), { status: query.status, supplierId: query.supplierId }, { limit: query.limit, cursorId: query.cursor }));
      }),
    },
    {
      method: 'get', path: '/purchase-orders/:id', summary: 'Get a purchase order with its lines and receipt progress', permission: 'inventory.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await inventory.getPurchaseOrder(actorOf(req), params.id)); }),
    },
    {
      method: 'post', path: '/purchase-orders', summary: 'Create a draft purchase order', permission: 'inventory.manage_purchase_orders', ownership: 'none', rateLimit: 'money',
      schemas: { body: createPoBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof createPoBody }>(req); return created(await inventory.createPurchaseOrder(actorOf(req), body)); }),
    },
    {
      method: 'post', path: '/purchase-orders/:id/mark-ordered', summary: 'Move a draft purchase order to ordered', permission: 'inventory.manage_purchase_orders', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await inventory.markOrdered(actorOf(req), params.id)); }),
      errors: ['ILLEGAL_PO_TRANSITION'],
    },
    {
      method: 'post', path: '/purchase-orders/:id/cancel', summary: 'Cancel a purchase order that has not been received', permission: 'inventory.manage_purchase_orders', ownership: 'none', rateLimit: 'money',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await inventory.cancelPurchaseOrder(actorOf(req), params.id)); }),
      errors: ['ILLEGAL_PO_TRANSITION', 'PO_PARTIALLY_RECEIVED'],
    },
    {
      method: 'post', path: '/purchase-orders/:id/receive', summary: 'Receive a purchase order, fully or partially', permission: 'inventory.receive_purchase_order', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: receivePoBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof receivePoBody }>(req); return okBody(await inventory.receivePurchaseOrder(actorOf(req), params.id, body)); }),
      errors: ['PO_NOT_ORDERED', 'OVER_RECEIPT', 'PARTIAL_RECEIVING_DISABLED', 'INSUFFICIENT_STOCK'],
    },
  ];
}
