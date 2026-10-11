import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { StudentPicker, type PickableStudent } from '@/components/student-picker'
import { StaffPicker, type PickableStaff } from '@/components/staff-picker'
import type { BookListItem, BorrowerType } from './types'

type SearchStudent = PickableStudent
type SearchStaff = PickableStaff

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

        {borrowerType === 'student' ? <StudentPicker onSelect={setStudent} /> : <StaffPicker onSelect={setStaff} />}

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
