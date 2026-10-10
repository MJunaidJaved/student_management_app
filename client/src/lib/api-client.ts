import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import type { ApiErrorBody } from '@/types/api'

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1'

// Held in memory only — never localStorage. The refresh token lives in an
// httpOnly cookie the browser manages; this is just the short-lived access
// token the backend hands back from /auth/login and /auth/refresh.
let accessToken: string | null = null
let onAuthExpired: (() => void) | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Registered once by AuthProvider: called when a refresh attempt itself fails. */
export function registerAuthExpiredHandler(handler: () => void): void {
  onAuthExpired = handler
}

export const apiClient = axios.create({
  baseURL: BASE_URL,
  withCredentials: true, // carries the httpOnly refresh cookie
  headers: { 'content-type': 'application/json' },
})

apiClient.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.set('authorization', `Bearer ${accessToken}`)
  }
  return config
})

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean }

let refreshPromise: Promise<string> | null = null

async function refreshAccessToken(): Promise<string> {
  // Multiple requests can 401 at once; only one refresh call should fire.
  if (!refreshPromise) {
    refreshPromise = axios
      .post<{ data: { accessToken: string } }>(
        `${BASE_URL}/auth/refresh`,
        {},
        { withCredentials: true },
      )
      .then((res) => {
        const token = res.data.data.accessToken
        setAccessToken(token)
        return token
      })
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

apiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<ApiErrorBody>) => {
    const config = error.config as RetriableConfig | undefined
    const status = error.response?.status

    const isAuthRoute = config?.url?.includes('/auth/login') || config?.url?.includes('/auth/refresh')

    if (status === 401 && !isAuthRoute && config && !config._retried) {
      config._retried = true
      try {
        const token = await refreshAccessToken()
        config.headers.set('authorization', `Bearer ${token}`)
        return apiClient(config)
      } catch {
        setAccessToken(null)
        onAuthExpired?.()
        return Promise.reject(error)
      }
    }

    // A code our own UI should never see silently: surface it consistently.
    if (status === 401 && !isAuthRoute) {
      setAccessToken(null)
      onAuthExpired?.()
    }

    return Promise.reject(error)
  },
)

/** The message + code a UI component can show directly, from any failed call. */
export function apiErrorMessage(error: unknown): { code: string; message: string; issues?: { field: string; message: string }[] } {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as ApiErrorBody | undefined
    if (body?.error) return body.error
  }
  return { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' }
}
