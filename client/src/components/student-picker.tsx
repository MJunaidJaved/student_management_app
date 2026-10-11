import { EntitySearchBox } from './entity-search-box'

export type PickableStudent = { id: string; admissionNo: string; firstName: string; lastName: string | null }

/** The student search-and-pick widget used by every dialog that needs to attach a student to something (not navigation — see StudentSearchBox for that). */
export function StudentPicker({ onSelect, placeholder }: { onSelect: (s: PickableStudent) => void; placeholder?: string }) {
  return (
    <EntitySearchBox<PickableStudent>
      endpoint="/search"
      resultsKey="students"
      placeholder={placeholder ?? 'Search by admission no, name, or phone…'}
      onSelect={onSelect}
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
