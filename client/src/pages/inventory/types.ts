export type ItemCategoryView = { id: string; name: string }
export type ItemView = { id: string; sku: string; name: string; categoryId: string; categoryName: string; unit: string; reorderLevel: string; stockQuantity: string }
export type SupplierView = { id: string; name: string; phone: string | null; email: string | null; address: string | null; taxNo: string | null }

export type PoStatus = 'draft' | 'ordered' | 'received' | 'cancelled'
export type PurchaseOrderView = { id: string; poNo: string; supplierId: string; orderDate: string; status: PoStatus; total: string; createdBy: string | null }
export type PurchaseOrderLine = { id: string; itemId: string; itemName: string; sku: string; quantity: string; unitCost: string; received: string }
export type PurchaseOrderDetail = PurchaseOrderView & { items: PurchaseOrderLine[] }

export type StockMovementView = {
  id: string
  itemId: string
  type: 'in' | 'out' | 'adjustment'
  quantity: string
  referenceType: string | null
  referenceId: string | null
  movedBy: string | null
  movedAt: string
}
