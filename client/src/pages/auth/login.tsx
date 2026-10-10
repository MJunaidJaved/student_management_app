import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate, useLocation } from 'react-router-dom'
import { GraduationCap } from 'lucide-react'
import { useAuth, apiErrorMessage } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { Input, Label, FieldError } from '@/components/ui/input'

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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 p-4">
      <div className="w-full max-w-sm rounded-card bg-surface p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-500 text-white">
            <GraduationCap className="size-6" />
          </div>
          <h1 className="text-lg font-semibold text-ink">Sign in to SchoolSMS</h1>
          <p className="mt-1 text-sm text-ink-muted">Use the account your school administrator gave you.</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

          {serverError && (
            <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-600">{serverError}</p>
          )}

          <Button type="submit" className="w-full justify-center" loading={isSubmitting}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  )
}
