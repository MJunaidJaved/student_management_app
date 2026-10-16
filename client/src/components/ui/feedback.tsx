import { Loader2, Inbox, AlertTriangle } from 'lucide-react'

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-teal ${className}`} />
}

export function PageLoading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="size-8" />
    </div>
  )
}

export function EmptyState({ title = 'Nothing here yet', description }: { title?: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <Inbox className="size-8 text-ink-subtle" />
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-sm text-xs text-ink-muted">{description}</p>}
    </div>
  )
}

export function ErrorState({ title = 'Something went wrong', description }: { title?: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <AlertTriangle className="size-8 text-coral" />
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-sm text-xs text-ink-muted">{description}</p>}
    </div>
  )
}
