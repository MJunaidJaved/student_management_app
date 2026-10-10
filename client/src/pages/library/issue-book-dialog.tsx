import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { EntitySearchBox } from '@/components/entity-search-box'
import type { BookListItem, BorrowerType } from './types'

type SearchStudent = { id: string; admissionNo: string; firstName: string; lastName: string | null }
type SearchStaff = { id: string; employeeNo: string; fullName: string }

export function IssueBookDialog({ book, onClose }: { book: BookListItem; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [borrowerType, setBorrowerType] = useState<BorrowerType>('student')
  const [student, setStudent] = useState<SearchStudent | null>(null)
  const [staff, setStaff] = useState<SearchStaff | null>(null)

  const borrowerId = borrowerType === 'student' ? student?.id : staff?.id

  const issue = useMutation({
    mutationFn: async () => apiClient.post('/book-issues', { bookId: book.id, borrowerType, borrowerId }),
    onSuccess: () => {
      show('success', 'Book issued')
      queryClient.invalidateQueries({ queryKey: ['library', 'books'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title={`Issue — ${book.title}`} size="sm">
      <div className="space-y-4">
        <div className="flex gap-1">
          <Button type="button" size="sm" variant={borrowerType === 'student' ? 'primary' : 'outline'} onClick={() => setBorrowerType('student')}>
            Student
          </Button>
          <Button type="button" size="sm" variant={borrowerType === 'staff' ? 'primary' : 'outline'} onClick={() => setBorrowerType('staff')}>
            Staff
          </Button>
        </div>

        {borrowerType === 'student' ? (
          <EntitySearchBox<SearchStudent>
            endpoint="/search"
            resultsKey="students"
            placeholder="Search by admission no, name, or phone…"
            onSelect={setStudent}
            renderResult={(s) => (
              <div className="flex items-center justify-between">
                <span className="text-ink">
                  {s.firstName} {s.lastName ?? ''}
                </span>
                <span className="text-xs text-ink-subtle">{s.admissionNo}</span>
              </div>
            )}
          />
        ) : (
          <EntitySearchBox<SearchStaff>
            endpoint="/staff-search"
            resultsKey="staff"
            placeholder="Search by employee no, name, or phone…"
            onSelect={setStaff}
            renderResult={(s) => (
              <div className="flex items-center justify-between">
                <span className="text-ink">{s.fullName}</span>
                <span className="text-xs text-ink-subtle">{s.employeeNo}</span>
              </div>
            )}
          />
        )}

        {borrowerType === 'student' && student && (
          <p className="text-xs text-ink-muted">
            {student.firstName} {student.lastName ?? ''} ({student.admissionNo})
          </p>
        )}
        {borrowerType === 'staff' && staff && (
          <p className="text-xs text-ink-muted">
            {staff.fullName} ({staff.employeeNo})
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={issue.isPending} disabled={!borrowerId} onClick={() => issue.mutate()}>
            Issue Book
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
