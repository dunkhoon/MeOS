import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Supabase 환경변수가 없습니다. 저장소 루트 .env.local 의 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 를 확인하세요.',
  )
}

// PKCE 흐름: 매직링크 리다이렉트가 `?code=` 쿼리로 와서 HashRouter(#/)와 충돌하지 않음
export const supabase = createClient(url, anonKey, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
})
