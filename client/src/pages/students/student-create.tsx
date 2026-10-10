import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { RequirePermission } from '@/components/protected-route'
import type { StudentView } from './types'

const schema = z.object({
  firstName: z.string().min(1, 'Required').max(50),
  lastName: z.string().max(50).optional(),
  gender: z.enum(['male', 'female', 'other']),
  dob: z.string().min(1, 'Required'),
  admissionDate: z.string().min(1, 'Required'),
  nationalId: z.string().max(20).optional(),
  phone: z.string().max(20).optional(),
  address: z.string().max(200).optional(),
  bloodGroup: z.string().optional(),
  religion: z.string().max(30).optional(),
  previousSchool: z.string().max(100).optional(),
})
type FormValues = z.infer<typeof schema>

type DuplicateRow = { id: string; admission_no: string; first_name: string; last_name: string | null; reason: string }
type CreateResponse = { student: StudentView; possibleDuplicates: DuplicateRow[] }

function clean<T extends Record<string, unknown>>(values: T): T {
  const out = {} as T
  for (const [k, v] of Object.entries(values)) {
    ;(out as Record<string, unknown>)[k] = v === '' ? undefined : v
  }
  return out
}

export function StudentCreatePage() {
  const navigate = useNavigate()
  const { show } = useToast()
  const [duplicates, setDuplicates] = useState<DuplicateRow[] | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { gender: 'male' } })

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await apiClient.post<{ data: CreateResponse }>('/students', clean(values))
      return res.data.data
    },
    onSuccess: (data) => {
      if (data.possibleDuplicates.length > 0) {
        setDuplicates(data.possibleDuplicates)
      }
      show('success', `${data.student.firstName} was created (admission no. ${data.student.admissionNo})`)
      navigate(`/students/${data.student.id}`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <RequirePermission anyOf={['students.create']}>
      <div className="mx-auto max-w-2xl">
        <Button variant="ghost" size="sm" onClick={() => navigate('/students')} className="mb-2">
          <ArrowLeft className="size-4" />
          Back to Students
        </Button>
        <PageHeader title="Add Student" description="Creates a new student record directly (a transfer-in)." />

        {duplicates && duplicates.length > 0 && (
          <Card className="mb-4 border-warning-500/40 bg-warning-50 p-4">
            <div className="flex gap-3">
              <AlertTriangle className="size-5 shrink-0 text-warning-600" />
              <div>
                <p className="text-sm font-medium text-ink">Possible duplicate students found</p>
                <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                  {duplicates.map((d) => (
                    <li key={d.id}>
                      {d.first_name} {d.last_name ?? ''} ({d.admission_no}) — {d.reason}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-muted">
                  The student below was still created. Review these records if this may be a duplicate entry.
                </p>
              </div>
            </div>
          </Card>
        )}

        <Card>
          <CardContent>
            <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>First Name</Label>
                  <Input {...register('firstName')} />
                  <FieldError>{errors.firstName?.message}</FieldError>
                </div>
                <div>
                  <Label>Last Name</Label>
                  <Input {...register('lastName')} />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>Gender</Label>
                  <Select {...register('gender')}>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </Select>
                </div>
                <div>
                  <Label>Date of Birth</Label>
                  <Input type="date" {...register('dob')} />
                  <FieldError>{errors.dob?.message}</FieldError>
                </div>
                <div>
                  <Label>Admission Date</Label>
                  <Input type="date" {...register('admissionDate')} />
                  <FieldError>{errors.admissionDate?.message}</FieldError>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Phone</Label>
                  <Input {...register('phone')} />
                </div>
                <div>
                  <Label>National ID</Label>
                  <Input {...register('nationalId')} />
                </div>
              </div>

              <div>
                <Label>Address</Label>
                <Input {...register('address')} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>Blood Group</Label>
                  <Select {...register('bloodGroup')}>
                    <option value="">—</option>
                    {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>Religion</Label>
                  <Input {...register('religion')} />
                </div>
                <div>
                  <Label>Previous School</Label>
                  <Input {...register('previousSchool')} />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => navigate('/students')}>
                  Cancel
                </Button>
                <Button type="submit" loading={mutation.isPending}>
                  Create Student
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </RequirePermission>
  )
}
