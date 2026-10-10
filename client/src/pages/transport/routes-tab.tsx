import { Fragment, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { RouteSheetRow, RouteStopView, RouteView, VehicleView } from './types'

function AddStopForm({ routeId }: { routeId: string }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset } = useForm<{ stopName: string; stopOrder: string; pickupTime: string; monthlyFee: string }>()

  const create = useMutation({
    mutationFn: async (v: { stopName: string; stopOrder: string; pickupTime: string; monthlyFee: string }) =>
      apiClient.post('/route-stops', {
        routeId,
        stopName: v.stopName,
        stopOrder: Number(v.stopOrder),
        pickupTime: v.pickupTime || undefined,
        monthlyFee: v.monthlyFee,
      }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['transport', 'stops', routeId] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
      <div className="min-w-[140px] flex-1">
        <Label>Stop Name</Label>
        <Input {...register('stopName', { required: true })} />
      </div>
      <div>
        <Label>Order</Label>
        <Input type="number" className="w-20" {...register('stopOrder', { required: true })} />
      </div>
      <div>
        <Label>Pickup Time</Label>
        <Input type="time" {...register('pickupTime')} />
      </div>
      <div>
        <Label>Monthly Fee</Label>
        <Input type="number" step="0.01" className="w-28" {...register('monthlyFee', { required: true })} />
      </div>
      <Button type="submit" size="sm" loading={create.isPending}>
        Add Stop
      </Button>
    </form>
  )
}

function RouteExpansion({ route }: { route: RouteView }) {
  const { hasPermission } = useAuth()
  const stops = useApiQuery<{ stops: RouteStopView[] }>(['transport', 'stops', route.id], `/routes/${route.id}/stops`)
  const sheet = useApiQuery<{ sheet: RouteSheetRow[] }>(['transport', 'sheet', route.id], `/routes/${route.id}/sheet`)

  return (
    <div className="space-y-4 p-4">
      {hasPermission('transport.manage_fleet') && <AddStopForm routeId={route.id} />}

      {stops.isLoading ? (
        <PageLoading />
      ) : !stops.data || stops.data.stops.length === 0 ? (
        <EmptyState title="No stops on this route yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Order</Th>
              <Th>Stop</Th>
              <Th>Pickup Time</Th>
              <Th>Monthly Fee</Th>
            </Tr>
          </Thead>
          <Tbody>
            {[...stops.data.stops].sort((a, b) => a.stopOrder - b.stopOrder).map((s) => (
              <Tr key={s.id}>
                <Td>{s.stopOrder}</Td>
                <Td className="font-medium text-ink">{s.stopName}</Td>
                <Td>{s.pickupTime?.slice(0, 5) ?? '—'}</Td>
                <Td>{s.monthlyFee}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Route Sheet (students boarding)</h4>
        {sheet.isLoading ? (
          <PageLoading />
        ) : !sheet.data || sheet.data.sheet.length === 0 ? (
          <EmptyState title="No students allocated to this route yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Stop</Th>
                <Th>Pickup Time</Th>
                <Th>Student</Th>
                <Th>Admission No</Th>
              </Tr>
            </Thead>
            <Tbody>
              {sheet.data.sheet.map((r, i) => (
                <Tr key={`${r.stop_id}-${i}`}>
                  <Td>{r.stop_name}</Td>
                  <Td>{r.pickup_time?.slice(0, 5) ?? '—'}</Td>
                  <Td className="font-medium text-ink">{r.student_name}</Td>
                  <Td>{r.admission_no}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  )
}

function CreateRouteDialogInline({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const vehicles = useApiQuery<{ vehicles: VehicleView[] }>(['transport', 'vehicles'], '/vehicles')
  const { register, handleSubmit } = useForm<{ name: string; vehicleId: string }>()

  const create = useMutation({
    mutationFn: async (v: { name: string; vehicleId: string }) => apiClient.post('/routes', { name: v.name, vehicleId: v.vehicleId || undefined }),
    onSuccess: () => {
      show('success', 'Route created')
      queryClient.invalidateQueries({ queryKey: ['transport', 'routes'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
      <div className="min-w-[160px] flex-1">
        <Label>Route Name</Label>
        <Input {...register('name', { required: true })} />
      </div>
      <div>
        <Label>Vehicle (optional)</Label>
        <Select {...register('vehicleId')}>
          <option value="">None</option>
          {vehicles.data?.vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.regNo}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" loading={create.isPending}>
        Create
      </Button>
      <Button type="button" variant="outline" onClick={onClose}>
        Cancel
      </Button>
    </form>
  )
}

export function RoutesTab() {
  const { hasPermission } = useAuth()
  const [createOpen, setCreateOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const routes = useApiQuery<{ routes: RouteView[] }>(['transport', 'routes'], '/routes')
  const vehicles = useApiQuery<{ vehicles: VehicleView[] }>(['transport', 'vehicles'], '/vehicles')
  const vehicleReg = (id: string | null) => (id ? vehicles.data?.vehicles.find((v) => v.id === id)?.regNo ?? id : '—')

  return (
    <div>
      {hasPermission('transport.manage_fleet') && !createOpen && (
        <div className="mb-4">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New Route
          </Button>
        </div>
      )}
      {createOpen && <CreateRouteDialogInline onClose={() => setCreateOpen(false)} />}

      <Card>
        {routes.isLoading ? (
          <PageLoading />
        ) : !routes.data || routes.data.routes.length === 0 ? (
          <EmptyState title="No routes yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Vehicle</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {routes.data.routes.map((r) => (
                <Fragment key={r.id}>
                  <Tr>
                    <Td className="font-medium text-ink">{r.name}</Td>
                    <Td>{vehicleReg(r.vehicleId)}</Td>
                    <Td>
                      <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                        {expanded === r.id ? 'Hide' : 'Stops & Sheet'}
                      </Button>
                    </Td>
                  </Tr>
                  {expanded === r.id && (
                    <Tr>
                      <Td colSpan={3} className="bg-surface-muted/40 p-0">
                        <RouteExpansion route={r} />
                      </Td>
                    </Tr>
                  )}
                </Fragment>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
