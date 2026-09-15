import dayjs from 'dayjs'
import { supabase } from './supabase'
import type { Activity, Wellness } from './exercise'

// 오늘 훈련해도 되는 몸인가 — 다섯 가지 신호로 따져 본다.
//
// 전부 공식이다 (coach.ts 와 같은 이유). 같은 값이면 언제나 같은 판정이 나와야
// "어제는 쉬라더니 오늘은 왜" 를 따라갈 수 있다.
//
// 네 개는 데이터에서 자동으로 나오고, 주관 신호 하나만 질문지로 받는다.
// 회복 시간은 가민이 API 로 주지 않아(아래) 질문지에서 받되 한 번 받으면 카운트다운한다.

export type SignalKey = 'recovery' | 'sleep' | 'hrv' | 'restingHr' | 'subjective'

export type Level = 'good' | 'caution' | 'bad'

export const SIGNAL_LABEL: Record<SignalKey, string> = {
  recovery: '가민 회복 시간',
  sleep: '수면',
  hrv: 'HRV',
  restingHr: '안정시심박',
  subjective: '주관적 신호',
}

/** 신호가 켜졌을 때 오늘 훈련을 어떻게 낮출지 — 리뷰에 그대로 보여 준다 */
export const SIGNAL_ADVICE: Record<SignalKey, string> = {
  recovery: '회복이 안 끝났다. 고강도(인터벌·템포)는 미루고 Z2 이하로.',
  sleep: '잠이 모자란 날은 같은 강도가 더 비싸다. 볼륨을 줄이거나 이지로.',
  hrv: '자율신경이 아직 안 돌아왔다. 강도보다 회복을 먼저.',
  restingHr: '심박이 평소보다 높다. 피로·수면 부족·잔병 신호일 수 있다.',
  subjective: '몸이 보내는 신호가 수치보다 빠를 때가 많다. 통증이면 훈련보다 원인부터.',
}

export const LEVEL_META: Record<Level, { label: string; icon: string; color: string; summary: string }> = {
  good: { label: '좋음', icon: '🙂', color: 'var(--ok)', summary: '계획대로 해도 되는 날' },
  caution: { label: '주의', icon: '😐', color: 'var(--warn)', summary: '강도를 한 단계 낮춰서' },
  bad: { label: '나쁨', icon: '😣', color: 'var(--danger)', summary: '쉬거나 회복 조깅까지' },
}

// ── 기준값 ────────────────────────────────────────────────
/** 수면이 이 시간 미만이면 신호 */
const SLEEP_MIN_HOURS = 6
/** HRV 가 기준선 대비 이만큼(%) 이상 떨어지면 신호 */
const HRV_DROP_PCT = 10
/** 안정시심박이 평소보다 이만큼(bpm) 이상 오르면 신호 */
const RHR_RISE_BPM = 3
/** HRV 기준선 = 직전 며칠 평균 (오늘 제외) */
const HRV_BASE_DAYS = 7
/** 안정시심박의 '평소' = 직전 며칠 중앙값 (오늘 제외). 하루 튀는 값에 흔들리지 않게 중앙값. */
const RHR_BASE_DAYS = 28
/** 기준선을 믿으려면 최소 이만큼은 값이 있어야 한다 */
const HRV_MIN_SAMPLES = 3
const RHR_MIN_SAMPLES = 5

// ── 주관 질문지 ───────────────────────────────────────────
export type AnswerValue = 0 | 1 | 2

export interface SubjectiveAnswers {
  /** 다리 무거움 */
  heaviness: AnswerValue
  /** 국소 뻣뻣함 */
  stiffness: AnswerValue
  /** 통증 */
  pain: AnswerValue
  /** 뻣뻣함·통증이 있는 부위 (자유 입력) */
  area?: string
}

export const EMPTY_ANSWERS: SubjectiveAnswers = { heaviness: 0, stiffness: 0, pain: 0, area: '' }

export const SUBJECTIVE_QUESTIONS: {
  key: 'heaviness' | 'stiffness' | 'pain'
  label: string
  /** 리뷰 한 줄에 들어갈 짧은 이름 */
  short: string
  hint: string
  options: [string, string, string]
}[] = [
  {
    key: 'heaviness',
    label: '다리가 무거운가',
    short: '다리 무거움',
    hint: '계단을 오르거나 걸을 때',
    options: ['가볍다', '조금 무겁다', '많이 무겁다'],
  },
  {
    key: 'stiffness',
    label: '국소적으로 뻣뻣한 곳이 있나',
    short: '뻣뻣함',
    hint: '종아리·햄스트링·고관절 등',
    options: ['없다', '조금 뻣뻣하다', '많이 뻣뻣하다'],
  },
  {
    key: 'pain',
    label: '통증이 있나',
    short: '통증',
    hint: '뻐근함과 통증은 다르다 — 찌르거나 콕콕 쑤시면 통증',
    options: ['없다', '뻐근하다', '아프다'],
  },
]

/**
 * 주관 신호는 세 답의 합(0~6)으로 켠다.
 * 하나만 '조금' 이면 그날 컨디션이라기보다 그냥 어제 훈련의 흔적이라 신호로 세지 않는다.
 * 다만 **통증 '아프다' 는 혼자서도** 켠다 — 통증은 쌓아서 보면 안 되는 신호다.
 */
const SUBJECTIVE_TRIP_SCORE = 2

function subjectiveScore(a: SubjectiveAnswers): number {
  return a.heaviness + a.stiffness + a.pain
}

// ── 판정 ──────────────────────────────────────────────────
export interface SignalResult {
  key: SignalKey
  /** null = 데이터가 없어 판단 못 함 (신호로 세지 않는다) */
  tripped: boolean | null
  /** 오늘 값 — "44 ms", "5.2 시간" */
  value: string
  /** 무엇과 비교했는지 — "최근 7일 평균 52 ms 대비 -15%" */
  basis: string
}

export interface Verdict {
  level: Level
  flagCount: number
  signals: SignalResult[]
  /** 켜진 신호에 대한 권고 (리뷰에 그대로 뿌린다) */
  advice: string[]
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** day 직전 n일 중 값이 있는 것만 (오늘은 기준선에 넣지 않는다 — 자기 자신과 비교하게 된다) */
function baseline(wellness: Wellness[], day: string, days: number, pick: (w: Wellness) => number | null): number[] {
  const from = dayjs(day).subtract(days, 'day')
  return wellness
    .filter((w) => dayjs(w.day).isBefore(dayjs(day), 'day') && !dayjs(w.day).isBefore(from, 'day'))
    .map(pick)
    .filter((v): v is number => v != null && v > 0)
}

const r1 = (v: number) => Math.round(v * 10) / 10

export interface EvaluateInput {
  wellness: Wellness[]
  day: string
  /** 질문지에서 받은 '지금 남은 회복 시간'. null 이면 모름 → 판단 제외 */
  recoveryHours: number | null
  answers: SubjectiveAnswers
}

export function evaluateBodyCheck({ wellness, day, recoveryHours, answers }: EvaluateInput): Verdict {
  const today = wellness.find((w) => w.day === day) ?? null

  // ① 회복 시간
  const recovery: SignalResult =
    recoveryHours == null
      ? { key: 'recovery', tripped: null, value: '모름', basis: '시계에서 확인한 값이 없음' }
      : recoveryHours > 0
        ? {
            key: 'recovery',
            tripped: true,
            value: `${r1(recoveryHours)}시간 남음`,
            basis: '회복 시간이 남아 있으면 신호',
          }
        : { key: 'recovery', tripped: false, value: '없음', basis: '회복 완료' }

  // ② 수면
  const sleepH = today?.sleep_secs != null ? today.sleep_secs / 3600 : null
  const sleep: SignalResult =
    sleepH == null
      ? { key: 'sleep', tripped: null, value: '기록 없음', basis: `기준 ${SLEEP_MIN_HOURS}시간` }
      : {
          key: 'sleep',
          tripped: sleepH < SLEEP_MIN_HOURS,
          value: `${r1(sleepH)}시간`,
          basis: `${SLEEP_MIN_HOURS}시간 미만이면 신호`,
        }

  // ③ HRV — 직전 7일 평균 대비 하락률
  const hrvBase = baseline(wellness, day, HRV_BASE_DAYS, (w) => w.hrv)
  const hrvToday = today?.hrv ?? null
  let hrv: SignalResult
  if (hrvToday == null || hrvBase.length < HRV_MIN_SAMPLES) {
    hrv = {
      key: 'hrv',
      tripped: null,
      value: hrvToday != null ? `${r1(hrvToday)} ms` : '기록 없음',
      basis: hrvBase.length < HRV_MIN_SAMPLES ? `최근 ${HRV_BASE_DAYS}일 기준선을 만들 값이 부족` : '오늘 값 없음',
    }
  } else {
    const base = mean(hrvBase)
    const dropPct = ((base - hrvToday) / base) * 100
    hrv = {
      key: 'hrv',
      tripped: dropPct >= HRV_DROP_PCT,
      value: `${r1(hrvToday)} ms`,
      basis: `최근 ${HRV_BASE_DAYS}일 평균 ${r1(base)} ms 대비 ${dropPct >= 0 ? '-' : '+'}${Math.abs(Math.round(dropPct))}% (기준 -${HRV_DROP_PCT}%)`,
    }
  }

  // ④ 안정시심박 — 평소(28일 중앙값) 대비 상승폭
  const rhrBase = baseline(wellness, day, RHR_BASE_DAYS, (w) => w.resting_hr)
  const rhrToday = today?.resting_hr ?? null
  let restingHr: SignalResult
  if (rhrToday == null || rhrBase.length < RHR_MIN_SAMPLES) {
    restingHr = {
      key: 'restingHr',
      tripped: null,
      value: rhrToday != null ? `${rhrToday} bpm` : '기록 없음',
      basis: rhrBase.length < RHR_MIN_SAMPLES ? `최근 ${RHR_BASE_DAYS}일 기준선을 만들 값이 부족` : '오늘 값 없음',
    }
  } else {
    const base = median(rhrBase)
    const rise = rhrToday - base
    restingHr = {
      key: 'restingHr',
      tripped: rise >= RHR_RISE_BPM,
      value: `${rhrToday} bpm`,
      basis: `평소 ${r1(base)} bpm 대비 ${rise >= 0 ? '+' : ''}${r1(rise)} bpm (기준 +${RHR_RISE_BPM})`,
    }
  }

  // ⑤ 주관적 신호
  const score = subjectiveScore(answers)
  const parts = SUBJECTIVE_QUESTIONS.filter((q) => answers[q.key] > 0).map(
    (q) => `${q.short}: ${q.options[answers[q.key]]}`,
  )
  const subjective: SignalResult = {
    key: 'subjective',
    tripped: score >= SUBJECTIVE_TRIP_SCORE || answers.pain === 2,
    value: parts.length ? parts.join(' · ') + (answers.area ? ` (${answers.area})` : '') : '모두 괜찮음',
    basis: `합계 ${score}점 · ${SUBJECTIVE_TRIP_SCORE}점 이상이거나 통증 '아프다' 면 신호`,
  }

  const signals = [recovery, sleep, hrv, restingHr, subjective]
  const flagCount = signals.filter((s) => s.tripped === true).length
  const level: Level = flagCount === 0 ? 'good' : flagCount >= 3 ? 'bad' : 'caution'
  const advice = signals.filter((s) => s.tripped === true).map((s) => SIGNAL_ADVICE[s.key])

  return { level, flagCount, signals, advice }
}

// ── 저장 / 조회 ───────────────────────────────────────────
export interface BodyCheck {
  id: string
  day: string
  checked_at: string
  level: Level
  flag_count: number
  signals: SignalResult[]
  answers: SubjectiveAnswers
  recovery_until: string | null
  note: string | null
}

const COLS = 'id, day, checked_at, level, flag_count, signals, answers, recovery_until, note'

/** 마이그레이션 미적용을 알아보기 쉬운 메시지로 (foodAdvice 와 같은 이유). */
function wrap(error: { message: string; code?: string } | null): void {
  if (!error) return
  if (error.code === '42P01' || /relation .* does not exist/i.test(error.message)) {
    throw new Error(
      '몸상태 판단 테이블이 없습니다. Supabase SQL 편집기에서 supabase/migrations/0018_body_check.sql 을 실행하세요.',
    )
  }
  throw new Error(error.message)
}

export async function fetchBodyChecks(fromDay: string, toDay: string): Promise<BodyCheck[]> {
  const { data, error } = await supabase
    .from('body_checks')
    .select(COLS)
    .gte('day', fromDay)
    .lte('day', toDay)
    .order('day', { ascending: true })
  wrap(error)
  return (data ?? []) as BodyCheck[]
}

export interface SaveInput {
  day: string
  verdict: Verdict
  answers: SubjectiveAnswers
  recoveryHours: number | null
  note: string
}

export async function saveBodyCheck(input: SaveInput): Promise<BodyCheck> {
  // upsert 충돌 대상에 user_id 가 들어가므로 기본값(auth.uid())에 맡기지 않고 직접 붙인다 (body.ts 와 같은 이유)
  const { data: sess } = await supabase.auth.getSession()
  const userId = sess.session?.user.id
  if (!userId) throw new Error('로그인이 필요합니다.')

  const checkedAt = new Date()
  const row = {
    user_id: userId,
    day: input.day,
    checked_at: checkedAt.toISOString(),
    level: input.verdict.level,
    flag_count: input.verdict.flagCount,
    signals: input.verdict.signals,
    answers: input.answers,
    // 시계에 뜬 '남은 시간' 을 끝나는 시각으로 바꿔 둔다 — 다음 판단 때 다시 물어보지 않으려고
    recovery_until:
      input.recoveryHours != null && input.recoveryHours > 0
        ? new Date(checkedAt.getTime() + input.recoveryHours * 3600_000).toISOString()
        : null,
    note: input.note.trim() || null,
  }
  const { data, error } = await supabase
    .from('body_checks')
    .upsert(row, { onConflict: 'user_id,day' })
    .select(COLS)
    .single()
  wrap(error)
  return data as BodyCheck
}

// ── 회복 시간 이어받기 ────────────────────────────────────
export interface RecoveryHint {
  /** 지금 남은 시간 (기본값으로 채울 값). 0 이면 회복 완료. */
  hours: number
  /** 이어받은 뒤 새 활동이 있었다 — 시계 값이 그새 늘었을 수 있으니 다시 보라고 알린다 */
  stale: boolean
  /** 어느 판단에서 이어받았는지 */
  from: string
}

/**
 * 가장 최근 판단의 '끝나는 시각' 에서 지금 남은 회복 시간을 되짚는다.
 *
 * 가민은 회복 시간을 API 로 주지 않는다 (FR255 는 Training Readiness 미지원이라
 * trainingreadiness 가 빈 배열이고, 원본 FIT 에도 필드가 없다 — 2026-09 직접 확인).
 * 그래서 한 번 받아 둔 값을 시간으로 굴린다. 그 사이 새 활동을 했으면 시계 값이
 * 다시 올라갔을 테니 그때만 새로 보라고 한다.
 */
export function recoveryHint(checks: BodyCheck[], activities: Activity[], now = new Date()): RecoveryHint | null {
  const last = [...checks].sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0]
  if (!last?.recovery_until) return null

  const leftMs = Date.parse(last.recovery_until) - now.getTime()
  const since = dayjs(last.checked_at)
  const stale = activities.some((a) => a.start_date_local && dayjs(a.start_date_local).isAfter(since))
  if (leftMs <= 0 && !stale) return { hours: 0, stale: false, from: last.day }
  if (leftMs <= 0) return null // 회복은 끝났는데 그 뒤로 운동을 했다 — 추측하지 않는다

  return { hours: Math.round((leftMs / 3600_000) * 10) / 10, stale, from: last.day }
}

/** 날짜별로 찾아 쓰기 좋게 */
export function byDayMap(checks: BodyCheck[]): Map<string, BodyCheck> {
  return new Map(checks.map((c) => [c.day, c]))
}
