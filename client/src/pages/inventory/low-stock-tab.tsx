import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import type { ItemView } from './types'

export function LowStockTab() {
  const items = useApiQuery<{ items: ItemView[] }>(['inventory', 'low-stock'], '/items/low-stock')

  return (
    <Card>
      {items.isLoading ? (
        <PageLoading />
      ) : items.isError ? (
        <ErrorState description="Could not load the low-stock report." />
      ) : !items.data || items.data.items.length === 0 ? (
        <EmptyState title="Nothing is below its reorder level" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>SKU</Th>
              <Th>Name</Th>
              <Th>Category</Th>
              <Th>Stock</Th>
              <Th>Reorder Level</Th>
            </Tr>
          </Thead>
          <Tbody>
            {items.data.items.map((it) => (
              <Tr key={it.id}>
                <Td>{it.sku}</Td>
                <Td className="font-medium text-ink">{it.name}</Td>
                <Td>{it.categoryName}</Td>
                <Td>
                  <Badge tone="danger">
                    {it.stockQuantity} {it.unit}
                  </Badge>
                </Td>
                <Td>{it.reorderLevel}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}
