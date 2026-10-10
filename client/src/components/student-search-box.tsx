import { useNavigate } from 'react-router-dom'
import { EntitySearchBox } from './entity-search-box'

type SearchStudent = { id: string; admissionNo: string; firstName: string; lastName: string | null }

export function StudentSearchBox() {
  const navigate = useNavigate()
  return (
    <EntitySearchBox<SearchStudent>
      endpoint="/search"
      resultsKey="students"
      placeholder="Search by admission no, name, or phone…"
      onSelect={(s) => navigate(`/students/${s.id}`)}
      renderResult={(s) => (
        <div className="flex items-center justify-between">
          <span className="text-ink">
            {s.firstName} {s.lastName ?? ''}
          </span>
          <span className="text-xs text-ink-subtle">{s.admissionNo}</span>
        </div>
      )}
    />
  )
}
