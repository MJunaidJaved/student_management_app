import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Envelope } from '@/types/api'

type CursorPage<TItem> = { items: TItem[]; nextCursor: string | null; hasMore: boolean }

/**
 * Drives a cursor-paginated list endpoint of the shape every list route in
 * this backend returns: `{ items, nextCursor, hasMore }` inside `data`.
 * Keeps a stack of cursors so "Previous" is possible even though the API
 * only ever hands back the next one.
 */
export function useCursorList<TItem>(
  key: readonly unknown[],
  path: string,
  params: Record<string, string | number | undefined>,
  limit = 20,
) {
  const [cursorStack, setCursorStack] = useState<string[]>([]) // cursors for pages already seen
  const cursor = cursorStack[cursorStack.length - 1]

  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v))
  }
  search.set('limit', String(limit))
  if (cursor) search.set('cursor', cursor)

  const query = useQuery<CursorPage<TItem>>({
    queryKey: [...key, params, cursor, limit],
    queryFn: async () => {
      const res = await apiClient.get<Envelope<CursorPage<TItem>>>(`${path}?${search.toString()}`)
      return res.data.data
    },
    placeholderData: keepPreviousData,
  })

  function nextPage() {
    if (query.data?.nextCursor) setCursorStack((s) => [...s, query.data!.nextCursor!])
  }
  function prevPage() {
    setCursorStack((s) => s.slice(0, -1))
  }
  function reset() {
    setCursorStack([])
  }

  return {
    ...query,
    nextPage,
    prevPage,
    reset,
    page: cursorStack.length + 1,
    hasPrev: cursorStack.length > 0,
    hasNext: !!query.data?.hasMore,
  }
}
