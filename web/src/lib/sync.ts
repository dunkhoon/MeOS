// intervals.icu 동기화 호출.
//
// 동기화는 아직 로컬 전용이다 — 개발 서버(`npm run dev`)가 /api 를 로컬 동기화 서버로
// 프록시할 때만 동작한다. 배포된 웹(Cloudflare)이나 그걸 띄우는 데스크톱 앱·모바일에서는
// /api 가 없어서 SPA 폴백으로 index.html 이 돌아온다 → JSON 파싱 오류로 보이면 헷갈리므로
// 여기서 걸러 "왜 안 되는지" 를 알려준다.
//
// TODO: Supabase Edge Function(cron) 으로 옮기면 어디서나 동작하게 된다 (scripts/sync-core.mjs 주석 참고).

export type SyncResult = { activities: number; wellness: number; races: number }

export class SyncUnavailableError extends Error {
  constructor() {
    super('이 화면에서는 동기화를 실행할 수 없습니다. PC에서 sync-intervals.bat 을 실행하세요.')
    this.name = 'SyncUnavailableError'
  }
}

export async function runIntervalsSync(): Promise<SyncResult> {
  let res: Response
  try {
    res = await fetch('/api/sync/intervals', { method: 'POST' })
  } catch {
    throw new SyncUnavailableError() // 네트워크 자체가 막힘
  }

  // 동기화 서버가 없으면 index.html(HTML)이 200 으로 돌아온다 — 응답 타입으로 판별한다
  if (!(res.headers.get('content-type') || '').includes('json')) throw new SyncUnavailableError()

  const body = (await res.json()) as { ok: boolean; error?: string } & Partial<SyncResult>
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return { activities: body.activities ?? 0, wellness: body.wellness ?? 0, races: body.races ?? 0 }
}
