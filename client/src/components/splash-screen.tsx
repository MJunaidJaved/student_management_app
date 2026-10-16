import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/lib/auth-context'
import { SCHOOL } from '@/lib/school'
import { cn } from '@/lib/utils'
import { SchoolLogo } from './school-logo'

const MIN_VISIBLE_MS = 1400
const FADE_MS = 350

function SplashScreen({ leaving }: { leaving: boolean }) {
  return (
    <div
      className={cn(
        'fixed inset-0 z-[100] flex flex-col items-center justify-center bg-canvas px-6 transition-opacity',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      role="status"
      aria-label={`Loading ${SCHOOL.name}`}
    >
      {/* Mirrors the static .boot-splash in index.html exactly, so the handoff from HTML to React is invisible. */}
      <div className="flex flex-col items-center text-center">
        <SchoolLogo className="size-[132px] rounded-full" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-school-indigo">{SCHOOL.name}</h1>
        <p className="mt-1 text-sm text-ink-muted">{SCHOOL.location}</p>
        <p className="mt-4 text-[13px] text-ink-subtle">{SCHOOL.motto}</p>
      </div>
      <div className="mt-10 h-[3px] w-40 overflow-hidden rounded-full bg-mist">
        <div className="h-full w-2/5 rounded-full bg-school-green" style={{ animation: 'splash-progress 1.1s ease-in-out infinite' }} />
      </div>
    </div>
  )
}

/** Shows the school splash on app open while the session is restored, then fades out. */
export function SplashGate({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const [minElapsed, setMinElapsed] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [])

  const ready = status !== 'loading' && minElapsed

  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(t)
  }, [ready])

  return (
    <>
      {ready && children}
      {!gone && <SplashScreen leaving={ready} />}
    </>
  )
}
