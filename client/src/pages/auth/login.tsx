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
    <div className="flex min-h-screen bg-canvas">
      <aside className="relative hidden w-[46%] max-w-[640px] flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 px-12 py-10 text-white lg:flex">
        {/* Concentric rings echo the crest. */}
        <div className="pointer-events-none absolute -bottom-40 -right-40 size-[520px] rounded-full border border-white/[0.07]" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 size-[380px] rounded-full border border-white/[0.07]" />
        <div className="pointer-events-none absolute -bottom-8 -right-8 size-[240px] rounded-full bg-school-sky/10 blur-2xl" />

        <div className="relative flex items-center gap-2 text-sm font-semibold text-brand-200">
          <span className="size-1.5 rounded-full bg-school-sky" />
          School Management Portal
        </div>

        <div className="relative">
          <div className="size-36 overflow-hidden rounded-full bg-white shadow-2xl ring-[6px] ring-white/10">
            <SchoolLogo className="size-full" />
          </div>
          <h1 className="mt-8 text-[40px] font-bold leading-[1.1] tracking-tight">{SCHOOL.name}</h1>
          <p className="mt-2 text-lg text-brand-200">{SCHOOL.location}</p>
          <div className="mt-8 flex items-center gap-3">
            <span className="h-px w-10 bg-laurel" />
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-laurel-soft">{SCHOOL.motto}</p>
          </div>
        </div>

        <div className="relative">
          <div className="brand-ribbon mb-4 h-1 w-24 rounded-full" />
          <p className="text-xs text-brand-300">© {new Date().getFullYear()} {SCHOOL.name}. All rights reserved.</p>
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center lg:hidden">
            <SchoolLogo className="size-24 rounded-full" />
            <p className="mt-3 text-lg font-bold text-brand-500">{SCHOOL.name}</p>
            <p className="text-sm text-ink-muted">{SCHOOL.location}</p>
          </div>

          <h2 className="text-[28px] font-bold tracking-tight text-ink">Welcome back</h2>
          <p className="mt-1.5 text-sm text-ink-muted">Sign in with the account issued to you by the school office.</p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
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
              <p className="rounded-lg border border-danger-500/20 bg-danger-50 px-3 py-2 text-sm text-danger-600">{serverError}</p>
            )}

            <Button type="submit" size="lg" className="w-full justify-center" loading={isSubmitting}>
              Sign in
            </Button>
          </form>

          <p className="mt-10 text-center text-xs text-ink-subtle lg:hidden">{SCHOOL.motto}</p>
        </div>
      </main>
    </div>
  )
}
