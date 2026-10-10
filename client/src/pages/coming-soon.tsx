import { Construction } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'

export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Construction className="size-10 text-ink-subtle" />
        <p className="text-sm font-medium text-ink">This screen hasn't been built yet</p>
        <p className="max-w-sm text-xs text-ink-muted">
          The {title.toLowerCase()} module exists on the backend and is reachable here in navigation, but its
          screens haven't been implemented in this pass.
        </p>
      </Card>
    </div>
  )
}
