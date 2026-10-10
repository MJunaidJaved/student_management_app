import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Envelope } from '@/types/api'

/** GET `path`, unwrap the envelope, and cache under `key`. */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  options?: { enabled?: boolean } & Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => {
      const res = await apiClient.get<Envelope<T>>(path)
      return res.data.data
    },
    ...options,
  })
}
