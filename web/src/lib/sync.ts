// intervals.icu + 구글 캘린더 동기화 호출.
//
// 실제 동기화는 Supabase Edge Function(`supabase/functions/sync`)에서 돈다.
// 예전엔 PC 에서 띄우는 로컬 서버(`/api/sync/intervals`)에 붙어 있어서 개발 중에만 동작했다 —
// 배포된 웹·모바일·데스크톱 exe 에서는 `/api` 가 없어 쓸 수 없었다. 이제 어디서 열든 같은 함수를 부른다.
//
// 인증은 로그인 세션의 JWT 로 자동으로 붙는다(supabase-js 가 처리) → 내 데이터만 동기화된다.

import { supabase } from './supabase'

export type SyncResult = { activities: number; wellness: number; races: number; events: number; full: boolean }

export async function runIntervalsSync(opts: { full?: boolean } = {}): Promise<SyncResult> {
  const { data, error } = await supabase.functions.invoke<SyncResult & { ok: boolean; error?: string }>('sync', {
    body: { full: !!opts.full },
  })

  if (error) throw new Error(await readFunctionError(error))
  if (!data?.ok) throw new Error(data?.error || '동기화에 실패했습니다.')
  return data
}

/**
 * FunctionsHttpError 는 메시지가 "Edge Function returned a non-2xx status code" 뿐이라
 * 무엇이 잘못됐는지 알 수 없다. 실제 원인은 응답 본문에 있으므로 꺼내 쓴다.
 */
async function readFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json()
      if (body?.error) return String(body.error)
    } catch {
      /* JSON 이 아니면 아래 기본 메시지로 */
    }
    if (ctx.status === 404) return '동기화 함수가 아직 배포되지 않았습니다 (npx supabase functions deploy sync).'
    if (ctx.status === 401) return '로그인이 만료된 것 같습니다. 다시 로그인해 주세요.'
  }
  return error instanceof Error ? error.message : '동기화에 실패했습니다.'
}
