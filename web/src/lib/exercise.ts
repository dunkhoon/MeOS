import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'
import { supabase } from './supabase'

// 주(week) 계산을 월요일 시작(ISO week)으로
dayjs.extend(isoWeek)

export interface Activity {
  id: string
  external_id: string
  type: string | null
  name: string | null
  start_date_local: string | null
  distance_m: number | null
  moving_time_s: number | null
  average_speed: number | null
  average_hr: number | null
  max_hr: number | null
  calories: number | null
  training_load: number | null
  device_name: string | null
  hr_zone_times: number[] | null
  /** 사용자가 수동 지정한 세션 종류 (null 이면 이름에서 추정) */
  session_kind: string | null
}

export interface Wellness {
  day: string
  ctl: number | null
  atl: number | null
  hrv: number | null
  resting_hr: number | null
  sleep_secs: number | null
  sleep_score: number | null
  steps: number | null
  weight: number | null
  vo2max: number | null
}

export async function fetchActivities(sinceISODate: string): Promise<Activity[]> {
  const { data, error } = await supabase
    .from('activities')
    .select(
      'id, external_id, type, name, start_date_local, distance_m, moving_time_s, average_speed, average_hr, max_hr, calories, training_load, device_name, hr_zone_times, session_kind',
    )
    .gte('start_date_local', sinceISODate)
    .order('start_date_local', { ascending: false })
  if (error) throw error
  return (data ?? []) as Activity[]
}

export interface Race {
  id: string
  external_id: string
  category: string | null
  name: string
  race_date: string
  type: string | null
  distance_m: number | null
  moving_time_s: number | null
}

export async function fetchRaces(): Promise<Race[]> {
  const { data, error } = await supabase
    .from('races')
    .select('id, external_id, category, name, race_date, type, distance_m, moving_time_s')
    .order('race_date', { ascending: true })
  if (error) throw error
  return (data ?? []) as Race[]
}

export function dday(raceDate: string): number {
  return dayjs(raceDate).startOf('day').diff(dayjs().startOf('day'), 'day')
}

export function upcomingRaces(races: Race[]): Race[] {
  return races.filter((r) => dday(r.race_date) >= 0).sort((a, b) => a.race_date.localeCompare(b.race_date))
}

export async function fetchWellness(sinceISODate: string): Promise<Wellness[]> {
  const { data, error } = await supabase
    .from('wellness')
    .select('day, ctl, atl, hrv, resting_hr, sleep_secs, sleep_score, steps, weight, vo2max')
    .gte('day', sinceISODate)
    .order('day', { ascending: true })
  if (error) throw error
  return (data ?? []) as Wellness[]
}

// ── 파생 통계 ──────────────────────────────────────────────
export function km(m: number | null | undefined): number {
  return m ? Math.round((m / 1000) * 10) / 10 : 0
}

export function hms(sec: number | null | undefined): string {
  if (!sec) return '-'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`
}

// 활동 종류별 고정 색상 (없으면 fallback 팔레트에서 이름 해시로 배정)
const TYPE_COLORS: Record<string, string> = {
  Run: '#ff6b35',
  VirtualRun: '#ffa94d',
  Ride: '#3fb0ff',
  VirtualRide: '#4dc4ff',
  WeightTraining: '#a78bfa',
  Walk: '#3fb950',
  Hike: '#f4a261',
  Swim: '#22d3ee',
  Soccer: '#ff6b9d',
  Workout: '#e879f9',
  Yoga: '#facc15',
  Rowing: '#38bdf8',
}
const FALLBACK_PALETTE = ['#f472b6', '#facc15', '#22d3ee', '#a3e635', '#fb923c', '#c084fc', '#38bdf8', '#f87171', '#34d399', '#818cf8']

export function typeColor(type: string | null | undefined): string {
  const t = type || 'Other'
  const fixed = TYPE_COLORS[t]
  if (fixed) return fixed
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length]
}

// 데이터에 존재하는 활동 종류 목록 (정렬)
export function activityTypes(activities: Activity[]): string[] {
  const set = new Set<string>()
  for (const a of activities) set.add(a.type || 'Other')
  return [...set].sort()
}

export type Gran = 'week' | 'month' | 'year'

export interface GranMeta {
  count: number
  title: string
}

// 각 단위별: 표시 개수 + 헤더 문구
export const GRAN_META: Record<Gran, GranMeta> = {
  week: { count: 8, title: '최근 8주 · 월~일' },
  month: { count: 12, title: '최근 12개월' },
  year: { count: 5, title: '최근 5년' },
}

// 'week'|'month'|'year' 는 add/subtract(ManipulateType)와 diff(OpUnitType) 양쪽에 유효
type Step = 'week' | 'month' | 'year'

const GRAN_CFG: Record<Gran, { step: Step; fmt: string }> = {
  week: { step: 'week', fmt: 'M/D' },
  month: { step: 'month', fmt: 'YY.M' },
  year: { step: 'year', fmt: 'YYYY' },
}

// 버킷 시작 시점(주는 월요일 시작=isoWeek). 리터럴로 분기해 dayjs 타입 오버로드 만족.
function startOfBucket(d: dayjs.Dayjs, gran: Gran): dayjs.Dayjs {
  switch (gran) {
    case 'week':
      return d.startOf('isoWeek')
    case 'month':
      return d.startOf('month')
    case 'year':
      return d.startOf('year')
  }
}

export interface DistByTypePoint {
  label: string
  [type: string]: number | string
}

// 기간별 · 종류별 거리(km) 스택 데이터. types 에 포함된 종류만 각각 누적한다.
export function distanceSeriesByType(activities: Activity[], gran: Gran, types: string[]): DistByTypePoint[] {
  const { count } = GRAN_META[gran]
  const { step, fmt } = GRAN_CFG[gran]
  const start = startOfBucket(dayjs(), gran).subtract(count - 1, step)
  const buckets: DistByTypePoint[] = Array.from({ length: count }, (_, i) => {
    const p: DistByTypePoint = { label: start.add(i, step).format(fmt) }
    for (const t of types) p[t] = 0
    return p
  })
  for (const a of activities) {
    if (!a.start_date_local || !a.distance_m) continue
    const t = a.type || 'Other'
    if (!types.includes(t)) continue
    const idx = startOfBucket(dayjs(a.start_date_local), gran).diff(start, step)
    if (idx >= 0 && idx < count) buckets[idx][t] = ((buckets[idx][t] as number) || 0) + a.distance_m / 1000
  }
  for (const b of buckets) {
    for (const t of types) b[t] = Math.round(((b[t] as number) || 0) * 10) / 10
  }
  return buckets
}

// ── HR 존 (심박존 Z1~Z5) ──────────────────────────
export const HR_ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const
export type HrZone = (typeof HR_ZONES)[number]

export const ZONE_COLORS: Record<HrZone, string> = {
  Z1: '#4a9eff',
  Z2: '#3fb950',
  Z3: '#facc15',
  Z4: '#ff9f43',
  Z5: '#ff4d4f',
}

export interface ZonePoint {
  label: string
  Z1: number
  Z2: number
  Z3: number
  Z4: number
  Z5: number
}

// 기간별 Z1~Z5 비율(%) 스택. 존이 5개 초과인 활동은 초과분을 Z5에 합산.
export function zoneSeries(activities: Activity[], gran: Gran): ZonePoint[] {
  const { count } = GRAN_META[gran]
  const { step, fmt } = GRAN_CFG[gran]
  const start = startOfBucket(dayjs(), gran).subtract(count - 1, step)
  const secs: number[][] = Array.from({ length: count }, () => [0, 0, 0, 0, 0])
  for (const a of activities) {
    if (!a.start_date_local || !a.hr_zone_times) continue
    const idx = startOfBucket(dayjs(a.start_date_local), gran).diff(start, step)
    if (idx < 0 || idx >= count) continue
    a.hr_zone_times.forEach((v, i) => {
      secs[idx][Math.min(i, 4)] += v || 0
    })
  }
  return secs.map((zs, i) => {
    const tot = zs.reduce((x, y) => x + y, 0)
    const pct = (v: number) => (tot ? Math.round((v / tot) * 1000) / 10 : 0)
    return { label: start.add(i, step).format(fmt), Z1: pct(zs[0]), Z2: pct(zs[1]), Z3: pct(zs[2]), Z4: pct(zs[3]), Z5: pct(zs[4]) }
  })
}

export interface ZoneDist {
  z: HrZone
  pct: number
  secs: number
}

// 단일 활동의 Z1~Z5 분포(%)
export function activityZones(a: Activity): ZoneDist[] {
  const times = a.hr_zone_times
  if (!times || !times.length) return []
  const folded = [0, 0, 0, 0, 0]
  times.forEach((v, i) => {
    folded[Math.min(i, 4)] += v || 0
  })
  const tot = folded.reduce((x, y) => x + y, 0)
  if (!tot) return []
  return HR_ZONES.map((z, i) => ({ z, secs: folded[i], pct: Math.round((folded[i] / tot) * 100) }))
}

export interface FitnessPoint {
  day: string
  fitness: number | null
  fatigue: number | null
  form: number | null
}

export function fitnessSeries(wellness: Wellness[]): FitnessPoint[] {
  return wellness.map((w) => ({
    day: dayjs(w.day).format('M/D'),
    fitness: w.ctl != null ? Math.round(w.ctl) : null,
    fatigue: w.atl != null ? Math.round(w.atl) : null,
    form: w.ctl != null && w.atl != null ? Math.round(w.ctl - w.atl) : null,
  }))
}

// 페이스(min:sec /km) 환산 — 거리 기반 활동에만 의미
export function paceStr(distanceM: number | null | undefined, movingS: number | null | undefined): string {
  if (!distanceM || !movingS) return '-'
  const perKm = movingS / (distanceM / 1000)
  const m = Math.floor(perKm / 60)
  const s = Math.round(perKm % 60)
  return `${m}:${s.toString().padStart(2, '0')} /km`
}

// ── 컨디션 / 웰니스 ──────────────────────────
function latestNonNull(wellness: Wellness[], pick: (w: Wellness) => number | null | undefined): number | null {
  for (let i = wellness.length - 1; i >= 0; i--) {
    const v = pick(wellness[i])
    if (v != null) return v
  }
  return null
}

export interface ConditionSummary {
  restingHr: number | null
  hrv: number | null
  sleepHours: number | null
  weight: number | null
}

export function conditionSummary(wellness: Wellness[]): ConditionSummary {
  const sleep = latestNonNull(wellness, (w) => w.sleep_secs)
  return {
    restingHr: latestNonNull(wellness, (w) => w.resting_hr),
    hrv: latestNonNull(wellness, (w) => w.hrv),
    sleepHours: sleep != null ? Math.round((sleep / 3600) * 10) / 10 : null,
    weight: latestNonNull(wellness, (w) => w.weight),
  }
}

export interface ConditionPoint {
  day: string
  hrv: number | null
  restingHr: number | null
  sleep: number | null // 시간
  weight: number | null
}

export function conditionSeries(wellness: Wellness[]): ConditionPoint[] {
  return wellness.map((w) => ({
    day: dayjs(w.day).format('M/D'),
    hrv: w.hrv ?? null,
    restingHr: w.resting_hr ?? null,
    sleep: w.sleep_secs != null ? Math.round((w.sleep_secs / 3600) * 10) / 10 : null,
    weight: w.weight ?? null,
  }))
}

export interface TypeStat {
  type: string
  count: number
  km: number
}

export function byType(activities: Activity[]): TypeStat[] {
  const map = new Map<string, TypeStat>()
  for (const a of activities) {
    const t = a.type || 'Other'
    const cur = map.get(t) ?? { type: t, count: 0, km: 0 }
    cur.count += 1
    cur.km += (a.distance_m ?? 0) / 1000
    map.set(t, cur)
  }
  return [...map.values()]
    .map((s) => ({ ...s, km: Math.round(s.km * 10) / 10 }))
    .sort((a, b) => b.count - a.count)
}
