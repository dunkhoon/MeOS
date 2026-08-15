// 어시스턴트 창구 — OpenClaw `meos` 채널 플러그인이 쓰는 유일한 진입점.
//
//   GET  /chat?poll=1[&max=N]        → 아직 안 가져간 질문을 집어온다 (집어가며 taken 으로 표시)
//   POST /chat {messageId, content}  → 답을 저장한다 → MeOS 어시스턴트 화면에 바로 뜬다
//   POST /chat {messageId, error}    → 실패를 기록한다 (사용자에게 이유가 보인다)
//   GET  /chat?data=<kind>           → 에이전트 조회 도구용 데이터
//                                      overview | activities | strength | body
//
// 왜 이 방향인가: 집 PC 의 OpenClaw 를 인터넷에 열지 않아도 된다. **바깥에서 안으로**
// 들어갈 필요 없이, OpenClaw 가 밖으로 호출하기만 하면 된다 (포트포워딩·터널 불필요).
//
// 인증은 사용자 JWT 가 아니라 **공유 토큰**(MEOS_NOTE_TOKEN)이다 — 에이전트에는 사람 세션이 없다.
// `note` 함수와 같은 토큰을 쓴다(에이전트 쪽 비밀은 하나로 유지). 그래서 이 함수도
// verify_jwt = false 로 두고 토큰 검사를 직접 한다.

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

    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const given = req.headers.get('x-meos-token')?.trim() || bearer
    if (!given || !timingSafeEqual(given, NOTE_TOKEN)) return json({ ok: false, error: 'UNAUTHORIZED' }, 401)

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const userId = await firstUserId(admin)
    const url = new URL(req.url)

    if (req.method === 'GET') {
      const kind = url.searchParams.get('data')
      if (kind) return json({ ok: true, ...(await readData(admin, userId, kind)) })

      if (url.searchParams.get('poll')) {
        const max = Math.min(10, Math.max(1, Number(url.searchParams.get('max') ?? 5) || 5))
        return json({ ok: true, messages: await takePending(admin, userId, max) })
      }
      return json({ ok: false, error: 'poll=1 또는 data=<kind> 가 필요합니다.' }, 400)
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const messageId = String(body?.messageId ?? '').trim()
      if (!messageId) return json({ ok: false, error: 'messageId 가 필요합니다.' }, 400)

      const failure = body?.error ? String(body.error).slice(0, 2000) : ''
      if (failure) {
        const { error } = await admin
          .from('chat_messages')
          .update({ status: 'error', error: failure, answered_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('id', messageId)
        if (error) throw new Error(error.message)
        return json({ ok: true, failed: messageId })
      }

      const content = String(body?.content ?? '').trim()
      if (!content) return json({ ok: false, error: 'content 또는 error 가 필요합니다.' }, 400)
      if (content.length > 20000) return json({ ok: false, error: 'content 가 너무 깁니다 (2만자 제한).' }, 400)

      // 어느 대화에 달아야 하는지는 질문 행이 안다
      const { data: asked, error: e1 } = await admin
        .from('chat_messages')
        .select('id, thread_id')
        .eq('user_id', userId)
        .eq('id', messageId)
        .maybeSingle()
      if (e1) throw new Error(e1.message)
      if (!asked) return json({ ok: false, error: '해당 메시지가 없습니다.' }, 404)

      const { error: e2 } = await admin.from('chat_messages').insert({
        user_id: userId,
        thread_id: asked.thread_id,
        role: 'assistant',
        content,
        status: 'done',
        model: body?.model ? String(body.model).slice(0, 120) : null,
        answered_at: new Date().toISOString(),
      })
      if (e2) throw new Error(e2.message)

      const { error: e3 } = await admin
        .from('chat_messages')
        .update({ status: 'done', answered_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('id', messageId)
      if (e3) throw new Error(e3.message)

      return json({ ok: true, answered: messageId })
    }

    return json({ ok: false, error: 'GET 또는 POST 만 지원합니다.' }, 405)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[chat] 실패:', message)
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

/** 1인용 앱이라 사용자는 하나다. */
async function firstUserId(admin: SupabaseClient): Promise<string> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error) throw new Error(`사용자 조회 실패: ${error.message}`)
  const id = data?.users?.[0]?.id
  if (!id) throw new Error('가입된 사용자가 없습니다.')
  return id
}

/**
 * 안 가져간 질문을 집어오면서 곧바로 taken 으로 표시한다.
 *
 * ⚠️ 표시를 나중에 하면 폴링 주기가 답변 시간보다 짧을 때 같은 질문을 두 번 답한다.
 *    update ... in (id들) 의 결과로 실제로 잡은 행만 돌려주므로, 폴링이 겹쳐도
 *    한 질문은 한 번만 나간다 (status='pending' 조건이 두 번째 update 를 0행으로 만든다).
 */
async function takePending(admin: SupabaseClient, userId: string, max: number) {
  const { data: rows, error } = await admin
    .from('chat_messages')
    .select('id')
    .eq('user_id', userId)
    .eq('role', 'user')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(max)
  if (error) throw new Error(error.message)
  if (!rows?.length) return []

  const ids = rows.map((r: { id: string }) => r.id)
  const { data: taken, error: e2 } = await admin
    .from('chat_messages')
    .update({ status: 'taken' })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .in('id', ids)
    .select('id, thread_id, content, context, created_at')
  if (e2) throw new Error(e2.message)
  // 지난 대화는 싣지 않는다. OpenClaw 가 thread_id 별로 자기 세션을 들고 있어서
  // 여기서 또 보내면 같은 내용이 두 번 들어간다 (새 대화 = 새 thread = 새 세션).
  return taken ?? []
}

// ── 에이전트 조회 도구용 데이터 ─────────────────────────────
async function readData(admin: SupabaseClient, userId: string, kind: string) {
  const days = 28
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const sinceDay = since.slice(0, 10)

  if (kind === 'activities') {
    const { data, error } = await admin
      .from('activities')
      .select('external_id, name, type, session_kind, start_date_local, distance_m, moving_time_s, average_hr, max_hr, calories, training_load')
      .eq('user_id', userId)
      .order('start_date_local', { ascending: false })
      .limit(30)
    if (error) throw new Error(error.message)
    return { activities: data ?? [] }
  }

  if (kind === 'strength') {
    const { data, error } = await admin
      .from('strength_sessions')
      .select('id, started_at, ended_at, strength_sets(seq, exercise_name, weight_kg, reps, started_at, ended_at, duration_s)')
      .eq('user_id', userId)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(30)
    if (error) throw new Error(error.message)
    return { sessions: data ?? [] }
  }

  if (kind === 'body') {
    const [m, g, n] = await Promise.all([
      admin
        .from('body_measurements')
        .select('measured_at, weight_kg, skeletal_muscle_kg, body_fat_kg, body_fat_pct, bmi, bmr_kcal, inbody_score, visceral_fat_level')
        .eq('user_id', userId)
        .order('measured_at', { ascending: false })
        .limit(24),
      admin
        .from('body_goals')
        .select('metric, target_value, target_date, start_value, start_date')
        .eq('user_id', userId)
        .eq('active', true),
      admin
        .from('nutrition_logs')
        .select('day, kcal, protein_g')
        .eq('user_id', userId)
        .gte('day', sinceDay)
        .order('day', { ascending: false }),
    ])
    return { measurements: m.data ?? [], goals: g.data ?? [], nutrition: n.data ?? [] }
  }

  // overview — 한 번에 큰 그림. 도구를 여러 번 부르지 않아도 대부분의 질문에 답이 된다.
  const [acts, wellness, sessions, meas, goals] = await Promise.all([
    admin
      .from('activities')
      .select('type, start_date_local, distance_m, moving_time_s, calories, training_load')
      .eq('user_id', userId)
      .gte('start_date_local', since),
    admin
      .from('wellness')
      .select('day, ctl, atl, hrv, resting_hr, sleep_secs, sleep_score, weight')
      .eq('user_id', userId)
      .gte('day', sinceDay)
      .order('day', { ascending: false })
      .limit(14),
    admin
      .from('strength_sessions')
      .select('started_at, ended_at, strength_sets(exercise_name, weight_kg, reps, duration_s)')
      .eq('user_id', userId)
      .gte('started_at', since),
    admin
      .from('body_measurements')
      .select('measured_at, weight_kg, skeletal_muscle_kg, body_fat_kg, body_fat_pct, bmr_kcal, inbody_score')
      .eq('user_id', userId)
      .order('measured_at', { ascending: false })
      .limit(6),
    admin
      .from('body_goals')
      .select('metric, target_value, target_date, start_value, start_date')
      .eq('user_id', userId)
      .eq('active', true),
  ])

  const a = acts.data ?? []
  const s = sessions.data ?? []
  const sets = s.flatMap((x: { strength_sets?: unknown[] }) => x.strength_sets ?? []) as {
    exercise_name: string
    weight_kg: number | null
    reps: number | null
  }[]

  return {
    windowDays: days,
    cardio: {
      count: a.length,
      km: round(a.reduce((t: number, x: { distance_m?: number }) => t + (x.distance_m ?? 0), 0) / 1000, 1),
      minutes: Math.round(a.reduce((t: number, x: { moving_time_s?: number }) => t + (x.moving_time_s ?? 0), 0) / 60),
      kcal: a.reduce((t: number, x: { calories?: number }) => t + (x.calories ?? 0), 0),
      byType: countBy(a.map((x: { type?: string }) => x.type ?? 'Other')),
    },
    strength: {
      sessions: s.length,
      sets: sets.length,
      volumeKg: Math.round(sets.reduce((t, x) => t + (x.weight_kg ?? 0) * (x.reps ?? 0), 0)),
      byExercise: countBy(sets.map((x) => x.exercise_name)),
    },
    wellness: wellness.data ?? [],
    measurements: meas.data ?? [],
    goals: goals.data ?? [],
  }
}

function countBy(xs: string[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const x of xs) m[x] = (m[x] ?? 0) + 1
  return m
}

function round(n: number, d: number): number {
  const p = 10 ** d
  return Math.round(n * p) / p
}
