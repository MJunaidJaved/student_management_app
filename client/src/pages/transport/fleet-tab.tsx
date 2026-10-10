import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { DriverView, VehicleView, VehicleOccupancy } from './types'

function DriversCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const drivers = useApiQuery<{ drivers: DriverView[] }>(['transport', 'drivers'], '/drivers')
  const { register, handleSubmit, reset } = useForm<{ fullName: string; licenseNo: string; licenseExpiry: string; phone: string }>()

  const create = useMutation({
    mutationFn: async (v: { fullName: string; licenseNo: string; licenseExpiry: string; phone: string }) => apiClient.post('/drivers', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['transport', 'drivers'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('transport.manage_fleet')) return drivers.data ? <ReadOnlyDrivers drivers={drivers.data.drivers} /> : null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Drivers</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Full Name</Label>
          <Input {...register('fullName', { required: true })} />
        </div>
        <div>
          <Label>License No</Label>
          <Input {...register('licenseNo', { required: true })} />
        </div>
        <div>
          <Label>License Expiry</Label>
          <Input type="date" {...register('licenseExpiry', { required: true })} />
        </div>
        <div>
          <Label>Phone</Label>
          <Input {...register('phone', { required: true })} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>
      {drivers.isLoading ? <PageLoading /> : !drivers.data || drivers.data.drivers.length === 0 ? <EmptyState title="No drivers yet" /> : <ReadOnlyDrivers drivers={drivers.data.drivers} />}
    </Card>
  )
}

function ReadOnlyDrivers({ drivers }: { drivers: DriverView[] }) {
  return (
    <Table>
      <Thead>
        <Tr>
          <Th>Name</Th>
          <Th>License No</Th>
          <Th>License Expiry</Th>
          <Th>Phone</Th>
        </Tr>
      </Thead>
      <Tbody>
        {drivers.map((d) => (
          <Tr key={d.id}>
            <Td className="font-medium text-ink">{d.fullName}</Td>
            <Td>{d.licenseNo}</Td>
            <Td>{d.licenseExpiry}</Td>
            <Td>{d.phone}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  )
}

function VehicleOccupancyCell({ vehicleId }: { vehicleId: string }) {
  const occ = useApiQuery<VehicleOccupancy>(['transport', 'occupancy', vehicleId], `/vehicles/${vehicleId}/occupancy`)
  if (!occ.data) return <span className="text-ink-subtle">—</span>
  return (
    <Badge tone={occ.data.occupied >= occ.data.capacity ? 'warning' : 'success'}>
      {occ.data.occupied}/{occ.data.capacity}
    </Badge>
  )
}

function VehiclesCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const vehicles = useApiQuery<{ vehicles: VehicleView[] }>(['transport', 'vehicles'], '/vehicles')
  const drivers = useApiQuery<{ drivers: DriverView[] }>(['transport', 'drivers'], '/drivers')
  const { register, handleSubmit, reset } = useForm<{ regNo: string; capacity: string; driverId: string; insuranceExpiry: string; fitnessExpiry: string }>()

  const create = useMutation({
    mutationFn: async (v: { regNo: string; capacity: string; driverId: string; insuranceExpiry: string; fitnessExpiry: string }) =>
      apiClient.post('/vehicles', {
        regNo: v.regNo,
        capacity: Number(v.capacity),
        driverId: v.driverId || undefined,
        insuranceExpiry: v.insuranceExpiry || undefined,
        fitnessExpiry: v.fitnessExpiry || undefined,
      }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['transport', 'vehicles'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const driverName = (id: string | null) => (id ? drivers.data?.drivers.find((d) => d.id === id)?.fullName ?? id : '—')

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Vehicles</h3>
      {hasPermission('transport.manage_fleet') && (
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <Label>Reg No</Label>
            <Input {...register('regNo', { required: true })} />
          </div>
          <div>
            <Label>Capacity</Label>
            <Input type="number" className="w-24" {...register('capacity', { required: true })} />
          </div>
          <div>
            <Label>Driver (optional)</Label>
            <Select {...register('driverId')}>
              <option value="">None</option>
              {drivers.data?.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Insurance Expiry</Label>
            <Input type="date" {...register('insuranceExpiry')} />
          </div>
          <div>
            <Label>Fitness Expiry</Label>
            <Input type="date" {...register('fitnessExpiry')} />
          </div>
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </form>
      )}
      {vehicles.isLoading ? (
        <PageLoading />
      ) : !vehicles.data || vehicles.data.vehicles.length === 0 ? (
        <EmptyState title="No vehicles yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Reg No</Th>
              <Th>Capacity</Th>
              <Th>Occupancy</Th>
              <Th>Driver</Th>
              <Th>Insurance Expiry</Th>
              <Th>Fitness Expiry</Th>
            </Tr>
          </Thead>
          <Tbody>
            {vehicles.data.vehicles.map((v) => (
              <Tr key={v.id}>
                <Td className="font-medium text-ink">{v.regNo}</Td>
                <Td>{v.capacity}</Td>
                <Td>
                  <VehicleOccupancyCell vehicleId={v.id} />
                </Td>
                <Td>{driverName(v.driverId)}</Td>
                <Td>{v.insuranceExpiry ?? '—'}</Td>
                <Td>{v.fitnessExpiry ?? '—'}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

export function FleetTab() {
  return (
    <div className="space-y-4">
      <DriversCard />
      <VehiclesCard />
    </div>
  )
}
