import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth, apiErrorMessage } from '@/lib/auth-context'
import { SCHOOL } from '@/lib/school'
import { SchoolLogo } from '@/components/school-logo'
import { Button } from '@/components/ui/button'
import { Input, Label, FieldError } from '@/components/ui/input'

const APP_NAME = 'School portal'

const schema = z.object({
  username: z.string().min(1, 'Required'),
  password: z.string().min(1, 'Required'),
})
type FormValues = z.infer<typeof schema>

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  async function onSubmit(values: FormValues) {
    setServerError(null)
    try {
      await login(values.username, values.password)
      const from = (location.state as { from?: Location })?.from?.pathname ?? '/'
      navigate(from, { replace: true })
    } catch (err) {
      setServerError(apiErrorMessage(err).message)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-muted px-4 py-10">
      <div className="w-full max-w-[360px]">
        <div className="mb-6 flex items-center gap-3">
          <SchoolLogo className="size-11 rounded-full bg-white" />
          <div className="leading-tight">
            <p className="text-[15px] font-semibold text-ink">{SCHOOL.name}</p>
            <p className="text-[13px] text-ink-muted">{APP_NAME}</p>
          </div>
        </div>

        <div className="rounded-card border border-border bg-surface p-6">
          <h1 className="text-[17px] font-semibold text-ink">Sign in</h1>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-5 space-y-4">
            <div>
              <Label htmlFor="username">Username</Label>
              <Input id="username" autoComplete="username" autoFocus {...register('username')} />
              <FieldError>{errors.username?.message}</FieldError>
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
              <FieldError>{errors.password?.message}</FieldError>
            </div>

            {serverError && <p className="rounded-md bg-coral-soft px-3 py-2 text-[13px] text-danger-600">{serverError}</p>}

            <Button type="submit" className="w-full justify-center" loading={isSubmitting}>
              Sign in
            </Button>
          </form>
        </div>

        <p className="mt-4 text-[12.5px] text-ink-subtle">Forgot your password? Ask the school office to reset it.</p>
      </div>
    </div>
  )
}
