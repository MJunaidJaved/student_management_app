import { useNavigate } from 'react-router-dom'
import { EntitySearchBox } from './entity-search-box'

type SearchStaff = { id: string; employeeNo: string; fullName: string }

export function StaffSearchBox() {
  const navigate = useNavigate()
  return (
    <EntitySearchBox<SearchStaff>
      endpoint="/staff-search"
      resultsKey="staff"
      placeholder="Search by employee no, name, or phone…"
      onSelect={(s) => navigate(`/staff/${s.id}`)}
      renderResult={(s) => (
        <div className="flex items-center justify-between">
          <span className="text-ink">{s.fullName}</span>
          <span className="text-xs text-ink-subtle">{s.employeeNo}</span>
        </div>
      )}
    />
  )
}
