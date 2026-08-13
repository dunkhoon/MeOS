// 활동 상세 — DB 요약(activities) + Edge Function 이 가져다주는 랩/스트림.
//
// 랩과 스트림은 DB 에 넣지 않는다: 활동 하나당 수백 KB 라 쌓기엔 과하고,
// intervals.icu 키는 서버 전용이라 브라우저에서 직접 부를 수도 없다 → 볼 때만 함수로 가져온다.

import { supabase } from './supabase'
import type { Activity } from './exercise'

export interface Lap {
  index: number
  /** WORK / RECOVERY / WARMUP / COOLDOWN … (intervals.icu 원문) */
  type: string
  /** intervals.icu 가 묶어준 반복 그룹 (같은 값 = 같은 세트) */
  groupId: string | null
  label: string | null
  /** 이 랩이 시작·끝난 경과 시간(초). 재생 커서와 맞추는 데 쓴다 */
  startT: number
  endT: number
  movingTime: number
  distance: number
  /** m/s */
  speed: number | null
  avgHr: number | null
  maxHr: number | null
  minHr: number | null
  cadence: number | null
  watts: number | null
}

/** 다운샘플된 시계열. 키는 intervals.icu 스트림 이름. */
export type StreamKey =
  | 'time'
  | 'heartrate'
  | 'velocity_smooth'
  | 'cadence'
  | 'watts'
  | 'altitude'
  | 'distance'
  | 'step_length'
  | 'vertical_oscillation'
  | 'vertical_ratio'
  | 'stance_time'

export type Streams = Partial<Record<StreamKey, (number | null)[]>>

/** GPS 경로 — [위도, 경도] 쌍. 실내 운동이나 GPS 없는 활동은 빈 배열. */
export type Route = [number, number][]

export interface ActivityDetail {
  lthr: number | null
  maxHr: number | null
  laps: Lap[]
  streams: Streams
  route: Route
  /** route 각 점의 경과 시간(초). route 와 길이가 같다. */
  routeT: number[]
}

const ACT_COLS =
  'id, external_id, type, name, start_date_local, distance_m, moving_time_s, average_speed, average_hr, max_hr, calories, training_load, device_name, hr_zone_times, session_kind'

/** 요약은 이미 동기화해 둔 DB 에서 읽는다 (오프라인·모바일에서도 빠르다). */
export async function fetchActivity(externalId: string): Promise<Activity | null> {
  const { data, error } = await supabase.from('activities').select(ACT_COLS).eq('external_id', externalId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Activity) ?? null
}

/**
 * 세션 종류를 수동으로 지정한다. null 을 주면 지정을 지우고 이름 추정으로 돌아간다.
 * 동기화는 upsert 로 지정한 컬럼만 덮으므로 이 값은 다음 동기화에도 살아남는다.
 */
export async function setSessionKind(externalId: string, kind: string | null): Promise<void> {
  const { error } = await supabase.from('activities').update({ session_kind: kind }).eq('external_id', externalId)
  if (error) throw new Error(error.message)
}

/** 랩·스트림은 Edge Function 이 intervals.icu 에서 그때그때 가져온다. */
export async function fetchActivityDetail(externalId: string): Promise<ActivityDetail> {
  const { data, error } = await supabase.functions.invoke<ActivityDetail & { ok: boolean; error?: string }>('activity', {
    body: { id: externalId },
  })
  if (error) throw new Error(await readFunctionError(error))
  if (!data?.ok) throw new Error(data?.error || '상세 정보를 불러오지 못했습니다.')
  return {
    lthr: data.lthr,
    maxHr: data.maxHr,
    laps: data.laps ?? [],
    streams: data.streams ?? {},
    // 함수를 아직 새로 배포하지 않았으면 route 가 없다 — 지도만 빠지고 나머지는 그대로 뜬다
    route: data.route ?? [],
    routeT: data.routeT ?? [],
  }
}

async function readFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json()
      if (body?.error) return String(body.error)
    } catch {
      /* JSON 이 아니면 아래로 */
    }
    if (ctx.status === 404) return '상세 조회 함수가 배포되지 않았습니다 (npx supabase functions deploy activity).'
    if (ctx.status === 401) return '로그인이 만료된 것 같습니다. 다시 로그인해 주세요.'
  }
  return error instanceof Error ? error.message : '상세 정보를 불러오지 못했습니다.'
}

export interface ActivityNote {
  source: string
  content: string
  model: string | null
  updatedAt: string
}

/**
 * 외부 AI 가 남긴 코멘트. Edge Function `note` 로 들어와 DB 에 쌓이고,
 * 여기서는 RLS 로 내 것만 읽는다 (함수를 거칠 필요가 없다).
 */
export async function fetchActivityNotes(externalId: string): Promise<ActivityNote[]> {
  const { data, error } = await supabase
    .from('activity_notes')
    .select('source, content, model, updated_at')
    .eq('external_id', externalId)
    .order('updated_at', { ascending: false })
  // 마이그레이션 전이면 테이블이 없다 — 그것 때문에 화면이 깨지진 않게 한다
  if (error) return []
  return (data ?? []).map((r) => ({
    source: r.source as string,
    content: r.content as string,
    model: (r.model as string) ?? null,
    updatedAt: r.updated_at as string,
  }))
}

// ── 표시용 계산 ──────────────────────────────────────────────

/** m/s → "4:57 /km". 러닝이 아닌 종목이나 정지 구간은 '-'. */
export function paceFromSpeed(speed: number | null | undefined): string {
  if (!speed || speed <= 0.1) return '-'
  const secPerKm = 1000 / speed
  if (!Number.isFinite(secPerKm) || secPerKm > 3600) return '-'
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${String(s === 60 ? 0 : s).padStart(2, '0')}`
}

/** 초 → "49:10" / "1:08:30" */
export function clock(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return '-'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`
}

/** 랩 종류를 한국어 라벨로. intervals.icu 는 WORK/RECOVERY 만 주는 경우가 많다. */
export function lapLabel(lap: Lap): string {
  if (lap.label) return lap.label
  const t = lap.type.toUpperCase()
  if (t.includes('WARM')) return '워밍업'
  if (t.includes('COOL')) return '쿨다운'
  if (t.includes('RECOVER') || t.includes('REST')) return '휴식'
  if (t.includes('WORK')) return '러닝'
  return t || '구간'
}

/** 평균 HR 이 LTHR 의 몇 % 인지 (7.png 의 LTHR% 열). */
export function pct(value: number | null | undefined, base: number | null | undefined): string {
  if (!value || !base) return '-'
  return `${Math.round((value / base) * 100)}%`
}
