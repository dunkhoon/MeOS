// intervals.icu → Supabase 동기화 코어 로직 (CLI와 로컬 동기화 서버가 공용)
// 이후 이 로직을 Supabase Edge Function(cron)으로 이식 예정.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// .env.local 간단 파서 (dotenv 미사용)
function loadEnv() {
  const env = {}
  try {
    const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].trim()
    }
  } catch {
    // .env.local 없으면 process.env 만 사용
  }
  return { ...env, ...process.env }
}

// intervals.icu 데이터를 Supabase 에 upsert. log(msg) 로 진행 상황 통지, 결과 카운트 반환.
export async function runSync(log = () => {}) {
  const env = loadEnv()
  const SUPABASE_URL = env.VITE_SUPABASE_URL
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
  const ATHLETE = env.INTERVALS_ATHLETE_ID
  const API_KEY = env.INTERVALS_API_KEY
  const ACTIVITY_DAYS = Number(env.ACTIVITY_DAYS || 1830)
  const WELLNESS_DAYS = Number(env.WELLNESS_DAYS || 400)

  const required = {
    VITE_SUPABASE_URL: SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    INTERVALS_ATHLETE_ID: ATHLETE,
    INTERVALS_API_KEY: API_KEY,
  }
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw new Error(`.env.local 에 ${k} 가 없습니다.`)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const ymd = (d) => d.toISOString().slice(0, 10)
  const now = new Date()
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000)
  const oldestActivity = daysAgo(ACTIVITY_DAYS)
  const oldestWellness = daysAgo(WELLNESS_DAYS)
  const authHeader = 'Basic ' + Buffer.from(`API_KEY:${API_KEY}`).toString('base64')

  async function icu(pathname) {
    const res = await fetch(`https://intervals.icu/api/v1/athlete/${ATHLETE}${pathname}`, {
      headers: { Authorization: authHeader },
    })
    if (!res.ok) throw new Error(`intervals.icu ${pathname} → HTTP ${res.status}`)
    return res.json()
  }

  async function resolveUserId() {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    })
    if (!res.ok) throw new Error(`admin/users → HTTP ${res.status}`)
    const body = await res.json()
    const users = body.users ?? body
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error('가입된 사용자가 없습니다. 먼저 앱에서 로그인하세요.')
    }
    return users[0].id
  }

  const userId = await resolveUserId()
  log('활동 가져오는 중…')

  // ── 활동 ──
  const acts = await icu(`/activities?oldest=${ymd(oldestActivity)}&newest=${ymd(now)}`)
  const activityRows = acts.map((a) => ({
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
  log(`활동 ${activityRows.length}건`)

  // ── 웰니스 ──
  const well = await icu(`/wellness?oldest=${ymd(oldestWellness)}&newest=${ymd(now)}`)
  const wellnessRows = well.map((w) => ({
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
  log(`웰니스 ${wellnessRows.length}일`)

  // ── 대회(races) ──
  const eventsOldest = daysAgo(365)
  const eventsNewest = new Date(now.getTime() + 730 * 86400000)
  const events = await icu(
    `/events?oldest=${ymd(eventsOldest)}&newest=${ymd(eventsNewest)}&category=RACE_A,RACE_B,RACE_C`,
  )
  const raceRows = events
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
  log(`대회 ${raceRows.length}건`)

  // ── 구글 캘린더 (설정된 경우에만) ──
  let googleEvents = 0
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    log('구글 캘린더 가져오는 중…')
    googleEvents = await syncGoogle(supabase, env, userId)
    log(`구글 일정 ${googleEvents}건`)
  }

  await supabase.from('sync_state').upsert(
    {
      user_id: userId,
      source: 'intervals',
      last_synced_at: new Date().toISOString(),
      status: 'ok',
      detail: { activities: activityRows.length, wellness: wellnessRows.length, races: raceRows.length, events: googleEvents },
    },
    { onConflict: 'user_id,source' },
  )

  return { activities: activityRows.length, wellness: wellnessRows.length, races: raceRows.length, events: googleEvents }
}

// ── 구글 캘린더 (읽기 전용) ────────────────────────────────
async function googleAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`google token → HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()).access_token
}

async function syncGoogle(supabase, env, userId) {
  const token = await googleAccessToken(env)
  const auth = { Authorization: `Bearer ${token}` }

  const calRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: auth })
  if (!calRes.ok) throw new Error(`calendarList → HTTP ${calRes.status}: ${(await calRes.text()).slice(0, 300)}`)
  const cals = (await calRes.json()).items || []

  // 이벤트 색상 팔레트 (개별 이벤트 colorId → 배경색)
  let eventColors = {}
  try {
    const colRes = await fetch('https://www.googleapis.com/calendar/v3/colors', { headers: auth })
    if (colRes.ok) eventColors = (await colRes.json()).event || {}
  } catch {
    /* 색상 조회 실패는 무시하고 캘린더 기본색 사용 */
  }

  const now = new Date()
  const timeMin = new Date(now.getTime() - 90 * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + 365 * 86400000).toISOString()

  const rows = []
  for (const cal of cals) {
    const calColor = cal.backgroundColor || null
    let pageToken = ''
    do {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`)
      url.searchParams.set('timeMin', timeMin)
      url.searchParams.set('timeMax', timeMax)
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('orderBy', 'startTime')
      url.searchParams.set('maxResults', '250')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const evRes = await fetch(url, { headers: auth })
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

  // 기존 구글 일정 제거 후 재삽입 (삭제/변경 반영)
  await supabase.from('events').delete().eq('user_id', userId).eq('source', 'google')
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('events').insert(rows.slice(i, i + 500))
    if (error) throw error
  }
  return rows.length
}
