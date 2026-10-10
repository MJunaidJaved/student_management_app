import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import type { ComplianceReport } from './types'

export function ComplianceTab() {
  const report = useApiQuery<ComplianceReport>(['transport', 'compliance'], '/reports/transport/compliance')

  if (report.isLoading) return <PageLoading />
  if (report.isError || !report.data) return <ErrorState description="Could not load the compliance report." />

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">Flags drivers and vehicles with a license, insurance, or fitness certificate expiring within {report.data.windowDays} days.</p>

      <Card>
        <CardHeader>
          <CardTitle>Drivers with Expiring Licenses</CardTitle>
        </CardHeader>
        {report.data.driversExpiring.length === 0 ? (
          <EmptyState title="No driver licenses expiring soon" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>License No</Th>
                <Th>Expiry</Th>
              </Tr>
            </Thead>
            <Tbody>
              {report.data.driversExpiring.map((d) => (
                <Tr key={d.id}>
                  <Td className="font-medium text-ink">{d.fullName}</Td>
                  <Td>{d.licenseNo}</Td>
                  <Td>
                    <Badge tone="warning">{d.licenseExpiry}</Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vehicles with Expiring Certificates</CardTitle>
        </CardHeader>
        {report.data.vehiclesExpiring.length === 0 ? (
          <EmptyState title="No vehicle certificates expiring soon" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Reg No</Th>
                <Th>Insurance Expiry</Th>
                <Th>Fitness Expiry</Th>
              </Tr>
            </Thead>
            <Tbody>
              {report.data.vehiclesExpiring.map((v) => (
                <Tr key={v.id}>
                  <Td className="font-medium text-ink">{v.regNo}</Td>
                  <Td>{v.insuranceExpiry ?? '—'}</Td>
                  <Td>{v.fitnessExpiry ?? '—'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
