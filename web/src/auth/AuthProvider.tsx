import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface AuthState {
  session: Session | null
  loading: boolean
}

const AuthContext = createContext<AuthState>({ session: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  // Electron 딥링크(privateplanner://auth?code=...)로 돌아온 매직링크를 세션으로 교환
  useEffect(() => {
    const bridge = window.desktop
    if (!bridge?.onAuthCallback) return
    bridge.onAuthCallback((url) => {
      try {
        const code = new URL(url).searchParams.get('code')
        if (code) void supabase.auth.exchangeCodeForSession(code)
      } catch (err) {
        console.error('딥링크 로그인 처리 실패:', err)
      }
    })
  }, [])

  return <AuthContext.Provider value={{ session, loading }}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
