// intervals.icu + 구글 캘린더 → Supabase 동기화 (Edge Function, Deno)
//
// 예전엔 이 로직이 PC 에서 도는 로컬 서버(server/sync-server.mjs)에 있었다. 그래서 PC 를 켜두고
// dev 서버를 띄워야만 동기화가 됐고, 배포된 웹·모바일·exe 에서는 아예 쓸 수 없었다.
// 여기로 옮기면서 (1) 어디서 열든 버튼이 동작하고 (2) cron 으로 PC 가 꺼져 있어도 최신이 된다.
//
// 호출 두 가지:
//   ① 앱에서   — 로그인한 사용자의 JWT → 그 사용자 데이터로 동기화
//   ② cron/CLI — service_role 키 → 세션이 없으므로 데이터에서 대상을 고른다 (resolveUserId 참고)
//
// 배포:  npx supabase functions deploy sync
// 비밀값: npx supabase secrets set INTERVALS_ATHLETE_ID=... (README 참고)
//        SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY 는 자동 주입된다.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { whoIs } from '../_shared/auth.ts'
import { GarminAuthError, GarminClient, type GarminGearStats } from '../_shared/garmin.ts'

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

/**
 * intervals.icu 의 oldest/newest 는 **선수 현지 날짜**로 거르는데, `ymd()` 는 UTC 날짜를 준다.
 *
 * ⚠️ 이 한 칸 차이로 **매일 아침 운동이 안 들어왔다.** KST(+9) 기준 08:10 은 UTC 로
 *    전날 23:10 이라 `newest` 가 어제 날짜가 되고, 그날 06시에 뛴 러닝이 범위 밖으로 떨어진다.
 *    00~09시 사이에 새로고침하면 늘 그랬다.
 *
 * 선수의 시간대를 알 방법이 마땅치 않으므로(활동의 `timezone` 이 null 로 온다)
 * 양쪽으로 하루씩 넓힌다. 어떤 시간대(-12~+14)에서도 오늘이 반드시 들어온다.
 * 조금 더 받아 오지만 upsert 라 중복은 생기지 않는다.
 */
const TZ_SLACK_DAYS = 1
const newestYmd = (now: Date) => ymd(daysFrom(now, TZ_SLACK_DAYS))
const oldestYmd = (now: Date, back: number) => ymd(daysFrom(now, -(back + TZ_SLACK_DAYS)))

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
    const result = await runSync(admin, userId, full, via)
    return json({ ok: true, ...result, via })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[sync] 실패:', message)
    return json({ ok: false, error: message }, 500)
  }
})

/**
 * 누구 데이터를 동기화할지 정한다.
 *
 * 앱에서 부르면 그 사용자의 JWT 가 오므로 **로그인한 계정** 그대로다 — 여기는 문제가 없다.
 * 문제는 세션이 없는 호출(cron·CLI 의 service_role)이다.
 *
 * ⚠️ 예전엔 그때 `listUsers(1건)` 로 "첫 사용자" 를 집었다. 계정이 둘이 되자
 *    (앱은 A 로 쓰는데 B 가 먼저 잡힘) **cron 이 몇 주 동안 B 에 데이터를 쌓았다.**
 *    listUsers 의 순서는 가입 순서도 아니라 어느 쪽이 잡힐지 예측할 수도 없다.
 *    그래서 추측하지 않는다:
 *      MEOS_USER_ID 시크릿 → 가장 최근 활동의 주인(=실제로 쓰는 계정) → 첫 사용자
 */
async function resolveUserId(req: Request, admin: SupabaseClient): Promise<{ userId: string; via: 'jwt' | 'service' }> {
  const who = whoIs(req)
  if (who.via === 'user' && who.userId) return { userId: who.userId, via: 'jwt' }

  const forced = Deno.env.get('MEOS_USER_ID')?.trim()
  if (forced) return { userId: forced, via: 'service' }

  const { data: act } = await admin
    .from('activities')
    .select('user_id')
    .order('start_date_local', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (act?.user_id) return { userId: act.user_id as string, via: 'service' }

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error) throw new Error(`사용자 조회 실패: ${error.message}`)
  const first = data?.users?.[0]
  if (!first) throw new Error('가입된 사용자가 없습니다. 먼저 앱에서 로그인하세요.')
  return { userId: first.id, via: 'service' }
}

async function runSync(supabase: SupabaseClient, userId: string, full: boolean, via: 'jwt' | 'service' = 'jwt') {
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
  const acts = await icu(`/activities?oldest=${oldestYmd(now, win.activities)}&newest=${newestYmd(now)}`)
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
    // intervals.icu 의 external_id 가 Garmin 활동 id 다 — 러닝화 매칭에 쓴다
    garmin_id: a.external_id != null ? String(a.external_id) : null,
    raw: a,
  }))
  if (activityRows.length) {
    const { error } = await supabase.from('activities').upsert(activityRows, { onConflict: 'user_id,external_id' })
    if (error) throw error
  }

  // ── 웰니스 ──
  const well = await icu(`/wellness?oldest=${oldestYmd(now, win.wellness)}&newest=${newestYmd(now)}`)
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

  // ── 훈련 계획 (WORKOUT 이벤트) ──
  //
  // ⚠️ upsert 가 아니라 **창을 지우고 다시 넣는다.** 계획은 옮기고 지우는 일이 잦은데
  //    upsert 만 하면 intervals.icu 에서 지운 계획이 우리 쪽에 영원히 남는다.
  //    (구글 일정도 같은 이유로 같은 방식이다)
  const planFrom = oldestYmd(now, win.activities)
  const planTo = ymd(daysFrom(now, 120)) // 앞으로 넉 달치면 캘린더가 볼 만큼은 된다
  const plans = await icu(`/events?oldest=${planFrom}&newest=${planTo}&category=WORKOUT`)
  const workoutRows = (plans as any[])
    .filter((e) => e.start_date_local)
    .map((e) => ({
      user_id: userId,
      external_id: String(e.id),
      start_date: e.start_date_local.slice(0, 10),
      type: e.type ?? null,
      name: e.name ?? null,
      description: e.description ?? null,
      target_load: e.icu_training_load ?? e.load_target ?? null,
      target_time_s: e.moving_time ?? e.time_target ?? null,
      // 거리 목표가 없는 계획은 0 으로 온다 — 0 은 "목표 없음" 이지 "0km" 가 아니다
      target_distance_m: e.distance || e.distance_target || null,
      // 이 값이 채워지면 계획을 소화한 것이다. 그날 활동이 있느냐와는 다르다.
      paired_activity_id: e.paired_activity_id ? String(e.paired_activity_id) : null,
      workout_doc: e.workout_doc ?? null,
      raw: e,
    }))
  {
    const { error: delErr } = await supabase
      .from('workouts')
      .delete()
      .eq('user_id', userId)
      .gte('start_date', planFrom)
      .lte('start_date', planTo)
    if (delErr) throw delErr
    if (workoutRows.length) {
      const { error } = await supabase.from('workouts').insert(workoutRows)
      if (error) throw error
    }
  }

  // ── 구글 캘린더 (시크릿이 있을 때만) ──
  let googleEvents = 0
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  const refreshToken = Deno.env.get('GOOGLE_REFRESH_TOKEN')
  if (clientId && clientSecret && refreshToken) {
    googleEvents = await syncGoogle(supabase, { clientId, clientSecret, refreshToken }, userId)
  }

  // ── 러닝화 (Garmin) ──
  // intervals.icu 는 gear 를 못 가져와서 Garmin 을 직접 본다. 연동을 안 했으면 조용히 건너뛴다.
  const shoes = await syncShoes(supabase, userId, full || via === 'jwt')

  const detail = {
    activities: activityRows.length,
    wellness: wellnessRows.length,
    races: raceRows.length,
    workouts: workoutRows.length,
    events: googleEvents,
    shoes: shoes.count,
    shoesError: shoes.error,
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

// ── 러닝화 (Garmin) ────────────────────────────────────────
/**
 * Garmin 의 장비 목록·누적거리·활동 매칭을 가져온다.
 *
 * intervals.icu 는 Garmin 에서 FIT 파일만 받아 gear 가 안 넘어온다(개발자 확인, 2026-06).
 * 그래서 Garmin 을 직접 보되, **여기(서버)에서** 보기 때문에 모바일에서도 결과가 보인다.
 *
 * @param force 사용자가 새로고침을 눌렀거나 full 동기화일 때 true.
 *              cron(service)은 30분 안에 이미 돌았으면 건너뛴다 — 비공식 API 라 호출을 아낀다.
 */
async function syncShoes(
  db: SupabaseClient,
  userId: string,
  force: boolean,
): Promise<{ count: number | null; error: string | null }> {
  try {
    if (!force) {
      const { data } = await db
        .from('shoes')
        .select('updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data?.updated_at && Date.now() - Date.parse(data.updated_at) < 30 * 60 * 1000) {
        return { count: null, error: null } // 최근에 돌았다 — 건너뜀
      }
    }

    const garmin = await GarminClient.fromDb(db, userId)
    if (!garmin) return { count: null, error: null } // 연동 안 함

    const gear = await garmin.gear()
    if (!gear.length) return { count: 0, error: null }

    // 신발만. 자전거·심박벨트까지 끌고 오면 화면이 지저분해진다.
    const shoes = gear.filter((g) => /shoe/i.test(g.gearTypeName ?? ''))

    const rows = []
    const links: { user_id: string; shoe_uuid: string; garmin_activity_id: string }[] = []
    for (const g of shoes) {
      // 누적 거리는 Garmin 기준(앱 밖 활동 포함)이라 따로 받아 온다
      const stats = await garmin.gearStats(g.uuid).catch((): GarminGearStats => ({}))
      rows.push({
        user_id: userId,
        uuid: g.uuid,
        name: g.displayName ?? null,
        model: g.customMakeModel ?? null,
        gear_type: g.gearTypeName ?? null,
        status: g.gearStatusName ?? null,
        date_begin: g.dateBegin ? String(g.dateBegin).slice(0, 10) : null,
        total_distance_m: stats.totalDistance ?? null,
        total_activities: stats.totalActivities ?? null,
        raw: g,
        updated_at: new Date().toISOString(),
      })

      const acts = await garmin.gearActivities(g.uuid).catch(() => [])
      for (const a of acts) {
        if (a?.activityId != null) {
          links.push({ user_id: userId, shoe_uuid: g.uuid, garmin_activity_id: String(a.activityId) })
        }
      }
    }

    const { error: se } = await db.from('shoes').upsert(rows, { onConflict: 'user_id,uuid' })
    if (se) throw new Error(se.message)

    // 매칭은 통째로 갈아 끼운다 — Garmin 에서 신발을 바꿔 달면 옛 연결이 남으면 안 된다.
    // 목록을 다 받아온 뒤에 지우므로, 중간에 실패해도 지우기만 하고 끝나는 일은 없다.
    const { error: de } = await db.from('shoe_activities').delete().eq('user_id', userId)
    if (de) throw new Error(de.message)
    for (let i = 0; i < links.length; i += 500) {
      const { error } = await db.from('shoe_activities').insert(links.slice(i, i + 500))
      if (error) throw new Error(error.message)
    }

    return { count: rows.length, error: null }
  } catch (e) {
    // 러닝화가 안 됐다고 운동 동기화 전체를 실패시키지 않는다
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[sync] 러닝화 실패:', msg)
    return { count: null, error: e instanceof GarminAuthError ? msg : `러닝화 동기화 실패: ${msg}` }
  }
}
