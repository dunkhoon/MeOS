import dayjs from 'dayjs'
import { supabase } from './supabase'
import type { ParsedMeasurement } from './inbody'

// 체형(인바디) · 목표 · 영양 기록의 조회/저장과 파생 계산.

export interface BodyMeasurement {
  id: string
  measured_at: string
  device: string | null
  weight_kg: number | null
  skeletal_muscle_kg: number | null
  muscle_kg: number | null
  body_fat_kg: number | null
  bmi: number | null
  body_fat_pct: number | null
  bmr_kcal: number | null
  inbody_score: number | null
  arm_r_muscle_kg: number | null
  arm_l_muscle_kg: number | null
  trunk_muscle_kg: number | null
  leg_r_muscle_kg: number | null
  leg_l_muscle_kg: number | null
  arm_r_fat_kg: number | null
  arm_l_fat_kg: number | null
  trunk_fat_kg: number | null
  leg_r_fat_kg: number | null
  leg_l_fat_kg: number | null
  whr: number | null
  waist_cm: number | null
  visceral_fat_level: number | null
  body_water_l: number | null
  protein_kg: number | null
  mineral_kg: number | null
  smi: number | null
  phase_angle: number | null
}

export type GoalMetric = 'weight_kg' | 'body_fat_pct' | 'skeletal_muscle_kg'

export interface BodyGoal {
  id: string
  metric: GoalMetric
  target_value: number
  target_date: string
  start_value: number
  start_date: string
  achieved_at: string | null
  active: boolean
}

export interface NutritionLog {
  day: string
  kcal: number | null
  protein_g: number | null
  note: string | null
}

export interface BodySettings {
  height_cm: number | null
  sex: string | null
  birth_year: number | null
  neat_factor: number
}

export const GOAL_METRICS: { key: GoalMetric; label: string; unit: string; color: string; step: number }[] = [
  { key: 'weight_kg', label: '체중', unit: 'kg', color: 'var(--h-blue)', step: 0.5 },
  { key: 'body_fat_pct', label: '체지방률', unit: '%', color: 'var(--h-orange)', step: 0.5 },
  { key: 'skeletal_muscle_kg', label: '골격근량', unit: 'kg', color: 'var(--h-purple)', step: 0.5 },
]

export const METRIC_META = Object.fromEntries(GOAL_METRICS.map((m) => [m.key, m])) as Record<
  GoalMetric,
  (typeof GOAL_METRICS)[number]
>

/**
 * upsert 의 충돌 대상에 user_id 가 들어간다. 컬럼 기본값(auth.uid())에 맡기고 payload 에서
 * 빼면 PostgREST 가 그 열을 못 채워 충돌 판정이 어긋난다 — 같은 측정이 중복으로 쌓인다.
 * 그래서 넣을 때만 세션에서 직접 꺼내 붙인다. (RLS 는 그대로 본인 것만 통과시킨다)
 */
async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user.id
  if (!id) throw new Error('로그인이 필요합니다')
  return id
}

const MEASUREMENT_COLS =
  'id, measured_at, device, weight_kg, skeletal_muscle_kg, muscle_kg, body_fat_kg, bmi, body_fat_pct, bmr_kcal, inbody_score, arm_r_muscle_kg, arm_l_muscle_kg, trunk_muscle_kg, leg_r_muscle_kg, leg_l_muscle_kg, arm_r_fat_kg, arm_l_fat_kg, trunk_fat_kg, leg_r_fat_kg, leg_l_fat_kg, whr, waist_cm, visceral_fat_level, body_water_l, protein_kg, mineral_kg, smi, phase_angle'

// ── 조회 / 저장 ──────────────────────────────────────────
export async function fetchMeasurements(): Promise<BodyMeasurement[]> {
  const { data, error } = await supabase
    .from('body_measurements')
    .select(MEASUREMENT_COLS)
    .order('measured_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as BodyMeasurement[]
}

/** 같은 측정 시각은 덮어쓴다 — 같은 파일을 다시 올려도 늘지 않는다 */
export async function upsertMeasurements(rows: ParsedMeasurement[]): Promise<number> {
  if (!rows.length) return 0
  const user_id = await currentUserId()
  const { error } = await supabase
    .from('body_measurements')
    .upsert(rows.map((r) => ({ ...r, user_id })), { onConflict: 'user_id,measured_at' })
  if (error) throw error
  return rows.length
}

export async function deleteMeasurement(id: string): Promise<void> {
  const { error } = await supabase.from('body_measurements').delete().eq('id', id)
  if (error) throw error
}

export async function fetchGoals(): Promise<BodyGoal[]> {
  const { data, error } = await supabase
    .from('body_goals')
    .select('id, metric, target_value, target_date, start_value, start_date, achieved_at, active')
    .eq('active', true)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as BodyGoal[]
}

export async function saveGoal(g: {
  metric: GoalMetric
  target_value: number
  target_date: string
  start_value: number
  start_date: string
}): Promise<void> {
  // 지표마다 하나만 살아 있게 — 새로 세우면 이전 것은 접는다
  const { error: e1 } = await supabase.from('body_goals').update({ active: false }).eq('metric', g.metric).eq('active', true)
  if (e1) throw e1
  const { error } = await supabase.from('body_goals').insert(g)
  if (error) throw error
}

export async function dropGoal(id: string): Promise<void> {
  const { error } = await supabase.from('body_goals').update({ active: false }).eq('id', id)
  if (error) throw error
}

export async function fetchNutrition(sinceISODate: string): Promise<NutritionLog[]> {
  const { data, error } = await supabase
    .from('nutrition_logs')
    .select('day, kcal, protein_g, note')
    .gte('day', sinceISODate)
    .order('day', { ascending: true })
  if (error) throw error
  return (data ?? []) as NutritionLog[]
}

export async function saveNutrition(log: NutritionLog): Promise<void> {
  const user_id = await currentUserId()
  const { error } = await supabase.from('nutrition_logs').upsert({ ...log, user_id }, { onConflict: 'user_id,day' })
  if (error) throw error
}

export async function fetchSettings(): Promise<BodySettings> {
  const { data, error } = await supabase
    .from('body_settings')
    .select('height_cm, sex, birth_year, neat_factor')
    .maybeSingle()
  if (error) throw error
  return (data as BodySettings) ?? { height_cm: null, sex: null, birth_year: null, neat_factor: 1.25 }
}

export async function saveSettings(s: Partial<BodySettings>): Promise<void> {
  const user_id = await currentUserId()
  const { error } = await supabase.from('body_settings').upsert({ ...s, user_id }, { onConflict: 'user_id' })
  if (error) throw error
}

// ── 파생 ─────────────────────────────────────────────────
export function latest(measurements: BodyMeasurement[]): BodyMeasurement | null {
  return measurements.length ? measurements[measurements.length - 1] : null
}

/** 인바디는 체중과 BMI 를 둘 다 준다 — 신장은 거기서 역산된다. 설정에 값이 있으면 그게 이긴다. */
export function heightCm(measurements: BodyMeasurement[], settings: BodySettings): number | null {
  if (settings.height_cm) return settings.height_cm
  for (let i = measurements.length - 1; i >= 0; i--) {
    const m = measurements[i]
    if (m.weight_kg && m.bmi) return Math.round(Math.sqrt(m.weight_kg / m.bmi) * 1000) / 10
  }
  return null
}

/** 제지방량 = 체중 − 체지방량. 단백질 목표의 기준이 된다. */
export function leanMassKg(m: BodyMeasurement | null): number | null {
  if (!m?.weight_kg) return null
  if (m.body_fat_kg != null) return Math.round((m.weight_kg - m.body_fat_kg) * 10) / 10
  if (m.body_fat_pct != null) return Math.round(m.weight_kg * (1 - m.body_fat_pct / 100) * 10) / 10
  return null
}

export interface BodyPoint {
  day: string
  date: string
  weight_kg: number | null
  body_fat_pct: number | null
  skeletal_muscle_kg: number | null
  body_fat_kg: number | null
}

export function bodySeries(measurements: BodyMeasurement[]): BodyPoint[] {
  return measurements.map((m) => ({
    day: dayjs(m.measured_at).format('YY.M.D'),
    date: m.measured_at,
    weight_kg: m.weight_kg,
    body_fat_pct: m.body_fat_pct,
    skeletal_muscle_kg: m.skeletal_muscle_kg,
    body_fat_kg: m.body_fat_kg,
  }))
}

/**
 * 최소제곱으로 주당 변화량을 구한다.
 *
 * 앞뒤 두 점만 빼서 계산하면 그날 수분 상태 하나에 추세가 통째로 흔들린다
 * (인바디는 물만 마셔도 체중이 0.5kg 씩 움직인다). 그래서 구간 전체를 회귀한다.
 */
export function trendPerWeek(measurements: BodyMeasurement[], metric: GoalMetric, days = 60): number | null {
  const since = dayjs().subtract(days, 'day')
  const pts = measurements
    .filter((m) => dayjs(m.measured_at).isAfter(since) && m[metric] != null)
    .map((m) => ({ x: dayjs(m.measured_at).valueOf() / 86400000, y: m[metric] as number }))
  if (pts.length < 2) return null
  const n = pts.length
  const mx = pts.reduce((s, p) => s + p.x, 0) / n
  const my = pts.reduce((s, p) => s + p.y, 0) / n
  let num = 0
  let den = 0
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my)
    den += (p.x - mx) ** 2
  }
  if (den === 0) return null
  return Math.round((num / den) * 7 * 100) / 100
}

export interface GoalProgress {
  goal: BodyGoal
  current: number | null
  /** 0~1. 시작값에서 목표값까지 얼마나 왔나 */
  progress: number
  /** 남은 양 (목표 방향 기준, 항상 0 이상) */
  remaining: number | null
  /** 목표까지 남은 주 */
  weeksLeft: number
  /** 기한을 맞추려면 주당 이만큼 */
  neededPerWeek: number | null
  /** 최근 추세로는 주당 이만큼 */
  actualPerWeek: number | null
  /** 지금 추세대로면 도달하는 날 (추세가 반대거나 0 이면 null) */
  projectedDate: string | null
  achieved: boolean
  /** 목표 방향: 줄여야 하면 -1, 늘려야 하면 +1 */
  dir: 1 | -1
}

export function goalProgress(goal: BodyGoal, measurements: BodyMeasurement[]): GoalProgress {
  const cur = (() => {
    for (let i = measurements.length - 1; i >= 0; i--) {
      const v = measurements[i][goal.metric]
      if (v != null) return v
    }
    return null
  })()

  const span = goal.target_value - goal.start_value
  const dir: 1 | -1 = span >= 0 ? 1 : -1
  const done = cur != null ? (cur - goal.start_value) / (span || 1) : 0
  const progress = Math.max(0, Math.min(1, done))
  const achieved = cur != null && (dir === 1 ? cur >= goal.target_value : cur <= goal.target_value)

  const weeksLeft = Math.max(0, dayjs(goal.target_date).diff(dayjs(), 'day') / 7)
  const remaining = cur != null ? Math.max(0, Math.abs(goal.target_value - cur)) : null
  const neededPerWeek =
    remaining != null && weeksLeft > 0 ? Math.round((remaining / weeksLeft) * dir * 100) / 100 : null

  const actualPerWeek = trendPerWeek(measurements, goal.metric)

  let projectedDate: string | null = null
  if (cur != null && actualPerWeek != null && remaining != null && remaining > 0) {
    // 추세가 목표와 같은 방향일 때만 도달 예상이 의미가 있다
    if (Math.sign(actualPerWeek) === dir && actualPerWeek !== 0) {
      const weeks = remaining / Math.abs(actualPerWeek)
      // 5년을 넘기면 "언젠가는" 이라 숫자를 보여 주는 게 더 헷갈린다
      if (weeks < 260) projectedDate = dayjs().add(weeks * 7, 'day').format('YYYY-MM-DD')
    }
  }

  return {
    goal,
    current: cur,
    progress: achieved ? 1 : progress,
    remaining,
    weeksLeft,
    neededPerWeek,
    actualPerWeek,
    projectedDate,
    achieved,
    dir,
  }
}

export interface Milestone {
  date: string
  expected: number
  actual: number | null
  reached: boolean
  past: boolean
}

/**
 * 목표를 월 단위로 쪼갠 중간 지점들. "12월에 15%" 만 있으면 지금 잘 가고 있는지 알 수 없다 —
 * 이번 달에 어디까지 와 있어야 하는지가 보여야 조절할 수 있다.
 */
export function milestones(goal: BodyGoal, measurements: BodyMeasurement[]): Milestone[] {
  const start = dayjs(goal.start_date)
  const end = dayjs(goal.target_date)
  const totalDays = end.diff(start, 'day')
  if (totalDays <= 0) return []
  const steps = Math.min(12, Math.max(1, Math.round(totalDays / 30)))
  const out: Milestone[] = []
  const dir: 1 | -1 = goal.target_value >= goal.start_value ? 1 : -1

  for (let i = 1; i <= steps; i++) {
    const at = start.add((totalDays * i) / steps, 'day')
    const expected = goal.start_value + ((goal.target_value - goal.start_value) * i) / steps
    // 그 시점까지의 마지막 실측값
    let actual: number | null = null
    for (const m of measurements) {
      if (dayjs(m.measured_at).isAfter(at)) break
      const v = m[goal.metric]
      if (v != null) actual = v
    }
    out.push({
      date: at.format('YYYY-MM-DD'),
      expected: Math.round(expected * 10) / 10,
      actual,
      reached: actual != null && (dir === 1 ? actual >= expected : actual <= expected),
      past: at.isBefore(dayjs()),
    })
  }
  return out
}
