/**
 * Inventory (Module 11) data access.
 *
 * `item_stock` (migration 007) is a cache of `SUM(stock_movements)` per item,
 * maintained in the same transaction as each movement — never read as the
 * authority on its own, and always locked with `FOR UPDATE` before a
 * movement that could take it negative (Part 9.4, Part 9.5). It has no `id`
 * column (`item_id` is its primary key) and no `created_at`, so it does not
 * extend `BaseRepository`.
 *
 * `purchase_order_items` has no "received so far" column — adding one is a
 * schema change outside the approved list. Received quantity per line is
 * instead derived from `stock_movements` rows carrying
 * `reference_type = 'purchase_order'` and `reference_id = <po id>`, which is
 * exactly the ledger Part 9.4 says stock-on-hand must be derived from. The
 * same append-only source answers "how much of this PO has arrived" with no
 * new column.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder, type SortMap } from '../../core/db/query-builder';

/* ------------------------------------------------------------------ *
 * Categories and items
 * ------------------------------------------------------------------ */

export type ItemCategoryRow = BaseRow & { name: string };

export class ItemCategoryRepository extends BaseRepository<ItemCategoryRow> {
  protected readonly table = 'item_categories';
  protected readonly writableColumns = ['name'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'item_categories.name', index: 'item_categories_name_key' } };

  async listAll(uow: Uow): Promise<ItemCategoryRow[]> {
    return uow.many<ItemCategoryRow>(`SELECT * FROM item_categories ORDER BY name`);
  }
}

export type ItemRow = BaseRow & {
  sku: string;
  name: string;
  category_id: string;
  unit: string;
  reorder_level: string;
  deleted_at: string | null;
};

export class ItemRepository extends BaseRepository<ItemRow> {
  protected readonly table = 'items';
  protected readonly writableColumns = ['sku', 'name', 'category_id', 'unit', 'reorder_level'] as const;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'items.name', index: 'items_pkey' } };

  async findBySku(uow: Uow, sku: string): Promise<ItemRow | null> {
    return uow.maybeOne<ItemRow>(`SELECT * FROM items WHERE sku = $1 AND deleted_at IS NULL`, [sku]);
  }

  async listFiltered(
    uow: Uow,
    filters: { categoryId?: string | undefined; search?: string | undefined },
    page: { limit: number; cursorId?: string | undefined },
  ): Promise<(ItemRow & { category_name: string; stock_quantity: string })[]> {
    const where = new ConditionBuilder();
    where.add('i.deleted_at IS NULL');
    where.addIf(filters.categoryId, 'i.category_id = ?', filters.categoryId);
    if (filters.search) {
      const pattern = `%${filters.search}%`;
      where.add('(i.name ILIKE ? OR i.sku ILIKE ?)', pattern, pattern);
    }
    if (page.cursorId) where.add('i.id < ?::bigint', page.cursorId);
    return uow.many(
      `SELECT i.*, c.name AS category_name, COALESCE(st.quantity, 0)::text AS stock_quantity
         FROM items i
         JOIN item_categories c ON c.id = i.category_id
         LEFT JOIN item_stock st ON st.item_id = i.id
        ${where.where()}
        ORDER BY i.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  /** Items at or below their reorder level — the low-stock alert list (Part 5.9). */
  async lowStock(uow: Uow): Promise<(ItemRow & { category_name: string; stock_quantity: string })[]> {
    return uow.many(
      `SELECT i.*, c.name AS category_name, COALESCE(st.quantity, 0)::text AS stock_quantity
         FROM items i
         JOIN item_categories c ON c.id = i.category_id
         LEFT JOIN item_stock st ON st.item_id = i.id
        WHERE i.deleted_at IS NULL AND COALESCE(st.quantity, 0) <= i.reorder_level
        ORDER BY st.quantity ASC NULLS FIRST`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Stock summary and movements
 * ------------------------------------------------------------------ */

export type ItemStockRow = { item_id: string; quantity: string; updated_at: string };

export class ItemStockRepository {
  /** The cached quantity, or null if no movement has ever touched this item. */
  async find(uow: Uow, itemId: string): Promise<ItemStockRow | null> {
    return uow.maybeOne<ItemStockRow>(`SELECT * FROM item_stock WHERE item_id = $1`, [itemId]);
  }

  /**
   * Lock the item's stock row for update, creating it first at zero if this
   * is the item's first-ever movement. The row must exist to be locked, and
   * `ON CONFLICT DO NOTHING` makes creating it idempotent against a
   * concurrent first movement for the same item.
   */
  async lockForUpdate(uow: Uow, itemId: string): Promise<ItemStockRow> {
    await uow.count(`INSERT INTO item_stock (item_id, quantity) VALUES ($1, 0) ON CONFLICT (item_id) DO NOTHING`, [itemId]);
    return uow.one<ItemStockRow>(`SELECT * FROM item_stock WHERE item_id = $1 FOR UPDATE`, [itemId], 'Item');
  }

  async setQuantity(uow: Uow, itemId: string, quantity: string): Promise<ItemStockRow> {
    return uow.one<ItemStockRow>(`UPDATE item_stock SET quantity = $2 WHERE item_id = $1 RETURNING *`, [itemId, quantity], 'Item');
  }

  /** Reconciliation (Part 9.4): compares the cache against the ledger's own sum and reports drift, never overwrites. */
  async reconcile(uow: Uow): Promise<{ itemId: string; cached: string; computed: string }[]> {
    return uow.many(
      `SELECT st.item_id::text AS "itemId", st.quantity::text AS cached,
              COALESCE((SELECT SUM(CASE WHEN m.type = 'out' THEN -m.quantity ELSE m.quantity END) FROM stock_movements m WHERE m.item_id = st.item_id), 0)::text AS computed
         FROM item_stock st
        WHERE st.quantity <> COALESCE((SELECT SUM(CASE WHEN m.type = 'out' THEN -m.quantity ELSE m.quantity END) FROM stock_movements m WHERE m.item_id = st.item_id), 0)`,
    );
  }
}

// This table's actual timestamp column is `moved_at`, not `created_at`/`updated_at`
// (declared via BaseRow only to satisfy BaseRepository's generic constraint —
// those two columns don't exist on `stock_movements` and are never read).
export type StockMovementRow = BaseRow & {
  item_id: string;
  type: string;
  quantity: string;
  reference_type: string | null;
  reference_id: string | null;
  moved_by: string | null;
  moved_at: string;
};

export class StockMovementRepository extends BaseRepository<StockMovementRow> {
  protected readonly table = 'stock_movements';
  protected readonly writableColumns = ['item_id', 'type', 'quantity', 'reference_type', 'reference_id', 'moved_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'stock_movements.id', index: 'stock_movements_pkey' } };

  async listForItem(uow: Uow, itemId: string, page: { limit: number; cursorId?: string | undefined }): Promise<StockMovementRow[]> {
    const where = new ConditionBuilder();
    where.add('item_id = ?', itemId);
    if (page.cursorId) where.add('id < ?::bigint', page.cursorId);
    return uow.many<StockMovementRow>(
      `SELECT * FROM stock_movements ${where.where()} ORDER BY id DESC LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  /** Total received so far against one purchase order's line for an item — the derived "received quantity". */
  async receivedForPoItem(uow: Uow, poId: string, itemId: string): Promise<string> {
    const row = await uow.one<{ total: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS total FROM stock_movements
        WHERE reference_type = 'purchase_order' AND reference_id = $1 AND item_id = $2 AND type = 'in'`,
      [poId, itemId],
    );
    return row.total;
  }
}

/* ------------------------------------------------------------------ *
 * Suppliers and purchase orders
 * ------------------------------------------------------------------ */

export type SupplierRow = BaseRow & {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  tax_no: string | null;
  deleted_at: string | null;
};

export class SupplierRepository extends BaseRepository<SupplierRow> {
  protected readonly table = 'suppliers';
  protected readonly writableColumns = ['name', 'phone', 'email', 'address', 'tax_no'] as const;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'suppliers.name', index: 'suppliers_pkey' } };

  async listAll(uow: Uow): Promise<SupplierRow[]> {
    return uow.many<SupplierRow>(`SELECT * FROM suppliers WHERE deleted_at IS NULL ORDER BY name`);
  }
}

export type PurchaseOrderRow = BaseRow & {
  po_no: string;
  supplier_id: string;
  order_date: string;
  status: string;
  total: string;
  created_by: string | null;
};

export class PurchaseOrderRepository extends BaseRepository<PurchaseOrderRow> {
  protected readonly table = 'purchase_orders';
  // po_no comes from the sequence; status is moved only through setStatus.
  protected readonly writableColumns = ['supplier_id', 'order_date', 'total', 'created_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'purchase_orders.id', index: 'purchase_orders_pkey' } };

  async createWithNumber(uow: Uow, data: { supplier_id: string; order_date: string; total: string; created_by: string | null }): Promise<PurchaseOrderRow> {
    const poNo = await uow.nextSequenceValue('seq_po_no');
    return uow.one<PurchaseOrderRow>(
      `INSERT INTO purchase_orders (po_no, supplier_id, order_date, status, total, created_by)
       VALUES ('PO-' || lpad($1, 6, '0'), $2, $3, 'draft', $4, $5)
       RETURNING *`,
      [poNo, data.supplier_id, data.order_date, data.total, data.created_by],
      'Purchase order',
    );
  }

  async listFiltered(uow: Uow, filters: { status?: string | undefined; supplierId?: string | undefined }, page: { limit: number; cursorId?: string | undefined }): Promise<PurchaseOrderRow[]> {
    const where = new ConditionBuilder();
    where.addIf(filters.status, 'status = ?', filters.status);
    where.addIf(filters.supplierId, 'supplier_id = ?', filters.supplierId);
    if (page.cursorId) where.add('id < ?::bigint', page.cursorId);
    return uow.many<PurchaseOrderRow>(`SELECT * FROM purchase_orders ${where.where()} ORDER BY id DESC LIMIT ${page.limit + 1}`, where.params());
  }

  async setStatus(uow: Uow, id: string, status: string): Promise<PurchaseOrderRow> {
    return uow.one<PurchaseOrderRow>(`UPDATE purchase_orders SET status = $2 WHERE id = $1 RETURNING *`, [id, status], 'Purchase order');
  }
}

export type PurchaseOrderItemRow = BaseRow & { po_id: string; item_id: string; quantity: string; unit_cost: string };

export class PurchaseOrderItemRepository extends BaseRepository<PurchaseOrderItemRow> {
  protected readonly table = 'purchase_order_items';
  protected readonly writableColumns = ['po_id', 'item_id', 'quantity', 'unit_cost'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'purchase_order_items.id', index: 'purchase_order_items_pkey' } };

  async listForPo(uow: Uow, poId: string): Promise<(PurchaseOrderItemRow & { item_name: string; sku: string })[]> {
    return uow.many(
      `SELECT poi.*, i.name AS item_name, i.sku FROM purchase_order_items poi JOIN items i ON i.id = poi.item_id WHERE poi.po_id = $1 ORDER BY poi.id`,
      [poId],
    );
  }
}
