import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { Envelope } from '@/types/api'
import { CreateGuardianDialog } from './create-guardian-dialog'

type GuardianView = { id: string; fullName: string; nationalId: string | null; phone: string; email: string | null; occupation: string | null; address: string | null }
type LinkedStudent = { id: string; admissionNo: string; firstName: string; lastName: string | null; relation: string; isPrimary: boolean }

function LinkedStudentsRow({ guardianId }: { guardianId: string }) {
  const navigate = useNavigate()
  const students = useApiQuery<{ students: LinkedStudent[] }>(['guardians', guardianId, 'students'], `/guardians/${guardianId}/students`)

  if (students.isLoading) return <PageLoading />
  if (!students.data || students.data.students.length === 0) return <EmptyState title="Not linked to any student yet" />

  return (
    <div className="p-2">
      <Table>
        <Thead>
          <Tr>
            <Th>Student</Th>
            <Th>Admission No</Th>
            <Th>Relation</Th>
            <Th />
          </Tr>
        </Thead>
        <Tbody>
          {students.data.students.map((s) => (
            <Tr key={s.id}>
              <Td className="font-medium text-ink">
                {s.firstName} {s.lastName ?? ''}
              </Td>
              <Td>{s.admissionNo}</Td>
              <Td className="capitalize">
                {s.relation} {s.isPrimary && '(primary)'}
              </Td>
              <Td>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/students/${s.id}`)}>
                  View Profile →
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </div>
  )
}

export function GuardiansPage() {
  const { hasPermission } = useAuth()
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

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
          description="Search guardians by name, phone, or national ID, and see which students they're linked to."
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
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {guardians.data!.guardians.map((g) => (
                  <Fragment key={g.id}>
                    <Tr>
                      <Td className="font-medium text-ink">{g.fullName}</Td>
                      <Td>{g.phone}</Td>
                      <Td>{g.email ?? '—'}</Td>
                      <Td>{g.occupation ?? '—'}</Td>
                      <Td>
                        <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                          {expanded === g.id ? 'Hide' : 'Linked Students'}
                        </Button>
                      </Td>
                    </Tr>
                    {expanded === g.id && (
                      <Tr>
                        <Td colSpan={5} className="bg-surface-muted/40 p-0">
                          <LinkedStudentsRow guardianId={g.id} />
                        </Td>
                      </Tr>
                    )}
                  </Fragment>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        {createOpen && <CreateGuardianDialog onCreated={(name) => setQ(name)} onClose={() => setCreateOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
