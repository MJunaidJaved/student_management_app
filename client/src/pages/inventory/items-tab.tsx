import { Fragment, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { Envelope } from '@/types/api'
import type { ItemCategoryView, ItemView, StockMovementView } from './types'
import { CreateItemDialog } from './create-item-dialog'
import { StockActionDialog } from './stock-action-dialog'

export function ItemsTab() {
  const { hasPermission } = useAuth()
  const [categoryId, setCategoryId] = useState('')
  const [search, setSearch] = useState('')
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [stockAction, setStockAction] = useState<{ item: ItemView; mode: 'issue' | 'adjust' } | null>(null)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const cursor = cursorStack[cursorStack.length - 1]

  const categories = useApiQuery<{ categories: ItemCategoryView[] }>(['inventory', 'categories'], '/item-categories')

  const items = useQuery({
    queryKey: ['inventory', 'items', categoryId, search, cursor],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (categoryId) params.set('categoryId', categoryId)
      if (search) params.set('search', search)
      if (cursor) params.set('cursor', cursor)
      const res = await apiClient.get<Envelope<{ items: ItemView[]; nextCursorId: string | null }>>(`/items?${params.toString()}`)
      return res.data.data
    },
    placeholderData: keepPreviousData,
  })

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Category</label>
            <Select className="w-44" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setCursorStack([]) }}>
              <option value="">All</option>
              {categories.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="mb-1.5 block text-sm font-medium text-ink">Search</label>
            <Input placeholder="SKU or name…" value={search} onChange={(e) => { setSearch(e.target.value); setCursorStack([]) }} />
          </div>
          {hasPermission('inventory.manage_items') && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New Item
            </Button>
          )}
        </div>
      </Card>

      <Card>
        {items.isLoading ? (
          <PageLoading />
        ) : items.isError ? (
          <ErrorState description="Could not load items." />
        ) : !items.data || items.data.items.length === 0 ? (
          <EmptyState title="No items found" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>SKU</Th>
                  <Th>Name</Th>
                  <Th>Category</Th>
                  <Th>Stock</Th>
                  <Th>Reorder Level</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {items.data.items.map((it) => (
                  <Fragment key={it.id}>
                    <Tr>
                      <Td>{it.sku}</Td>
                      <Td className="font-medium text-ink">{it.name}</Td>
                      <Td>{it.categoryName}</Td>
                      <Td>
                        <Badge tone={Number(it.stockQuantity) <= Number(it.reorderLevel) ? 'danger' : 'success'}>
                          {it.stockQuantity} {it.unit}
                        </Badge>
                      </Td>
                      <Td>{it.reorderLevel}</Td>
                      <Td>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setExpandedItem(expandedItem === it.id ? null : it.id)}>
                            History
                          </Button>
                          {hasPermission('inventory.issue_stock') && (
                            <Button variant="ghost" size="sm" onClick={() => setStockAction({ item: it, mode: 'issue' })}>
                              Issue
                            </Button>
                          )}
                          {hasPermission('inventory.adjust_stock') && (
                            <Button variant="ghost" size="sm" onClick={() => setStockAction({ item: it, mode: 'adjust' })}>
                              Adjust
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                    {expandedItem === it.id && (
                      <Tr>
                        <Td colSpan={6} className="bg-surface-muted/40">
                          <MovementsList itemId={it.id} />
                        </Td>
                      </Tr>
                    )}
                  </Fragment>
                ))}
              </Tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border p-3">
              <Button variant="outline" size="sm" disabled={cursorStack.length === 0} onClick={() => setCursorStack((s) => s.slice(0, -1))}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!items.data.nextCursorId}
                onClick={() => items.data!.nextCursorId && setCursorStack((s) => [...s, items.data!.nextCursorId!])}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      {createOpen && <CreateItemDialog onClose={() => setCreateOpen(false)} />}
      {stockAction && <StockActionDialog item={stockAction.item} mode={stockAction.mode} onClose={() => setStockAction(null)} />}
    </div>
  )
}

function MovementsList({ itemId }: { itemId: string }) {
  const movements = useApiQuery<{ movements: StockMovementView[]; nextCursorId: string | null }>(
    ['inventory', 'movements', itemId],
    `/items/${itemId}/movements`,
  )

  if (movements.isLoading) return <PageLoading />
  if (!movements.data || movements.data.movements.length === 0) return <EmptyState title="No stock movements yet" />

  return (
    <div className="p-2">
      <Table>
        <Thead>
          <Tr>
            <Th>Type</Th>
            <Th>Quantity</Th>
            <Th>Reference</Th>
            <Th>Date</Th>
          </Tr>
        </Thead>
        <Tbody>
          {movements.data.movements.map((m) => (
            <Tr key={m.id}>
              <Td className="capitalize">{m.type}</Td>
              <Td>{m.quantity}</Td>
              <Td>{m.referenceType ?? '—'}</Td>
              <Td>{m.movedAt}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </div>
  )
}
