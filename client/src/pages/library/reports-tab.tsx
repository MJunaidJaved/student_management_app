import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import type { BookIssueListItem } from './types'

// Raw repository row (snake_case), not a mapped view — another
// found-not-fixed inconsistency in this endpoint.
type MostBorrowedItem = { book_id: string; title: string; accession_no: string; times_issued: number }

export function ReportsTab() {
  const overdue = useApiQuery<{ overdue: BookIssueListItem[] }>(['library', 'overdue'], '/reports/library/overdue')
  const mostBorrowed = useApiQuery<{ books: MostBorrowedItem[] }>(['library', 'most-borrowed'], '/reports/library/most-borrowed')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Overdue Books</CardTitle>
        </CardHeader>
        {overdue.isLoading ? (
          <PageLoading />
        ) : overdue.isError ? (
          <ErrorState description="Could not load the overdue report." />
        ) : !overdue.data || overdue.data.overdue.length === 0 ? (
          <EmptyState title="No books are currently overdue" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Book</Th>
                <Th>Borrower Type</Th>
                <Th>Due Date</Th>
              </Tr>
            </Thead>
            <Tbody>
              {overdue.data.overdue.map((it) => (
                <Tr key={it.id}>
                  <Td className="font-medium text-ink">
                    {it.title} <span className="text-xs text-ink-subtle">({it.accessionNo})</span>
                  </Td>
                  <Td className="capitalize">{it.borrowerType}</Td>
                  <Td>{it.dueDate}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Most Borrowed Books</CardTitle>
        </CardHeader>
        {mostBorrowed.isLoading ? (
          <PageLoading />
        ) : mostBorrowed.isError ? (
          <ErrorState description="Could not load the report." />
        ) : !mostBorrowed.data || mostBorrowed.data.books.length === 0 ? (
          <EmptyState title="No borrowing history yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Book</Th>
                <Th>Times Borrowed</Th>
              </Tr>
            </Thead>
            <Tbody>
              {mostBorrowed.data.books.map((b) => (
                <Tr key={b.book_id}>
                  <Td className="font-medium text-ink">
                    {b.title} <span className="text-xs text-ink-subtle">({b.accession_no})</span>
                  </Td>
                  <Td>{b.times_issued}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
