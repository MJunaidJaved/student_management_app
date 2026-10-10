/**
 * Inventory (Module 11).
 *
 * Stock correctness rests on one rule (Part 9.5): nothing that moves stock
 * runs without first taking `FOR UPDATE` on that item's `item_stock` row,
 * inside the same transaction as the movement it is about to insert and the
 * summary update that follows it. `ItemStockRepository.lockForUpdate` is the
 * only way this service ever reads a quantity it is about to change.
 */

import { transaction, readTransaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ValidationError } from '../../core/errors';
import { Money } from '../../core/money/money';
import { PURCHASE_ORDER_TRANSITIONS, canTransition, type PurchaseOrderStatus } from '../../core/db/enums';
import type { SettingsService } from '../../modules/settings/settings.service';
import {
  ItemCategoryRepository,
  ItemRepository,
  ItemStockRepository,
  StockMovementRepository,
  SupplierRepository,
  PurchaseOrderRepository,
  PurchaseOrderItemRepository,
  type ItemCategoryRow,
  type ItemRow,
  type SupplierRow,
  type PurchaseOrderRow,
} from './inventory.repository';

/* ---------------- views ---------------- */

export type ItemCategoryView = { id: string; name: string };
const toCategoryView = (r: ItemCategoryRow): ItemCategoryView => ({ id: r.id, name: r.name });

export type ItemView = { id: string; sku: string; name: string; categoryId: string; categoryName: string; unit: string; reorderLevel: string; stockQuantity: string };
const toItemView = (r: ItemRow & { category_name: string; stock_quantity: string }): ItemView => ({
  id: r.id, sku: r.sku, name: r.name, categoryId: r.category_id, categoryName: r.category_name, unit: r.unit, reorderLevel: r.reorder_level, stockQuantity: r.stock_quantity,
});

export type SupplierView = { id: string; name: string; phone: string | null; email: string | null; address: string | null; taxNo: string | null };
const toSupplierView = (r: SupplierRow): SupplierView => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address, taxNo: r.tax_no });

export type PurchaseOrderView = { id: string; poNo: string; supplierId: string; orderDate: string; status: string; total: string; createdBy: string | null };
const toPoView = (r: PurchaseOrderRow): PurchaseOrderView => ({ id: r.id, poNo: r.po_no, supplierId: r.supplier_id, orderDate: r.order_date, status: r.status, total: r.total, createdBy: r.created_by });

export class InventoryService {
  constructor(
    private readonly categories: ItemCategoryRepository,
    private readonly items: ItemRepository,
    private readonly stock: ItemStockRepository,
    private readonly movements: StockMovementRepository,
    private readonly suppliers: SupplierRepository,
    private readonly purchaseOrders: PurchaseOrderRepository,
    private readonly purchaseOrderItems: PurchaseOrderItemRepository,
    private readonly settings: SettingsService,
  ) {}

  /* ---------------- categories ---------------- */

  async listCategories(actor: Actor): Promise<ItemCategoryView[]> {
    return readTransaction(actor, async (uow) => (await this.categories.listAll(uow)).map(toCategoryView));
  }

  async createCategory(actor: Actor, input: { name: string }): Promise<ItemCategoryView> {
    return transaction(actor, async (uow) => toCategoryView(await this.categories.create(uow, { name: input.name })));
  }

  /* ---------------- suppliers ---------------- */

  async listSuppliers(actor: Actor): Promise<SupplierView[]> {
    return readTransaction(actor, async (uow) => (await this.suppliers.listAll(uow)).map(toSupplierView));
  }

  async createSupplier(actor: Actor, input: { name: string; phone?: string | undefined; email?: string | undefined; address?: string | undefined; taxNo?: string | undefined }): Promise<SupplierView> {
    return transaction(actor, async (uow) =>
      toSupplierView(await this.suppliers.create(uow, { name: input.name, phone: input.phone ?? null, email: input.email ?? null, address: input.address ?? null, tax_no: input.taxNo ?? null })),
    );
  }

  /* ---------------- items ---------------- */

  async listItems(actor: Actor, filters: { categoryId?: string | undefined; search?: string | undefined }, page: { limit: number; cursorId?: string | undefined }): Promise<{ items: ItemView[]; nextCursorId: string | null }> {
    return readTransaction(actor, async (uow) => {
      const rows = await this.items.listFiltered(uow, filters, page);
      const hasMore = rows.length > page.limit;
      const trimmed = hasMore ? rows.slice(0, page.limit) : rows;
      return { items: trimmed.map(toItemView), nextCursorId: hasMore ? trimmed[trimmed.length - 1]!.id : null };
    });
  }

  async createItem(actor: Actor, input: { sku: string; name: string; categoryId: string; unit: string; reorderLevel: string }): Promise<ItemView> {
    return transaction(actor, async (uow) => {
      const category = await this.categories.getById(uow, input.categoryId);
      const row = await this.items.create(uow, { sku: input.sku, name: input.name, category_id: input.categoryId, unit: input.unit, reorder_level: input.reorderLevel });
      return toItemView({ ...row, category_name: category.name, stock_quantity: '0' });
    });
  }

  async lowStockReport(actor: Actor): Promise<ItemView[]> {
    return readTransaction(actor, async (uow) => (await this.items.lowStock(uow)).map(toItemView));
  }

  async reconcileStock(actor: Actor): Promise<{ itemId: string; cached: string; computed: string }[]> {
    return readTransaction(actor, (uow) => this.stock.reconcile(uow));
  }

  async listMovementsForItem(actor: Actor, itemId: string, page: { limit: number; cursorId?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      await this.items.getById(uow, itemId);
      const rows = await this.movements.listForItem(uow, itemId, page);
      const hasMore = rows.length > page.limit;
      const trimmed = hasMore ? rows.slice(0, page.limit) : rows;
      return { movements: trimmed, nextCursorId: hasMore ? trimmed[trimmed.length - 1]!.id : null };
    });
  }

  /**
   * Apply one signed stock movement: lock the summary row, compute the new
   * quantity, reject it if negative, write the movement, then the summary —
   * in that order, inside the caller's transaction.
   */
  private async applyMovement(
    uow: Uow,
    input: { itemId: string; type: 'in' | 'out' | 'adjustment'; signedQuantity: string; storedQuantity: string; referenceType: string | null; referenceId: string | null; movedBy: string | null },
  ): Promise<void> {
    const locked = await this.stock.lockForUpdate(uow, input.itemId);
    const next = Money.of(locked.quantity).plus(input.signedQuantity);
    if (next.isNegative()) {
      throw new BusinessRuleError('This movement would take stock below zero.', 'INSUFFICIENT_STOCK');
    }
    await this.movements.create(uow, {
      item_id: input.itemId, type: input.type, quantity: input.storedQuantity,
      reference_type: input.referenceType, reference_id: input.referenceId, moved_by: input.movedBy,
    });
    await this.stock.setQuantity(uow, input.itemId, next.toString());
  }

  async issueStock(actor: Actor, input: { itemId: string; quantity: string; referenceType?: string | undefined; referenceId?: string | undefined }): Promise<{ quantity: string }> {
    return transaction(actor, async (uow) => {
      await this.items.getById(uow, input.itemId);
      await this.applyMovement(uow, {
        itemId: input.itemId, type: 'out', signedQuantity: Money.of(input.quantity).negated().toString(), storedQuantity: input.quantity,
        referenceType: input.referenceType ?? null, referenceId: input.referenceId ?? null, movedBy: actor.userId === null ? null : String(actor.userId),
      });
      const row = await this.stock.find(uow, input.itemId);
      return { quantity: row!.quantity };
    });
  }

  /** A manual correction, up or down. `quantityDelta` carries its own sign. */
  async adjustStock(actor: Actor, input: { itemId: string; quantityDelta: string }): Promise<{ quantity: string }> {
    return transaction(actor, async (uow) => {
      await this.items.getById(uow, input.itemId);
      if (Money.of(input.quantityDelta).isZero()) {
        throw new ValidationError('An adjustment must change the quantity by a non-zero amount.', [{ field: 'quantityDelta', message: 'Must not be zero.' }]);
      }
      await this.applyMovement(uow, {
        itemId: input.itemId, type: 'adjustment', signedQuantity: input.quantityDelta, storedQuantity: input.quantityDelta,
        referenceType: null, referenceId: null, movedBy: actor.userId === null ? null : String(actor.userId),
      });
      const row = await this.stock.find(uow, input.itemId);
      return { quantity: row!.quantity };
    });
  }

  /* ---------------- purchase orders ---------------- */

  async listPurchaseOrders(actor: Actor, filters: { status?: string | undefined; supplierId?: string | undefined }, page: { limit: number; cursorId?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      const rows = await this.purchaseOrders.listFiltered(uow, filters, page);
      const hasMore = rows.length > page.limit;
      const trimmed = hasMore ? rows.slice(0, page.limit) : rows;
      return { purchaseOrders: trimmed.map(toPoView), nextCursorId: hasMore ? trimmed[trimmed.length - 1]!.id : null };
    });
  }

  async getPurchaseOrder(actor: Actor, id: string) {
    return readTransaction(actor, async (uow) => {
      const po = await this.purchaseOrders.getById(uow, id);
      const items = await this.purchaseOrderItems.listForPo(uow, id);
      const withReceived: { id: string; itemId: string; itemName: string; sku: string; quantity: string; unitCost: string; received: string }[] = [];
      for (const it of items) {
        withReceived.push({
          id: it.id, itemId: it.item_id, itemName: it.item_name, sku: it.sku, quantity: it.quantity, unitCost: it.unit_cost,
          received: await this.movements.receivedForPoItem(uow, id, it.item_id),
        });
      }
      return { ...toPoView(po), items: withReceived };
    });
  }

  async createPurchaseOrder(actor: Actor, input: { supplierId: string; orderDate: string; items: readonly { itemId: string; quantity: string; unitCost: string }[] }): Promise<PurchaseOrderView> {
    if (input.items.length === 0) {
      throw new ValidationError('A purchase order needs at least one item.', [{ field: 'items', message: 'Must not be empty.' }]);
    }
    return transaction(actor, async (uow) => {
      await this.suppliers.getById(uow, input.supplierId);
      let total = Money.zero();
      for (const it of input.items) {
        await this.items.getById(uow, it.itemId);
        total = total.plus(Money.of(it.quantity).times(it.unitCost));
      }
      const po = await this.purchaseOrders.createWithNumber(uow, {
        supplier_id: input.supplierId, order_date: input.orderDate, total: total.quantize().toString(),
        created_by: actor.userId === null ? null : String(actor.userId),
      });
      await this.purchaseOrderItems.createMany(uow, input.items.map((it) => ({ po_id: po.id, item_id: it.itemId, quantity: it.quantity, unit_cost: it.unitCost })));
      return toPoView(po);
    });
  }

  private async transitionPo(uow: Uow, id: string, to: PurchaseOrderStatus): Promise<PurchaseOrderRow> {
    const po = await this.purchaseOrders.getById(uow, id);
    if (!canTransition(PURCHASE_ORDER_TRANSITIONS, po.status as PurchaseOrderStatus, to)) {
      throw new BusinessRuleError(`A purchase order cannot go from "${po.status}" to "${to}".`, 'ILLEGAL_PO_TRANSITION');
    }
    return po;
  }

  async markOrdered(actor: Actor, id: string): Promise<PurchaseOrderView> {
    return transaction(actor, async (uow) => {
      await this.transitionPo(uow, id, 'ordered');
      return toPoView(await this.purchaseOrders.setStatus(uow, id, 'ordered'));
    });
  }

  async cancelPurchaseOrder(actor: Actor, id: string): Promise<PurchaseOrderView> {
    return transaction(actor, async (uow) => {
      await this.transitionPo(uow, id, 'cancelled');
      const items = await this.purchaseOrderItems.listForPo(uow, id);
      for (const it of items) {
        const received = await this.movements.receivedForPoItem(uow, id, it.item_id);
        if (!Money.of(received).isZero()) {
          throw new BusinessRuleError('This purchase order already has stock received against it and cannot be cancelled.', 'PO_PARTIALLY_RECEIVED');
        }
      }
      return toPoView(await this.purchaseOrders.setStatus(uow, id, 'cancelled'));
    });
  }

  /**
   * Receive some or all of an ordered purchase order. Each line's remaining
   * quantity is `ordered - already received`, the latter derived from past
   * `in` movements against this PO (see the repository header). The order
   * moves to `received` only once every line is fully received; otherwise it
   * stays `ordered` so a later call can receive the rest.
   */
  async receivePurchaseOrder(actor: Actor, id: string, input: { items: readonly { itemId: string; quantity: string }[] }): Promise<PurchaseOrderView & { fullyReceived: boolean }> {
    if (input.items.length === 0) {
      throw new ValidationError('Specify at least one item being received.', [{ field: 'items', message: 'Must not be empty.' }]);
    }
    const allowPartial = await this.settings.getBoolean('inventory.allow_partial_po_receiving');

    return transaction(actor, async (uow) => {
      const po = await this.purchaseOrders.getById(uow, id);
      if (po.status !== 'ordered') {
        throw new BusinessRuleError('Only an ordered purchase order can be received.', 'PO_NOT_ORDERED');
      }
      const lines = await this.purchaseOrderItems.listForPo(uow, id);
      const byItem = new Map(lines.map((l) => [l.item_id, l]));

      for (const incoming of input.items) {
        const line = byItem.get(incoming.itemId);
        if (!line) throw new ValidationError(`Item ${incoming.itemId} is not on this purchase order.`, [{ field: 'items', message: 'Must be a line on this purchase order.' }]);
        const already = Money.of(await this.movements.receivedForPoItem(uow, id, incoming.itemId));
        const remaining = Money.of(line.quantity).minus(already);
        const receiving = Money.of(incoming.quantity);
        if (receiving.isZero() || receiving.isNegative() || receiving.greaterThan(remaining)) {
          throw new BusinessRuleError(`Cannot receive ${incoming.quantity} of item ${incoming.itemId}; ${remaining.toString()} remains on this order.`, 'OVER_RECEIPT');
        }
        if (!allowPartial && receiving.lessThan(remaining)) {
          throw new BusinessRuleError('Partial receiving is disabled; receive the full remaining quantity.', 'PARTIAL_RECEIVING_DISABLED');
        }
        await this.applyMovement(uow, {
          itemId: incoming.itemId, type: 'in', signedQuantity: incoming.quantity, storedQuantity: incoming.quantity,
          referenceType: 'purchase_order', referenceId: id, movedBy: actor.userId === null ? null : String(actor.userId),
        });
      }

      let fullyReceived = true;
      for (const line of lines) {
        const received = Money.of(await this.movements.receivedForPoItem(uow, id, line.item_id));
        if (received.lessThan(line.quantity)) { fullyReceived = false; break; }
      }

      const updated = fullyReceived ? await this.purchaseOrders.setStatus(uow, id, 'received') : po;
      return { ...toPoView(updated), fullyReceived };
    });
  }
}
