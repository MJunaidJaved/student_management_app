import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiClient, apiErrorMessage, refreshAccessToken, registerAuthExpiredHandler, setAccessToken } from './api-client'
import type { CurrentUser } from '@/types/api'

type AuthState = {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  me: CurrentUser | null
}

type AuthContextValue = AuthState & {
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  hasPermission: (code: string) => boolean
  hasAnyPermission: (codes: string[]) => boolean
  refreshMe: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', me: null })

  const loadMe = useCallback(async () => {
    const res = await apiClient.get<{ data: CurrentUser }>('/auth/me')
    setState({ status: 'authenticated', me: res.data.data })
  }, [])

  // On first load there is no access token in memory (a page refresh clears
  // it), but the httpOnly refresh cookie may still be valid — try it once.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Shared, de-duplicated refresh: StrictMode runs this effect twice in dev,
        // and two parallel refreshes would trip the backend's token-reuse detection.
        await refreshAccessToken()
        const me = await apiClient.get<{ data: CurrentUser }>('/auth/me')
        if (!cancelled) setState({ status: 'authenticated', me: me.data.data })
      } catch {
        if (!cancelled) setState({ status: 'unauthenticated', me: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    registerAuthExpiredHandler(() => {
      setState({ status: 'unauthenticated', me: null })
    })
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiClient.post<{ data: { accessToken: string; mustChangePassword: boolean } }>(
      '/auth/login',
      { username, password },
    )
    setAccessToken(res.data.data.accessToken)
    await loadMe()
  }, [loadMe])

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout')
    } catch {
      // Already signed out server-side (expired token, etc.) — proceed anyway.
    }
    setAccessToken(null)
    setState({ status: 'unauthenticated', me: null })
  }, [])

  const permissionSet = useMemo(() => new Set(state.me?.permissions ?? []), [state.me])
  const hasPermission = useCallback((code: string) => permissionSet.has(code), [permissionSet])
  const hasAnyPermission = useCallback((codes: string[]) => codes.some((c) => permissionSet.has(c)), [permissionSet])

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    hasPermission,
    hasAnyPermission,
    refreshMe: loadMe,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export { apiErrorMessage }
