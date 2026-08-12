// intervals.icu + 구글 캘린더 → Supabase 동기화 (Edge Function, Deno)
//
// 예전엔 이 로직이 PC 에서 도는 로컬 서버(server/sync-server.mjs)에 있었다. 그래서 PC 를 켜두고
// dev 서버를 띄워야만 동기화가 됐고, 배포된 웹·모바일·exe 에서는 아예 쓸 수 없었다.
// 여기로 옮기면서 (1) 어디서 열든 버튼이 동작하고 (2) cron 으로 PC 가 꺼져 있어도 최신이 된다.
//
// 호출 두 가지:
//   ① 앱에서   — 로그인한 사용자의 JWT → 그 사용자 데이터로 동기화
//   ② cron/CLI — service_role 키 → 사용자를 특정할 수 없으므로 가입된 첫 사용자로 (1인용 앱)
//
// 배포:  npx supabase functions deploy sync
// 비밀값: npx supabase secrets set INTERVALS_ATHLETE_ID=... (README 참고)
//        SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY 는 자동 주입된다.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { whoIs } from '../_shared/auth.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// 기본은 "최근분만" — cron 이 자주 도는데 매번 5년치를 긁을 이유가 없다.
// 과거 데이터를 처음 채우거나 오래 꺼둔 뒤에는 full 로 부른다.
const WINDOW = {
  recent: { activities: 60, wellness: 60 },
  full: { activities: 1830, wellness: 400 },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysFrom = (base: Date, n: number) => new Date(base.getTime() + n * 86400000)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const url = new URL(req.url)
    // full 은 쿼리스트링·본문 어느 쪽으로 줘도 되게 (cron 은 URL, 앱은 body 를 쓴다)
    let full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true'
    if (!full && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      full = !!body?.full
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const { userId, via } = await resolveUserId(req, admin)
    const result = await runSync(admin, userId, full)
    return json({ ok: true, ...result, via })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[sync] 실패:', message)
    return json({ ok: false, error: message }, 500)
  }
})

/**
 * 누구 데이터를 동기화할지 정한다.
 * 앱에서 부르면 그 사용자의 JWT 가 온다. cron/CLI 는 service_role 키로 오는데 그건 사용자
 * 토큰이 아니므로 가입된 첫 사용자로 넘어간다 (1인용 앱 전제).
 */
async function resolveUserId(req: Request, admin: SupabaseClient): Promise<{ userId: string; via: 'jwt' | 'service' }> {
  const who = whoIs(req)
  if (who.via === 'user' && who.userId) return { userId: who.userId, via: 'jwt' }

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error) throw new Error(`사용자 조회 실패: ${error.message}`)
  const first = data?.users?.[0]
  if (!first) throw new Error('가입된 사용자가 없습니다. 먼저 앱에서 로그인하세요.')
  return { userId: first.id, via: 'service' }
}

async function runSync(supabase: SupabaseClient, userId: string, full: boolean) {
  const athlete = Deno.env.get('INTERVALS_ATHLETE_ID')
  const apiKey = Deno.env.get('INTERVALS_API_KEY')
  if (!athlete || !apiKey) {
    throw new Error('INTERVALS_ATHLETE_ID / INTERVALS_API_KEY 시크릿이 설정되지 않았습니다.')
  }

  const win = full ? WINDOW.full : WINDOW.recent
  const now = new Date()
  const auth = 'Basic ' + btoa(`API_KEY:${apiKey}`) // Deno 에는 Buffer 가 없다

  async function icu(pathname: string) {
    const res = await fetch(`https://intervals.icu/api/v1/athlete/${athlete}${pathname}`, {
      headers: { Authorization: auth },
    })
    if (!res.ok) throw new Error(`intervals.icu ${pathname} → HTTP ${res.status}`)
    return res.json()
  }

  // ── 활동 ──
  const acts = await icu(`/activities?oldest=${ymd(daysFrom(now, -win.activities))}&newest=${ymd(now)}`)
  const activityRows = (acts as any[]).map((a) => ({
    user_id: userId,
    external_id: String(a.id),
    type: a.type ?? null,
    name: a.name ?? null,
    start_date_local: a.start_date_local ?? null,
    distance_m: a.distance ?? a.icu_distance ?? null,
    moving_time_s: a.moving_time ?? null,
    average_speed: a.average_speed ?? null,
    average_hr: a.average_heartrate ?? null,
    max_hr: a.max_heartrate ?? null,
    calories: a.calories ?? null,
    training_load: a.icu_training_load ?? null,
    device_name: a.device_name ?? null,
    hr_zone_times: Array.isArray(a.icu_hr_zone_times) ? a.icu_hr_zone_times : null,
    raw: a,
  }))
  if (activityRows.length) {
    const { error } = await supabase.from('activities').upsert(activityRows, { onConflict: 'user_id,external_id' })
    if (error) throw error
  }

  // ── 웰니스 ──
  const well = await icu(`/wellness?oldest=${ymd(daysFrom(now, -win.wellness))}&newest=${ymd(now)}`)
  const wellnessRows = (well as any[]).map((w) => ({
    user_id: userId,
    day: w.id,
    ctl: w.ctl ?? null,
    atl: w.atl ?? null,
    hrv: w.hrv ?? null,
    resting_hr: w.restingHR ?? null,
    sleep_secs: w.sleepSecs ?? null,
    sleep_score: w.sleepScore ?? null,
    steps: w.steps ?? null,
    weight: w.weight ?? null,
    vo2max: w.vo2max ?? null,
    raw: w,
  }))
  if (wellnessRows.length) {
    const { error } = await supabase.from('wellness').upsert(wellnessRows, { onConflict: 'user_id,day' })
    if (error) throw error
  }

  // ── 대회(races) — 요청 한 번이라 항상 같은 창으로 본다 ──
  const events = await icu(
    `/events?oldest=${ymd(daysFrom(now, -365))}&newest=${ymd(daysFrom(now, 730))}&category=RACE_A,RACE_B,RACE_C`,
  )
  const raceRows = (events as any[])
    .filter((e) => String(e.category ?? '').includes('RACE') && e.start_date_local)
    .map((e) => ({
      user_id: userId,
      external_id: String(e.id),
      category: e.category ?? null,
      name: e.name ?? '(대회)',
      race_date: e.start_date_local.slice(0, 10),
      type: e.type ?? null,
      description: e.description ?? null,
      distance_m: e.distance ?? e.distance_target ?? null,
      moving_time_s: e.moving_time ?? e.time_target ?? null,
      raw: e,
    }))
  if (raceRows.length) {
    const { error } = await supabase.from('races').upsert(raceRows, { onConflict: 'user_id,external_id' })
    if (error) throw error
  }

  // ── 구글 캘린더 (시크릿이 있을 때만) ──
  let googleEvents = 0
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  const refreshToken = Deno.env.get('GOOGLE_REFRESH_TOKEN')
  if (clientId && clientSecret && refreshToken) {
    googleEvents = await syncGoogle(supabase, { clientId, clientSecret, refreshToken }, userId)
  }

  const detail = {
    activities: activityRows.length,
    wellness: wellnessRows.length,
    races: raceRows.length,
    events: googleEvents,
    full,
  }
  await supabase
    .from('sync_state')
    .upsert(
      { user_id: userId, source: 'intervals', last_synced_at: new Date().toISOString(), status: 'ok', detail },
      { onConflict: 'user_id,source' },
    )

  return detail
}

// ── 구글 캘린더 (읽기 전용) ────────────────────────────────
async function googleAccessToken(g: { clientId: string; clientSecret: string; refreshToken: string }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`google token → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).access_token as string
}

async function syncGoogle(
  supabase: SupabaseClient,
  g: { clientId: string; clientSecret: string; refreshToken: string },
  userId: string,
) {
  const token = await googleAccessToken(g)
  const auth = { Authorization: `Bearer ${token}` }

  const calRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: auth })
  if (!calRes.ok) throw new Error(`calendarList → HTTP ${calRes.status}: ${(await calRes.text()).slice(0, 300)}`)
  const cals = (await calRes.json()).items || []

  // 이벤트 색상 팔레트 (개별 이벤트 colorId → 배경색)
  let eventColors: Record<string, { background?: string }> = {}
  try {
    const colRes = await fetch('https://www.googleapis.com/calendar/v3/colors', { headers: auth })
    if (colRes.ok) eventColors = (await colRes.json()).event || {}
  } catch {
    /* 색상 조회 실패는 무시하고 캘린더 기본색 사용 */
  }

  const now = new Date()
  const timeMin = daysFrom(now, -90).toISOString()
  const timeMax = daysFrom(now, 365).toISOString()

  const rows: Record<string, unknown>[] = []
  for (const cal of cals) {
    const calColor = cal.backgroundColor || null
    let pageToken = ''
    do {
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`)
      u.searchParams.set('timeMin', timeMin)
      u.searchParams.set('timeMax', timeMax)
      u.searchParams.set('singleEvents', 'true')
      u.searchParams.set('orderBy', 'startTime')
      u.searchParams.set('maxResults', '250')
      if (pageToken) u.searchParams.set('pageToken', pageToken)
      const evRes = await fetch(u, { headers: auth })
      if (!evRes.ok) throw new Error(`events(${cal.id}) → HTTP ${evRes.status}: ${(await evRes.text()).slice(0, 300)}`)
      const body = await evRes.json()
      for (const e of body.items || []) {
        if (e.status === 'cancelled') continue
        if (e.eventType === 'workingLocation') continue // 근무 위치 이벤트 제외
        const start = e.start?.dateTime || e.start?.date
        if (!start) continue
        rows.push({
          user_id: userId,
          source: 'google',
          external_id: `${cal.id}::${e.id}`,
          title: e.summary || '(제목 없음)',
          start_at: start,
          end_at: e.end?.dateTime || e.end?.date || null,
          all_day: !!(e.start && e.start.date),
          location: e.location || null,
          calendar_id: cal.id,
          color: (e.colorId && eventColors[e.colorId]?.background) || calColor,
          raw: e,
        })
      }
      pageToken = body.nextPageToken || ''
    } while (pageToken)
  }

  // 기존 구글 일정 제거 후 재삽입 (원본에서 삭제/변경된 것을 반영).
  // 지우기 전에 rows 를 다 모아두므로, 중간에 실패해도 삭제만 되고 끝나는 일은 없다.
  const { error: delErr } = await supabase.from('events').delete().eq('user_id', userId).eq('source', 'google')
  if (delErr) throw delErr
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('events').insert(rows.slice(i, i + 500))
    if (error) throw error
  }
  return rows.length
}
