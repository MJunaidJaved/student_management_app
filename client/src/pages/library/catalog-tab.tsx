import { useState } from 'react'
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
import type { BookCategoryView, BookListItem } from './types'
import { CreateBookDialog } from './create-book-dialog'
import { IssueBookDialog } from './issue-book-dialog'

export function CatalogTab() {
  const { hasPermission } = useAuth()
  const [categoryId, setCategoryId] = useState('')
  const [q, setQ] = useState('')
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [issueBook, setIssueBook] = useState<BookListItem | null>(null)
  const cursor = cursorStack[cursorStack.length - 1]

  const categories = useApiQuery<{ categories: BookCategoryView[] }>(['library', 'categories'], '/book-categories')

  const books = useQuery({
    queryKey: ['library', 'books', categoryId, q, cursor],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (categoryId) params.set('categoryId', categoryId)
      if (q) params.set('q', q)
      if (cursor) params.set('cursor', cursor)
      const res = await apiClient.get<Envelope<{ books: BookListItem[]; nextCursorId: string | null }>>(`/books?${params.toString()}`)
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
            <Input placeholder="Title, author, accession no…" value={q} onChange={(e) => { setQ(e.target.value); setCursorStack([]) }} />
          </div>
          {hasPermission('library.manage_catalog') && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Add Book
            </Button>
          )}
        </div>
      </Card>

      <Card>
        {books.isLoading ? (
          <PageLoading />
        ) : books.isError ? (
          <ErrorState description="Could not load the catalog." />
        ) : !books.data || books.data.books.length === 0 ? (
          <EmptyState title="No books found" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Title</Th>
                  <Th>Author</Th>
                  <Th>Category</Th>
                  <Th>Copies</Th>
                  <Th>Issued</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {books.data.books.map((b) => {
                  const available = b.copiesTotal - b.issuedCount
                  return (
                    <Tr key={b.id}>
                      <Td className="font-medium text-ink">{b.title}</Td>
                      <Td>{b.author ?? '—'}</Td>
                      <Td>{b.categoryName ?? '—'}</Td>
                      <Td>
                        <Badge tone={available > 0 ? 'success' : 'danger'}>
                          {available}/{b.copiesTotal} available
                        </Badge>
                      </Td>
                      <Td>{b.issuedCount}</Td>
                      <Td>
                        {hasPermission('library.issue') && available > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => setIssueBook(b)}>
                            Issue
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border p-3">
              <Button variant="outline" size="sm" disabled={cursorStack.length === 0} onClick={() => setCursorStack((s) => s.slice(0, -1))}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!books.data.nextCursorId}
                onClick={() => books.data!.nextCursorId && setCursorStack((s) => [...s, books.data!.nextCursorId!])}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      {createOpen && <CreateBookDialog onClose={() => setCreateOpen(false)} />}
      {issueBook && <IssueBookDialog book={issueBook} onClose={() => setIssueBook(null)} />}
    </div>
  )
}
