// 활동 상세 (랩 + 데이터 추이) — intervals.icu 를 대신 불러다 준다.
//
// 왜 프록시인가: intervals.icu API 키는 서버 전용이라 브라우저에 내려보낼 수 없다.
// 또 스트림 원본은 활동 하나에 300KB 를 넘어서 DB 에 쌓기엔 과하다 — 볼 때만 가져온다.
//
// 배포: npx supabase functions deploy activity

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/** 차트에 그릴 점 개수. 3958 포인트를 그대로 보내면 payload 만 커지고 화면은 그대로다. */
const MAX_POINTS = 700

/** 6.png 의 토글과 같은 항목들 */
const STREAM_TYPES = ['time', 'heartrate', 'velocity_smooth', 'cadence', 'watts', 'vertical_ratio'] as const

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const url = new URL(req.url)
    let id = url.searchParams.get('id') ?? ''
    if (!id && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      id = String(body?.id ?? '')
    }
    if (!/^[\w-]{1,64}$/.test(id)) return json({ ok: false, error: '활동 id 가 올바르지 않습니다.' }, 400)

    await requireUser(req)

    const apiKey = Deno.env.get('INTERVALS_API_KEY')
    if (!apiKey) return json({ ok: false, error: 'intervals.icu 시크릿이 없습니다.' }, 500)
    const auth = 'Basic ' + btoa(`API_KEY:${apiKey}`)

    const icu = async (path: string) => {
      const res = await fetch(`https://intervals.icu/api/v1${path}`, { headers: { Authorization: auth } })
      if (!res.ok) throw new Error(`intervals.icu ${path} → HTTP ${res.status}`)
      return res.json()
    }

    // 랩과 스트림은 서로 무관하니 같이 요청한다. 스트림이 없는 활동(수동 입력 등)도 있어 실패는 삼킨다.
    // 단건 조회는 /activity/{id} 다 — /athlete/{id}/activities/{id} 는 200 을 주지만 빈 객체가 온다.
    const [detail, ivRes, stRes] = await Promise.all([
      icu(`/activity/${id}`).catch(() => null),
      icu(`/activity/${id}/intervals`).catch(() => null),
      icu(`/activity/${id}/streams?types=${STREAM_TYPES.join(',')}`).catch(() => null),
    ])

    return json({
      ok: true,
      lthr: detail?.lthr ?? null,
      maxHr: detail?.max_hr ?? detail?.icu_max_hr ?? null,
      laps: (ivRes?.icu_intervals ?? []).map(toLap),
      streams: toStreams(stRes),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[activity] 실패:', message)
    return json({ ok: false, error: message }, message === 'UNAUTHORIZED' ? 401 : 500)
  }
})

/** JWT 페이로드의 role 만 꺼내 본다 (서명 검증은 게이트웨이가 이미 했다). */
function tokenRole(token: string): string | null {
  try {
    const p = token.split('.')[1]
    if (!p) return null
    const json = atob(p.replace(/-/g, '+').replace(/_/g, '/'))
    return (JSON.parse(json)?.role as string) ?? null
  } catch {
    return null
  }
}

/** 호출자가 로그인한 사용자인지 확인 (데이터는 본인 것뿐이라 신원만 본다). */
async function requireUser(req: Request): Promise<void> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('UNAUTHORIZED')
  // CLI·스크립트는 service_role 로 부른다. 문자열 비교 대신 role 클레임을 보는 게 안전하다
  // (키를 회전해도 동작하고, 공백 하나에 어긋나지 않는다).
  if (token === SERVICE_KEY || tokenRole(token) === 'service_role') return
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('UNAUTHORIZED')
}

interface Lap {
  index: number
  type: string
  /** intervals.icu 가 묶어준 반복 그룹 (같은 값 = 같은 세트). 워밍업/반복/회복 구분에 쓴다 */
  groupId: string | null
  label: string | null
  movingTime: number
  distance: number
  /** m/s — 페이스 계산은 화면에서 */
  speed: number | null
  avgHr: number | null
  maxHr: number | null
  minHr: number | null
  cadence: number | null
  watts: number | null
}

function toLap(l: Record<string, unknown>, i: number): Lap {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    index: i + 1,
    type: String(l.type ?? ''),
    groupId: (l.group_id as string) ?? null,
    label: (l.label as string) ?? null,
    movingTime: num(l.moving_time) ?? 0,
    distance: num(l.distance) ?? 0,
    speed: num(l.average_speed),
    avgHr: num(l.average_heartrate),
    maxHr: num(l.max_heartrate),
    minHr: num(l.min_heartrate),
    cadence: num(l.average_cadence),
    watts: num(l.average_watts),
  }
}

/**
 * 스트림을 화면에서 쓰기 좋은 모양으로 줄인다.
 * 구간 평균으로 다운샘플 — 단순히 건너뛰면 짧은 인터벌 봉우리가 통째로 사라진다.
 */
function toStreams(raw: unknown): Record<string, (number | null)[]> {
  if (!Array.isArray(raw)) return {}
  const byType = new Map<string, unknown[]>()
  for (const s of raw) {
    const t = (s as { type?: string })?.type
    const d = (s as { data?: unknown[] })?.data
    if (t && Array.isArray(d)) byType.set(t, d)
  }
  const len = Math.max(0, ...[...byType.values()].map((d) => d.length))
  if (!len) return {}

  const step = Math.max(1, Math.ceil(len / MAX_POINTS))
  const out: Record<string, (number | null)[]> = {}
  for (const [type, data] of byType) {
    const col: (number | null)[] = []
    for (let i = 0; i < len; i += step) {
      let sum = 0
      let n = 0
      for (let j = i; j < Math.min(i + step, data.length); j++) {
        const v = data[j]
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v
          n++
        }
      }
      // time 은 평균이 아니라 구간 시작값이어야 x축이 단조증가한다
      col.push(n === 0 ? null : type === 'time' ? (data[i] as number) : sum / n)
    }
    out[type] = col
  }
  return out
}
