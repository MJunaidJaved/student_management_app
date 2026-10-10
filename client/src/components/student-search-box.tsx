import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/feedback'

type SearchStudent = { id: string; admissionNo: string; firstName: string; lastName: string | null }

/** Debounced, wired to the real /search endpoint (admission no / national id / phone / name). */
export function StudentSearchBox() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchStudent[] | null>(null)
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
        const res = await apiClient.get<{ data: { students: SearchStudent[] } }>('/search', {
          params: { q, limit: 8, typeahead: true },
        })
        setResults(res.data.data.students)
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
  }, [q])

  return (
    <div className="relative min-w-[260px] flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
      <Input
        placeholder="Search by admission no, name, or phone…"
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
            <p className="px-3 py-2 text-sm text-ink-muted">No students found</p>
          ) : (
            results.map((s) => (
              <button
                key={s.id}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-muted"
                onMouseDown={() => navigate(`/students/${s.id}`)}
              >
                <span className="text-ink">
                  {s.firstName} {s.lastName ?? ''}
                </span>
                <span className="text-xs text-ink-subtle">{s.admissionNo}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
