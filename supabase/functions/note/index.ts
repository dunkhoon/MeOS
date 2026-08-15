// 외부 AI 에이전트(OpenClaw 등)용 창구.
//
//   GET  /note?id=<활동id>   → 그 훈련을 분석하는 데 필요한 자료 (요약 + 랩)
//   GET  /note?recent=1      → 최근 활동 목록 (어떤 걸 분석할지 고를 때)
//   POST /note {id, content} → AI 코멘트 저장 → MeOS 훈련 상세에 표시된다
//
// 왜 이 방향인가: 집 PC 의 OpenClaw 를 인터넷에 열지 않아도 된다. **바깥에서 안으로**
// 들어갈 필요 없이, OpenClaw 가 밖으로 호출하기만 하면 된다 (공유기 포트포워딩·터널 불필요).
//
// 인증은 사용자 JWT 가 아니라 **공유 토큰**(MEOS_NOTE_TOKEN)이다 — 에이전트에는 사람 세션이 없다.
//   npx supabase secrets set MEOS_NOTE_TOKEN=<충분히 긴 임의 문자열>
// 그래서 이 함수만 verify_jwt = false 로 두고, 토큰 검사를 직접 한다.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NOTE_TOKEN = Deno.env.get('MEOS_NOTE_TOKEN') ?? ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-meos-token, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    if (!NOTE_TOKEN) return json({ ok: false, error: 'MEOS_NOTE_TOKEN 시크릿이 설정되지 않았습니다.' }, 500)

    // Authorization: Bearer <token> 또는 x-meos-token 헤더 — 둘 다 받는다 (도구마다 편한 게 다르다)
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const given = req.headers.get('x-meos-token')?.trim() || bearer
    if (!given || !timingSafeEqual(given, NOTE_TOKEN)) return json({ ok: false, error: 'UNAUTHORIZED' }, 401)

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const userId = await firstUserId(admin)
    const url = new URL(req.url)

    if (req.method === 'GET') {
      if (url.searchParams.get('recent')) return json({ ok: true, activities: await recentActivities(admin, userId) })
      const id = url.searchParams.get('id') ?? ''
      if (!id) return json({ ok: false, error: 'id 또는 recent=1 이 필요합니다.' }, 400)
      return json({ ok: true, ...(await context(admin, userId, id)) })
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const id = String(body?.id ?? '').trim()
      const content = String(body?.content ?? '').trim()
      if (!id || !content) return json({ ok: false, error: 'id 와 content 가 필요합니다.' }, 400)
      if (content.length > 20000) return json({ ok: false, error: 'content 가 너무 깁니다 (2만자 제한).' }, 400)

      const { error } = await admin.from('activity_notes').upsert(
        {
          user_id: userId,
          external_id: id,
          source: String(body?.source ?? 'openclaw').slice(0, 32),
          content,
          model: body?.model ? String(body.model).slice(0, 120) : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,external_id,source' },
      )
      if (error) throw new Error(error.message)
      return json({ ok: true, saved: id })
    }

    return json({ ok: false, error: 'GET 또는 POST 만 지원합니다.' }, 405)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[note] 실패:', message)
    return json({ ok: false, error: message }, 500)
  }
})

/** 길이가 달라도 같은 시간을 쓰도록 — 토큰을 한 글자씩 떠보는 공격 방지. */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/**
 * 어느 사용자의 데이터를 볼 것인가.
 *
 * ⚠️ "1인용 앱이니 첫 사용자" 로 집으면 안 된다. 실제로 계정이 둘이 되는 일이 있었고
 *    (앱은 A, 잘못된 동기화가 B 로 들어감), `listUsers(1건)` 이 데이터가 거의 없는 쪽을
 *    집어서 이 함수가 엉뚱한 활동 목록을 내주고 있었다.
 *
 * 그래서 **실제로 기록이 쌓이는 쪽**을 데이터에서 고른다:
 *   MEOS_USER_ID 시크릿 → 가장 최근 활동의 주인 → 첫 사용자
 */
const FORCED_USER_ID = Deno.env.get('MEOS_USER_ID')?.trim() ?? ''

async function firstUserId(admin: SupabaseClient): Promise<string> {
  if (FORCED_USER_ID) return FORCED_USER_ID

  const { data: act } = await admin
    .from('activities')
    .select('user_id')
    .order('start_date_local', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (act?.user_id) return act.user_id as string

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error) throw new Error(`사용자 조회 실패: ${error.message}`)
  const id = data?.users?.[0]?.id
  if (!id) throw new Error('가입된 사용자가 없습니다.')
  return id
}

async function recentActivities(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin
    .from('activities')
    .select('external_id, name, type, session_kind, start_date_local, distance_m, moving_time_s, average_hr, max_hr, training_load')
    .eq('user_id', userId)
    .order('start_date_local', { ascending: false })
    .limit(20)
  if (error) throw new Error(error.message)
  return data ?? []
}

/** 분석에 필요한 만큼만 — 스트림 원본은 너무 커서 넘기지 않고 랩까지만 준다. */
async function context(admin: SupabaseClient, userId: string, id: string) {
  const { data: act, error } = await admin
    .from('activities')
    .select(
      'external_id, name, type, session_kind, start_date_local, distance_m, moving_time_s, average_hr, max_hr, calories, training_load, hr_zone_times',
    )
    .eq('user_id', userId)
    .eq('external_id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!act) return { activity: null, laps: [], note: null, error: '해당 활동이 없습니다.' }

  const apiKey = Deno.env.get('INTERVALS_API_KEY')
  let laps: unknown[] = []
  let lthr: number | null = null
  if (apiKey) {
    const auth = 'Basic ' + btoa(`API_KEY:${apiKey}`)
    const get = async (p: string) => {
      const r = await fetch(`https://intervals.icu/api/v1${p}`, { headers: { Authorization: auth } })
      return r.ok ? r.json() : null
    }
    const [detail, iv] = await Promise.all([get(`/activity/${id}`), get(`/activity/${id}/intervals`)])
    lthr = detail?.lthr ?? null
    laps = (iv?.icu_intervals ?? []).map((l: Record<string, unknown>, i: number) => ({
      n: i + 1,
      type: l.type,
      sec: l.moving_time,
      m: l.distance,
      avgHr: l.average_heartrate,
      maxHr: l.max_heartrate,
      minHr: l.min_heartrate,
      cadence: l.average_cadence,
    }))
  }

  const { data: note } = await admin
    .from('activity_notes')
    .select('source, content, model, updated_at')
    .eq('user_id', userId)
    .eq('external_id', id)
    .maybeSingle()

  return { activity: act, lthr, laps, note: note ?? null }
}
