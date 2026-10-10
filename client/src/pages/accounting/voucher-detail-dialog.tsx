import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { VoucherDetail } from './types'

export function VoucherDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const voucher = useApiQuery<VoucherDetail>(['accounting', 'voucher', id], `/vouchers/${id}`)

  const post = useMutation({
    mutationFn: async () => apiClient.post(`/vouchers/${id}/post`),
    onSuccess: () => {
      show('success', 'Voucher posted')
      queryClient.invalidateQueries({ queryKey: ['accounting', 'voucher', id] })
      queryClient.invalidateQueries({ queryKey: ['accounting', 'vouchers'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Voucher" size="md">
      {voucher.isLoading || !voucher.data ? (
        <PageLoading />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-ink">{voucher.data.voucherNo}</p>
              <p className="text-xs text-ink-subtle capitalize">
                {voucher.data.type} — {voucher.data.voucherDate}
              </p>
            </div>
            <Badge tone={statusTone(voucher.data.status)}>{voucher.data.status}</Badge>
          </div>
          {voucher.data.narration && <p className="text-sm text-ink-muted">{voucher.data.narration}</p>}

          <Table>
            <Thead>
              <Tr>
                <Th>Account Head</Th>
                <Th>Debit</Th>
                <Th>Credit</Th>
              </Tr>
            </Thead>
            <Tbody>
              {voucher.data.entries.map((e) => (
                <Tr key={e.id}>
                  <Td>
                    {e.accountHeadCode} — {e.accountHeadName}
                  </Td>
                  <Td>{e.debit}</Td>
                  <Td>{e.credit}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>

          <div className="flex justify-end gap-2 pt-2">
            {voucher.data.status === 'draft' && hasPermission('accounting.post') && (
              <Button loading={post.isPending} onClick={() => post.mutate()}>
                Post Voucher
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
