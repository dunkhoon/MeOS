import dayjs from 'dayjs'
import { supabase } from './supabase'

// 근력 운동 — 세트 타이머와 그 기록.
//
// 설계에서 두 가지가 중요하다.
//
// 1) **휴식은 저장하지 않는다.** 세트 사이의 빈 시간이 곧 휴식이다. 행으로 따로 두면
//    세트를 지우거나 고칠 때 둘이 어긋난다. 여기서는 항상 간격으로 계산한다.
//
// 2) **경과 시간은 언제나 벽시계로 잰다.** setInterval 로 1씩 더해 세면 안 된다 —
//    폰에서 화면이 꺼지거나 브라우저 탭이 뒤로 가면 타이머가 throttle 돼서
//    실제보다 짧게 세진다. 헬스장에서 쓰는 기능이라 이건 바로 틀린 기록이 된다.

// ── 타입 ─────────────────────────────────────────────────
export interface StrengthExercise {
  id: string
  name: string
  category: string | null
  sort_order: number
  archived: boolean
}

export interface StrengthSet {
  id: string
  session_id: string
  seq: number
  exercise_id: string | null
  exercise_name: string
  weight_kg: number | null
  reps: number | null
  started_at: string
  ended_at: string
  duration_s: number
}

export interface StrengthSession {
  id: string
  started_at: string
  ended_at: string | null
  note: string | null
  strength_sets: StrengthSet[]
}

export const CATEGORIES = [
  { key: 'chest', label: '가슴' },
  { key: 'back', label: '등' },
  { key: 'shoulder', label: '어깨' },
  { key: 'leg', label: '하체' },
  { key: 'arm', label: '팔' },
  { key: 'core', label: '코어' },
  { key: 'other', label: '기타' },
] as const

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]))

export const CATEGORY_COLOR: Record<string, string> = {
  chest: 'var(--h-orange)',
  back: 'var(--h-blue)',
  shoulder: 'var(--h-purple)',
  leg: 'var(--h-green)',
  arm: 'var(--h-pink)',
  core: 'var(--h-cyan)',
  other: 'var(--h-yellow)',
}

/** 종목이 하나도 없을 때 한 번에 깔아 주는 기본 목록. 앱에서 이름을 고치거나 지울 수 있다. */
export const PRESET_EXERCISES: { name: string; category: string }[] = [
  { name: '바벨 벤치프레스', category: 'chest' },
  { name: '인클라인 벤치프레스', category: 'chest' },
  { name: '덤벨 프레스', category: 'chest' },
  { name: '딥스', category: 'chest' },
  { name: '바벨 로우', category: 'back' },
  { name: '데드리프트', category: 'back' },
  { name: '풀업', category: 'back' },
  { name: '랫풀다운', category: 'back' },
  { name: '시티드 로우', category: 'back' },
  { name: '오버헤드 프레스', category: 'shoulder' },
  { name: '사이드 레터럴 레이즈', category: 'shoulder' },
  { name: '페이스 풀', category: 'shoulder' },
  { name: '바벨 스쿼트', category: 'leg' },
  { name: '루마니안 데드리프트', category: 'leg' },
  { name: '레그 프레스', category: 'leg' },
  { name: '레그 익스텐션', category: 'leg' },
  { name: '레그 컬', category: 'leg' },
  { name: '바벨 컬', category: 'arm' },
  { name: '덤벨 컬', category: 'arm' },
  { name: '케이블 푸시다운', category: 'arm' },
  { name: '플랭크', category: 'core' },
  { name: '행잉 레그 레이즈', category: 'core' },
]

// ── 조회 / 저장 ──────────────────────────────────────────
export async function fetchExercises(): Promise<StrengthExercise[]> {
  const { data, error } = await supabase
    .from('strength_exercises')
    .select('id, name, category, sort_order, archived')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as StrengthExercise[]
}

export async function addExercise(name: string, category: string): Promise<StrengthExercise> {
  const { data, error } = await supabase
    .from('strength_exercises')
    .insert({ name: name.trim(), category })
    .select('id, name, category, sort_order, archived')
    .single()
  if (error) throw error
  return data as StrengthExercise
}

export async function renameExercise(id: string, name: string, category: string): Promise<void> {
  const { error } = await supabase.from('strength_exercises').update({ name: name.trim(), category }).eq('id', id)
  if (error) throw error
}

/** 지우지 않고 감춘다 — 과거 세트가 이 종목을 가리키고 있다 */
export async function archiveExercise(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.from('strength_exercises').update({ archived }).eq('id', id)
  if (error) throw error
}

export async function seedPresetExercises(): Promise<void> {
  const rows = PRESET_EXERCISES.map((p, i) => ({ name: p.name, category: p.category, sort_order: i }))
  const { error } = await supabase.from('strength_exercises').insert(rows)
  if (error) throw error
}

export async function fetchSessions(sinceISODate: string): Promise<StrengthSession[]> {
  const { data, error } = await supabase
    .from('strength_sessions')
    .select(
      'id, started_at, ended_at, note, strength_sets(id, session_id, seq, exercise_id, exercise_name, weight_kg, reps, started_at, ended_at, duration_s)',
    )
    .gte('started_at', sinceISODate)
    .order('started_at', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as StrengthSession[]
  // 중첩 조회는 순서를 보장하지 않는다 — 세트는 언제나 순서대로 다뤄야 휴식 계산이 맞다
  for (const s of rows) s.strength_sets = (s.strength_sets ?? []).slice().sort((a, b) => a.seq - b.seq)
  return rows
}

/**
 * 활동 탭에서 겹치는 WeightTraining 을 숨기려고 시간 범위만 가볍게 읽는다.
 *
 * 마이그레이션(0010)을 아직 안 돌렸으면 테이블이 없어 실패한다. 그건 부가 기능이라
 * 여기서 조용히 빈 배열로 넘긴다 — 이것 때문에 활동 탭 전체가 안 뜨면 안 된다.
 */
export async function fetchSessionRanges(sinceISODate: string): Promise<{ started_at: string; ended_at: string | null }[]> {
  const { data, error } = await supabase
    .from('strength_sessions')
    .select('started_at, ended_at')
    .gte('started_at', sinceISODate)
  if (error) return []
  return (data ?? []) as { started_at: string; ended_at: string | null }[]
}

/**
 * 이미 저장된 세트 하나의 내용을 고친다 (캘린더에서 그날 기록을 볼 때).
 *
 * ⚠️ **시각은 건드리지 않는다.** 휴식은 행으로 저장하지 않고 `앞 세트 ended_at ~ 다음 세트
 * started_at` 간격으로 계산하므로, 시각을 고치면 앞뒤 휴식이 같이 어긋난다. 잘못 적은 건
 * 종목·중량·횟수지 시간이 아니다 — 그건 실제로 잰 값이다.
 *
 * `exercise_name` 은 스냅샷이라 `exercise_id` 와 함께 바꿔 준다. 둘이 어긋나면 종목별
 * 통계(이름으로 묶는다)와 부위 색(id 로 찾는다)이 서로 다른 말을 한다.
 */
export async function updateSet(
  id: string,
  v: { exercise_id: string | null; exercise_name: string; weight_kg: number | null; reps: number | null },
): Promise<void> {
  const { error } = await supabase
    .from('strength_sets')
    .update({ ...v, exercise_name: v.exercise_name.trim() })
    .eq('id', id)
  if (error) throw error
}

export async function deleteSession(id: string): Promise<void> {
  const { error } = await supabase.from('strength_sessions').delete().eq('id', id)
  if (error) throw error
}

// ── 진행 중인 세션 (localStorage) ────────────────────────
//
// 헬스장은 통신이 끊기는 곳이다. 세트마다 서버에 쓰면 한 번 실패할 때 기록이 통째로 날아간다.
// 그래서 진행 중엔 로컬에만 쌓고, 종료할 때 한 번에 올린다.
// 올리기가 실패해도 로컬 기록은 그대로 남아 있어서 다시 시도할 수 있다.

const LIVE_KEY = 'pp:strength:live'

export interface LiveSet {
  seq: number
  exerciseId: string | null
  exerciseName: string
  weightKg: number | null
  reps: number | null
  startedAt: number // epoch ms
  endedAt: number
}

export interface LiveSession {
  startedAt: number
  /** 종료를 누른 시각. null 이면 아직 운동 중, 값이 있으면 "저장 대기" 상태다. */
  endedAt: number | null
  sets: LiveSet[]
  /** 지금 돌고 있는 세트. null 이면 휴식 중. */
  current: {
    exerciseId: string | null
    exerciseName: string
    weightKg: number | null
    startedAt: number
  } | null
  note: string
}

export function readLive(): LiveSession | null {
  try {
    const raw = localStorage.getItem(LIVE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as LiveSession
    if (typeof v?.startedAt !== 'number' || !Array.isArray(v.sets)) return null
    return v
  } catch {
    return null
  }
}

export function writeLive(v: LiveSession | null): void {
  try {
    if (v) localStorage.setItem(LIVE_KEY, JSON.stringify(v))
    else localStorage.removeItem(LIVE_KEY)
  } catch {
    /* 저장소를 못 쓰면 이번 세션은 메모리로만 — 새로고침하면 잃는다 */
  }
}

/** 끝난 세션을 서버에 올린다. 성공하면 로컬 기록을 지운다. */
export async function saveLiveSession(live: LiveSession): Promise<string> {
  const endedAt = live.endedAt ?? Date.now()
  const { data, error } = await supabase
    .from('strength_sessions')
    .insert({
      started_at: new Date(live.startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      note: live.note.trim() || null,
    })
    .select('id')
    .single()
  if (error) throw error
  const sessionId = (data as { id: string }).id

  if (live.sets.length) {
    const rows = live.sets.map((s) => ({
      session_id: sessionId,
      seq: s.seq,
      exercise_id: s.exerciseId,
      exercise_name: s.exerciseName,
      weight_kg: s.weightKg,
      reps: s.reps,
      started_at: new Date(s.startedAt).toISOString(),
      ended_at: new Date(s.endedAt).toISOString(),
      duration_s: Math.max(0, Math.round((s.endedAt - s.startedAt) / 1000)),
    }))
    const { error: e2 } = await supabase.from('strength_sets').insert(rows)
    if (e2) {
      // 세트를 못 넣었으면 껍데기 세션만 남는다 — 지우고 로컬 기록을 살려 둔다
      await supabase.from('strength_sessions').delete().eq('id', sessionId)
      throw e2
    }
  }
  writeLive(null)
  return sessionId
}

// ── 파생 통계 ────────────────────────────────────────────
export function fmtClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function fmtDur(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}초`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m}분 ${s}초` : `${m}분`
}

/** 볼륨 = 중량 × 횟수 를 모두 더한 값(kg). 중량이나 횟수가 없는 세트(맨몸·플랭크)는 0. */
export function volumeOf(sets: { weight_kg: number | null; reps: number | null }[]): number {
  return sets.reduce((s, x) => s + (x.weight_kg ?? 0) * (x.reps ?? 0), 0)
}

export interface SessionSummary {
  setCount: number
  volumeKg: number
  workS: number
  restS: number
  totalS: number
  exercises: string[]
}

export function sessionSummary(session: StrengthSession): SessionSummary {
  const sets = session.strength_sets
  const workS = sets.reduce((s, x) => s + (x.duration_s || 0), 0)
  const start = dayjs(session.started_at).valueOf()
  const end = session.ended_at ? dayjs(session.ended_at).valueOf() : sets.length ? dayjs(sets[sets.length - 1].ended_at).valueOf() : start
  const totalS = Math.max(0, Math.round((end - start) / 1000))
  return {
    setCount: sets.length,
    volumeKg: Math.round(volumeOf(sets)),
    workS,
    // 세트에 쓴 시간 말고는 전부 휴식으로 본다 (준비·이동 포함 — 실제로 그게 세트 사이 시간이다)
    restS: Math.max(0, totalS - workS),
    totalS,
    exercises: [...new Set(sets.map((x) => x.exercise_name))],
  }
}

export interface TimelineItem {
  kind: 'work' | 'rest'
  /** 세트 행 id — 눌러서 고칠 때 쓴다. 휴식은 저장된 행이 아니라 없다. */
  id?: string
  seq?: number
  exerciseId?: string | null
  exerciseName?: string
  weightKg?: number | null
  reps?: number | null
  durationS: number
}

/** 세트와 그 사이 휴식을 시간순으로 늘어놓는다. 휴식은 저장돼 있지 않고 여기서 계산한다. */
export function timeline(sets: StrengthSet[]): TimelineItem[] {
  const out: TimelineItem[] = []
  sets.forEach((s, i) => {
    if (i > 0) {
      const gap = Math.round((dayjs(s.started_at).valueOf() - dayjs(sets[i - 1].ended_at).valueOf()) / 1000)
      if (gap > 0) out.push({ kind: 'rest', durationS: gap })
    }
    out.push({
      kind: 'work',
      id: s.id,
      seq: s.seq,
      exerciseId: s.exercise_id,
      exerciseName: s.exercise_name,
      weightKg: s.weight_kg,
      reps: s.reps,
      durationS: s.duration_s,
    })
  })
  return out
}

/** Epley 공식 추정 1RM — 세트마다 중량이 달라도 한 줄로 비교할 수 있게 */
export function est1RM(weightKg: number | null, reps: number | null): number | null {
  if (!weightKg || !reps || reps < 1) return null
  return Math.round(weightKg * (1 + reps / 30) * 10) / 10
}

export interface ExerciseStat {
  name: string
  category: string | null
  sets: number
  volumeKg: number
  maxWeightKg: number | null
  best1RM: number | null
  lastAt: string | null
}

export function byExercise(sessions: StrengthSession[], catOf: (name: string) => string | null): ExerciseStat[] {
  const m = new Map<string, ExerciseStat>()
  for (const s of sessions) {
    for (const x of s.strength_sets) {
      const cur = m.get(x.exercise_name) ?? {
        name: x.exercise_name,
        category: catOf(x.exercise_name),
        sets: 0,
        volumeKg: 0,
        maxWeightKg: null,
        best1RM: null,
        lastAt: null,
      }
      cur.sets += 1
      cur.volumeKg += (x.weight_kg ?? 0) * (x.reps ?? 0)
      if (x.weight_kg != null && (cur.maxWeightKg == null || x.weight_kg > cur.maxWeightKg)) cur.maxWeightKg = x.weight_kg
      const rm = est1RM(x.weight_kg, x.reps)
      if (rm != null && (cur.best1RM == null || rm > cur.best1RM)) cur.best1RM = rm
      if (!cur.lastAt || x.started_at > cur.lastAt) cur.lastAt = x.started_at
      m.set(x.exercise_name, cur)
    }
  }
  return [...m.values()]
    .map((x) => ({ ...x, volumeKg: Math.round(x.volumeKg) }))
    .sort((a, b) => b.volumeKg - a.volumeKg)
}

export interface VolumePoint {
  label: string
  volume: number
  sets: number
}

/** 최근 N주 주간 볼륨 (월요일 시작) */
export function weeklyVolume(sessions: StrengthSession[], weeks = 12, exerciseName?: string): VolumePoint[] {
  const start = dayjs().startOf('isoWeek').subtract(weeks - 1, 'week')
  const buckets: VolumePoint[] = Array.from({ length: weeks }, (_, i) => ({
    label: start.add(i, 'week').format('M/D'),
    volume: 0,
    sets: 0,
  }))
  for (const s of sessions) {
    for (const x of s.strength_sets) {
      if (exerciseName && x.exercise_name !== exerciseName) continue
      const idx = dayjs(x.started_at).startOf('isoWeek').diff(start, 'week')
      if (idx < 0 || idx >= weeks) continue
      buckets[idx].volume += (x.weight_kg ?? 0) * (x.reps ?? 0)
      buckets[idx].sets += 1
    }
  }
  return buckets.map((b) => ({ ...b, volume: Math.round(b.volume) }))
}

export interface OneRmPoint {
  day: string
  weight: number | null
  est1rm: number | null
}

/** 한 종목의 세션별 최고 중량 / 추정 1RM 추이 */
export function exerciseProgress(sessions: StrengthSession[], exerciseName: string): OneRmPoint[] {
  const byDay = new Map<string, { w: number | null; rm: number | null }>()
  for (const s of sessions) {
    for (const x of s.strength_sets) {
      if (x.exercise_name !== exerciseName) continue
      const day = x.started_at.slice(0, 10)
      const cur = byDay.get(day) ?? { w: null, rm: null }
      if (x.weight_kg != null && (cur.w == null || x.weight_kg > cur.w)) cur.w = x.weight_kg
      const rm = est1RM(x.weight_kg, x.reps)
      if (rm != null && (cur.rm == null || rm > cur.rm)) cur.rm = rm
      byDay.set(day, cur)
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day: dayjs(day).format('M/D'), weight: v.w, est1rm: v.rm }))
}

/**
 * 직접 기록한 근력 세션과 시간이 겹치는 intervals.icu 활동의 external_id.
 *
 * 저장할 때 붙이지 않고 볼 때 계산한다 — Garmin → intervals.icu 반영은 몇 분에서
 * 몇 시간까지 늦는다. 세션을 끝낸 시점엔 짝이 될 활동이 아직 없다.
 */
export function matchedActivityIds(
  sessions: { started_at: string; ended_at: string | null }[],
  activities: { external_id: string; type: string | null; start_date_local: string | null; moving_time_s: number | null }[],
): Set<string> {
  const out = new Set<string>()
  const ranges = sessions.map((s) => ({
    from: dayjs(s.started_at).valueOf(),
    to: dayjs(s.ended_at ?? s.started_at).valueOf(),
  }))
  for (const a of activities) {
    if (a.type !== 'WeightTraining' || !a.start_date_local) continue
    const from = dayjs(a.start_date_local).valueOf()
    const to = from + (a.moving_time_s ?? 0) * 1000
    if (ranges.some((r) => from <= r.to && to >= r.from)) out.add(a.external_id)
  }
  return out
}
