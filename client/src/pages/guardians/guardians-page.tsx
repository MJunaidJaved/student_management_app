import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient } from '@/lib/api-client'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { Envelope } from '@/types/api'
import { CreateGuardianDialog } from './create-guardian-dialog'

type GuardianView = { id: string; fullName: string; nationalId: string | null; phone: string; email: string | null; occupation: string | null; address: string | null }

export function GuardiansPage() {
  const { hasPermission } = useAuth()
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const guardians = useQuery({
    queryKey: ['guardians', 'search', q],
    queryFn: async () => {
      if (!q.trim()) return { guardians: [] as GuardianView[] }
      const res = await apiClient.get<Envelope<{ guardians: GuardianView[] }>>(`/guardians/search?q=${encodeURIComponent(q)}&limit=25`)
      return res.data.data
    },
  })

  return (
    <RequirePermission anyOf={['guardians.search', 'students.read']}>
      <div>
        <PageHeader
          title="Guardians"
          description="Search guardians by name, phone, or national ID."
          actions={
            hasPermission('guardians.create') && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Guardian
              </Button>
            )
          }
        />

        <Card className="mb-4 p-4">
          <Input placeholder="Search by name, phone, or national ID…" value={q} onChange={(e) => setQ(e.target.value)} />
        </Card>

        <Card>
          {!q.trim() ? (
            <EmptyState title="Start typing to search guardians" />
          ) : guardians.isLoading ? (
            <PageLoading />
          ) : guardians.isError ? (
            <ErrorState description="Could not search guardians." />
          ) : guardians.data!.guardians.length === 0 ? (
            <EmptyState title="No guardians found" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>Email</Th>
                  <Th>Occupation</Th>
                </Tr>
              </Thead>
              <Tbody>
                {guardians.data!.guardians.map((g) => (
                  <Tr key={g.id}>
                    <Td className="font-medium text-ink">{g.fullName}</Td>
                    <Td>{g.phone}</Td>
                    <Td>{g.email ?? '—'}</Td>
                    <Td>{g.occupation ?? '—'}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        <p className="mt-3 text-xs text-ink-subtle">
          This backend has no endpoint to look up which students a guardian is linked to — only the reverse (a student's linked guardians, on
          their profile page). Link a guardian to a student from the student's detail page.
        </p>

        {createOpen && <CreateGuardianDialog onCreated={() => setQ((v) => v)} onClose={() => setCreateOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
