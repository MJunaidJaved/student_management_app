import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/feedback'

/** Generic debounced typeahead against any of this backend's `/search`-shaped endpoints. */
export function EntitySearchBox<TItem extends { id: string }>({
  endpoint,
  placeholder,
  resultsKey = 'items',
  onSelect,
  renderResult,
}: {
  endpoint: string
  placeholder: string
  resultsKey?: string
  onSelect: (item: TItem) => void
  renderResult: (item: TItem) => ReactNode
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<TItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (q.trim().length < 2) {
      setResults(null)
      return
    }
    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await apiClient.get<{ data: Record<string, TItem[]> }>(endpoint, {
          params: { q, limit: 8, typeahead: true },
        })
        setResults(res.data.data[resultsKey] ?? [])
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  return (
    <div className="relative min-w-[260px] flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
      <Input
        placeholder={placeholder}
        className="pl-9"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {loading && <Spinner className="absolute right-3 top-1/2 size-4 -translate-y-1/2" />}

      {open && results && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-card)]">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-muted">No results</p>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-muted"
                onMouseDown={() => onSelect(item)}
              >
                {renderResult(item)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
