import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useStaffLookups } from '@/hooks/use-staff-lookups'
import { RequirePermission } from '@/components/protected-route'
import type { StaffView } from './types'

const schema = z.object({
  fullName: z.string().min(1, 'Required').max(100),
  gender: z.enum(['male', 'female', 'other']),
  dob: z.string().min(1, 'Required'),
  phone: z.string().min(1, 'Required').max(20),
  joinDate: z.string().min(1, 'Required'),
  nationalId: z.string().max(20).optional(),
  email: z.string().email().or(z.literal('')).optional(),
  address: z.string().max(200).optional(),
  departmentId: z.string().optional(),
  designationId: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

function clean<T extends Record<string, unknown>>(values: T): T {
  const out = {} as T
  for (const [k, v] of Object.entries(values)) (out as Record<string, unknown>)[k] = v === '' ? undefined : v
  return out
}

export function StaffCreatePage() {
  const navigate = useNavigate()
  const { show } = useToast()
  const { departments, designations } = useStaffLookups()

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { gender: 'male' } })

  const selectedDept = watch('departmentId')

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await apiClient.post<{ data: StaffView }>('/staff', clean(values))
      return res.data.data
    },
    onSuccess: (staff) => {
      show('success', `${staff.fullName} was added (employee no. ${staff.employeeNo})`)
      navigate(`/staff/${staff.id}`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <RequirePermission anyOf={['staff.create']}>
      <div className="mx-auto max-w-2xl">
        <Button variant="ghost" size="sm" onClick={() => navigate('/staff')} className="mb-2">
          <ArrowLeft className="size-4" />
          Back to Staff
        </Button>
        <PageHeader title="Add Staff" />

        <Card>
          <CardContent>
            <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
              <div>
                <Label>Full Name</Label>
                <Input {...register('fullName')} />
                <FieldError>{errors.fullName?.message}</FieldError>
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
                  <Label>Join Date</Label>
                  <Input type="date" {...register('joinDate')} />
                  <FieldError>{errors.joinDate?.message}</FieldError>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Phone</Label>
                  <Input {...register('phone')} />
                  <FieldError>{errors.phone?.message}</FieldError>
                </div>
                <div>
                  <Label>Email</Label>
                  <Input type="email" {...register('email')} />
                  <FieldError>{errors.email?.message}</FieldError>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>National ID</Label>
                  <Input {...register('nationalId')} />
                </div>
                <div>
                  <Label>Address</Label>
                  <Input {...register('address')} />
                </div>
              </div>

              {departments.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Department</Label>
                    <Select {...register('departmentId')}>
                      <option value="">—</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Designation</Label>
                    <Select {...register('designationId')}>
                      <option value="">—</option>
                      {designations
                        .filter((d) => !selectedDept || d.departmentId === selectedDept)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                    </Select>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => navigate('/staff')}>
                  Cancel
                </Button>
                <Button type="submit" loading={mutation.isPending}>
                  Create Staff
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </RequirePermission>
  )
}
