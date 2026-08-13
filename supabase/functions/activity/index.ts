// 활동 상세 (랩 + 데이터 추이) — intervals.icu 를 대신 불러다 준다.
//
// 왜 프록시인가: intervals.icu API 키는 서버 전용이라 브라우저에 내려보낼 수 없다.
// 또 스트림 원본은 활동 하나에 300KB 를 넘어서 DB 에 쌓기엔 과하다 — 볼 때만 가져온다.
//
// 배포: npx supabase functions deploy activity

import { Unauthorized, whoIs } from '../_shared/auth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/** 차트에 그릴 점 개수. 3958 포인트를 그대로 보내면 payload 만 커지고 화면은 그대로다. */
const MAX_POINTS = 700

/** 6.png 의 토글과 같은 항목들 + 지도용 좌표 + 재생 중 "지금까지 몇 km" 를 위한 거리 */
const STREAM_TYPES = [
  'time',
  'heartrate',
  'velocity_smooth',
  'cadence',
  'watts',
  'vertical_ratio',
  'latlng',
  'distance',
] as const

/**
 * 지도 선을 그릴 좌표 개수. 초당 1점이라 1시간이면 3600점인데 그걸 다 보낼 필요는 없다.
 * 다만 너무 줄이면 확대했을 때 코너가 잘려 보인다 — 2000점이면 대략 10m 간격이라 괜찮다.
 */
const MAX_ROUTE_POINTS = 2000

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

    whoIs(req) // 게이트웨이가 검증한 JWT — 신원만 확인하고 데이터는 계정 하나뿐이라 그대로 쓴다

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

    // 랩·경로 모두 "경과 시간(초)" 으로 맞춰 준다 — 그래야 화면에서 지도·그래프·랩이 같이 움직인다.
    // 기준은 원본 time 스트림. 랩의 start_index/end_index 가 이 배열의 인덱스다.
    const rawTime = pickStream(stRes, 'time')

    return json({
      ok: true,
      lthr: detail?.lthr ?? null,
      maxHr: detail?.max_hr ?? detail?.icu_max_hr ?? null,
      laps: (ivRes?.icu_intervals ?? []).map((l: Record<string, unknown>, i: number) => toLap(l, i, rawTime)),
      streams: toStreams(stRes),
      ...toRoute(stRes, rawTime),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[activity] 실패:', message)
    return json({ ok: false, error: message }, e instanceof Unauthorized ? 401 : 500)
  }
})

interface Lap {
  index: number
  type: string
  /** intervals.icu 가 묶어준 반복 그룹 (같은 값 = 같은 세트). 워밍업/반복/회복 구분에 쓴다 */
  groupId: string | null
  label: string | null
  /** 이 랩이 시작·끝난 **경과 시간(초)**. 재생 커서와 맞추는 데 쓴다 */
  startT: number
  endT: number
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

function toLap(l: Record<string, unknown>, i: number, time: number[]): Lap {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  // 인덱스 → 경과 시간. 스트림이 없으면 인덱스를 초로 쓴다 (1Hz 기록이라 거의 같다)
  const at = (idx: unknown) => {
    const n = num(idx)
    if (n == null) return null
    return time.length ? (time[Math.min(Math.max(0, Math.round(n)), time.length - 1)] ?? n) : n
  }
  return {
    index: i + 1,
    type: String(l.type ?? ''),
    groupId: (l.group_id as string) ?? null,
    label: (l.label as string) ?? null,
    startT: at(l.start_index) ?? 0,
    endT: at(l.end_index) ?? 0,
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
    // latlng 은 시계열이 아니라 좌표다 — toRoute 가 따로 처리한다
    if (t && t !== 'latlng' && Array.isArray(d)) byType.set(t, d)
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

/** 스트림 하나의 원본 숫자 배열. 없으면 빈 배열. */
function pickStream(raw: unknown, type: string): number[] {
  if (!Array.isArray(raw)) return []
  const s = raw.find((x) => (x as { type?: string })?.type === type) as { data?: unknown[] } | undefined
  if (!Array.isArray(s?.data)) return []
  return s.data.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
}

/**
 * GPS 경로. intervals.icu 의 latlng 스트림은 위도가 `data`, 경도가 `data2` 로 따로 온다.
 *
 * 점을 솎아낼 때 평균이 아니라 **건너뛰기**를 쓴다 — 좌표는 평균 내면 코너가 잘려
 * 실제로 지나지 않은 곳을 가로지르는 선이 된다. 마지막 점은 항상 남겨 경로가 중간에 끊기지 않게 한다.
 * 소수점 5자리 ≈ 1m — 화면에 그리기엔 충분하고 전송량은 절반이 된다.
 *
 * 각 점의 **경과 시간(routeT)** 도 같이 준다 — 재생할 때 "지금 어디쯤" 을 찍으려면 필요하다.
 */
function toRoute(raw: unknown, time: number[]): { route: [number, number][]; routeT: number[] } {
  const empty = { route: [] as [number, number][], routeT: [] as number[] }
  if (!Array.isArray(raw)) return empty
  const s = raw.find((x) => (x as { type?: string })?.type === 'latlng') as
    | { data?: unknown[]; data2?: unknown[] }
    | undefined
  const lat = s?.data
  const lng = s?.data2
  if (!Array.isArray(lat) || !Array.isArray(lng)) return empty

  const len = Math.min(lat.length, lng.length)
  const step = Math.max(1, Math.ceil(len / MAX_ROUTE_POINTS))
  const route: [number, number][] = []
  const routeT: number[] = []
  const push = (i: number) => {
    const a = lat[i]
    const b = lng[i]
    // GPS 가 끊긴 구간은 null 또는 정확히 0,0 (기니만 앞바다) 으로 온다
    if (typeof a !== 'number' || typeof b !== 'number') return
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return
    route.push([Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5])
    routeT.push(time[i] ?? i)
  }
  for (let i = 0; i < len; i += step) push(i)
  if ((len - 1) % step !== 0) push(len - 1)
  return { route, routeT }
}
