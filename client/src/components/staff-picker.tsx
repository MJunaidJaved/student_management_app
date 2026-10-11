import { EntitySearchBox } from './entity-search-box'

export type PickableStaff = { id: string; employeeNo: string; fullName: string }

/** The staff search-and-pick widget used by every dialog that needs to attach a staff member to something (not navigation — see StaffSearchBox for that). */
export function StaffPicker({ onSelect, placeholder }: { onSelect: (s: PickableStaff) => void; placeholder?: string }) {
  return (
    <EntitySearchBox<PickableStaff>
      endpoint="/staff-search"
      resultsKey="staff"
      placeholder={placeholder ?? 'Search by employee no, name, or phone…'}
      onSelect={onSelect}
      renderResult={(s) => (
        <div className="flex items-center justify-between">
          <span className="text-ink">{s.fullName}</span>
          <span className="text-xs text-ink-subtle">{s.employeeNo}</span>
        </div>
      )}
    />
  )
}
