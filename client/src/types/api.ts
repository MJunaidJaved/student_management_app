// Mirrors server/src/core/http/envelope.ts — the one success/error shape
// every endpoint in the backend returns.

export type PageMeta = {
  nextCursor: string | null
  hasMore: boolean
  limit: number
  total?: number
}

export type ResponseMeta = {
  requestId: string
  page?: PageMeta
  lastRefreshedAt?: string
}

export type Envelope<T> = {
  data: T
  meta: ResponseMeta
}

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    issues?: { field: string; message: string }[]
  }
  meta: { requestId: string }
}

export type CurrentUser = {
  user: { id: string; username: string; userType: string; mustChangePassword: boolean }
  roles: { id: string; name: string }[]
  permissions: string[]
}
