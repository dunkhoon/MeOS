import dayjs from 'dayjs'
import { supabase } from './supabase'
import { createThread } from './assistant'
import { MEALS, MEAL_LABEL, type DayTotals, type Meal, type Nutrition } from './food'
import { MODE_LABEL, type CoachPlan } from './coach'

// 하루 섭취에 대해 에이전트에게 물어본 것과 그 답.
//
// 두 가지를 묻는다. 물어보는 시점이 다르면 필요한 답이 완전히 다르기 때문이다.
//   review — 하루가 끝났다. 목표와 비교해 잘 먹었는지, 어떤 음식이 문제였는지.
//   plan   — 아직 먹는 중이다. 남은 목표를 채우려면 남은 식사를 어떻게 할지.
//
// ⚠️ 숫자는 **여기서 다 계산해서** 넘긴다. 에이전트에게 산수를 시키지 않는다.
//    같은 하루를 두 번 물었을 때 답의 근거가 달라지면 따라갈 수가 없다
//    (coach.ts 가 규칙 엔진인 것과 같은 이유). 에이전트는 판단과 음식 제안을 한다.

export type AdviceKind = 'review' | 'plan'

export const KIND_LABEL: Record<AdviceKind, string> = {
  review: '하루 마감',
  plan: '진행 중',
}

export interface FoodAdvice {
  id: string
  day: string
  kind: AdviceKind
  question: string
  snapshot: AdviceSnapshot | null
  thread_id: string | null
  message_id: string | null
  answer: string | null
  status: 'pending' | 'taken' | 'done' | 'error'
  error: string | null
  model: string | null
  created_at: string
  answered_at: string | null
}

const COLS =
  'id, day, kind, question, snapshot, thread_id, message_id, answer, status, error, model, created_at, answered_at'

/** 마이그레이션 미적용을 알아보기 쉬운 메시지로. */
function wrap(error: { message: string; code?: string } | null): void {
  if (!error) return
  if (error.code === '42P01' || /relation .* does not exist/i.test(error.message)) {
    throw new Error(
      '섭취 조언 테이블이 없습니다. Supabase SQL 편집기에서 supabase/migrations/0017_food_advice.sql 을 실행하세요.',
    )
  }
  throw new Error(error.message)
}

// ── 그날의 소모 ───────────────────────────────────────────

export interface DayActivity {
  type: string | null
  name: string | null
  minutes: number | null
  kcal: number | null
  avgHr: number | null
}

export interface DayStrength {
  sessions: number
  sets: number
  /** 무게 × 횟수 합 (kg). 근력을 "얼마나 했나" 로 비교할 수 있는 유일한 값이다. */
  volumeKg: number
  exercises: { name: string; sets: number; topWeightKg: number | null; totalReps: number }[]
}

export interface DayEnergy {
  day: string
  activities: DayActivity[]
  /** 그날 활동에서 태운 칼로리 합. 활동 기록이 하나도 없으면 null (0 과 다르다). */
  exerciseKcal: number | null
  strength: DayStrength | null
}

/**
 * 그날 하루치 활동과 근력 기록만 읽는다.
 *
 * ⚠️ `activities.start_date_local` 은 시간대 없는 벽시계(0013)다. ISO(Z) 로 비교하면
 *    경계가 9시간 어긋나므로 날짜 문자열 구간으로 자른다.
 *    `strength_sessions.started_at` 은 진짜 순간(timestamptz)이라 ISO 로 자른다.
 */
export async function fetchDayEnergy(day: string): Promise<DayEnergy> {
  const next = dayjs(day).add(1, 'day').format('YYYY-MM-DD')
  const [acts, sess] = await Promise.all([
    supabase
      .from('activities')
      .select('type, name, moving_time_s, calories, average_hr, start_date_local')
      .gte('start_date_local', day)
      .lt('start_date_local', next)
      .order('start_date_local', { ascending: true }),
    supabase
      .from('strength_sessions')
      .select('id, started_at, strength_sets(exercise_name, weight_kg, reps)')
      .gte('started_at', dayjs(day).startOf('day').toISOString())
      .lt('started_at', dayjs(day).add(1, 'day').startOf('day').toISOString()),
  ])
  wrap(acts.error)
  wrap(sess.error)

  type ActRow = {
    type: string | null
    name: string | null
    moving_time_s: number | null
    calories: number | null
    average_hr: number | null
  }
  const rows = (acts.data ?? []) as ActRow[]
  const activities: DayActivity[] = rows.map((a) => ({
    type: a.type,
    name: a.name,
    minutes: a.moving_time_s != null ? Math.round(a.moving_time_s / 60) : null,
    kcal: a.calories,
    avgHr: a.average_hr,
  }))
  // 활동이 하나도 없으면 "쉰 날" 인지 "아직 동기화 전" 인지 알 수 없다 — 0 이 아니라 null.
  const exerciseKcal = rows.length ? Math.round(rows.reduce((s, a) => s + (a.calories ?? 0), 0)) : null

  type SetRow = { exercise_name: string; weight_kg: number | null; reps: number | null }
  type SessRow = { id: string; strength_sets: SetRow[] | null }
  const sessions = (sess.data ?? []) as SessRow[]
  const allSets = sessions.flatMap((s) => s.strength_sets ?? [])
  const byExercise = new Map<string, { sets: number; topWeightKg: number | null; totalReps: number }>()
  let volumeKg = 0
  for (const s of allSets) {
    if (s.weight_kg != null && s.reps != null) volumeKg += s.weight_kg * s.reps
    const cur = byExercise.get(s.exercise_name) ?? { sets: 0, topWeightKg: null, totalReps: 0 }
    cur.sets += 1
    cur.totalReps += s.reps ?? 0
    if (s.weight_kg != null) cur.topWeightKg = Math.max(cur.topWeightKg ?? 0, s.weight_kg)
    byExercise.set(s.exercise_name, cur)
  }

  return {
    day,
    activities,
    exerciseKcal,
    strength: sessions.length
      ? {
          sessions: sessions.length,
          sets: allSets.length,
          volumeKg: Math.round(volumeKg),
          exercises: [...byExercise.entries()].map(([name, v]) => ({ name, ...v })),
        }
      : null,
  }
}

// ── 물어볼 때 같이 싣는 것 ────────────────────────────────

export interface AdviceSnapshot {
  day: string
  kind: AdviceKind
  askedAt: string
  goal: {
    mode: string
    targetKcal: number | null
    proteinG: number | null
    fatG: number | null
    carbG: number | null
    bmr: number | null
    tdee: number | null
    /** 목표 칼로리에 이미 반영돼 있는 최근 4주 하루 평균 운동 소모 */
    avgExerciseKcal: number | null
  }
  today: {
    exerciseKcal: number | null
    activities: DayActivity[]
    strength: DayStrength | null
    /** 목표 + (그날 실제 소모 − 4주 평균). 활동 기록이 있을 때만. */
    adjustedTargetKcal: number | null
    /** 그날 활동 기록이 아직 없다 — 쉰 날일 수도, 동기화 전일 수도 있다 */
    energyUnknown: boolean
  }
  intake: {
    total: Pick<Nutrition, 'kcal' | 'carb_g' | 'protein_g' | 'fat_g' | 'sugar_g' | 'sat_fat_g' | 'fiber_g' | 'sodium_mg'>
    byMeal: { meal: string; kcal: number | null; protein_g: number | null }[]
    entries: {
      meal: string
      name: string
      amount: string
      kcal: number | null
      carb_g: number | null
      protein_g: number | null
      fat_g: number | null
      sugar_g: number | null
      sodium_mg: number | null
    }[]
    remainingKcal: number | null
    remainingProteinG: number | null
  }
  /** 그날 이미 물어본 것들 — 같은 조언을 되풀이하지 않게 */
  askedBefore: { at: string; kind: AdviceKind }[]
}

const PICK = ['kcal', 'carb_g', 'protein_g', 'fat_g', 'sugar_g', 'sat_fat_g', 'fiber_g', 'sodium_mg'] as const

/**
 * 그날 기준 목표 칼로리.
 *
 * `plan.targetKcal` 에는 최근 4주 하루 평균 운동 소모가 이미 들어 있다. 그러니 그날 실제
 * 소모에서 **그 평균을 뺀 차이만** 더한다. 그냥 더하면 운동 소모를 두 번 세는 셈이 된다.
 * 그날 활동 기록이 없으면 조정하지 않는다(null) — 쉰 날인지 동기화 전인지 알 수 없다.
 *
 * ⚠️ 화면과 질문이 같은 숫자를 보여야 한다. 두 군데서 각자 계산하지 말고 이걸 쓴다.
 */
export function adjustedTargetKcal(plan: CoachPlan, energy: DayEnergy | null): number | null {
  if (plan.targetKcal == null || plan.exerciseKcal == null || energy?.exerciseKcal == null) return null
  return Math.round((plan.targetKcal + (energy.exerciseKcal - plan.exerciseKcal)) / 10) * 10
}

export function buildSnapshot(params: {
  day: string
  kind: AdviceKind
  plan: CoachPlan
  totals: DayTotals
  energy: DayEnergy
  prior: FoodAdvice[]
}): AdviceSnapshot {
  const { day, kind, plan, totals, energy, prior } = params
  const total = Object.fromEntries(PICK.map((k) => [k, totals.total[k] ?? null])) as AdviceSnapshot['intake']['total']

  const avg = plan.exerciseKcal
  const adjusted = adjustedTargetKcal(plan, energy)
  const effectiveTarget = adjusted ?? plan.targetKcal
  const eaten = total.kcal ?? 0

  return {
    day,
    kind,
    askedAt: dayjs().format('YYYY-MM-DD HH:mm'),
    goal: {
      mode: MODE_LABEL[plan.mode],
      targetKcal: plan.targetKcal,
      proteinG: plan.proteinG,
      fatG: plan.fatG,
      carbG: plan.carbG,
      bmr: plan.bmr,
      tdee: plan.tdee,
      avgExerciseKcal: avg,
    },
    today: {
      exerciseKcal: energy.exerciseKcal,
      activities: energy.activities,
      strength: energy.strength,
      adjustedTargetKcal: adjusted,
      energyUnknown: energy.exerciseKcal == null,
    },
    intake: {
      total,
      byMeal: MEALS.map((m) => ({
        meal: m.label,
        kcal: totals.byMeal[m.key].kcal ?? null,
        protein_g: totals.byMeal[m.key].protein_g ?? null,
      })),
      entries: totals.entries.map((e) => ({
        meal: MEAL_LABEL[e.meal as Meal] ?? e.meal,
        name: e.brand ? `${e.brand} ${e.name}` : e.name,
        amount: `${e.amount}${e.unit}${e.grams != null && e.unit !== 'g' ? ` (${e.grams}g)` : ''}`,
        kcal: e.kcal ?? null,
        carb_g: e.carb_g ?? null,
        protein_g: e.protein_g ?? null,
        fat_g: e.fat_g ?? null,
        sugar_g: e.sugar_g ?? null,
        sodium_mg: e.sodium_mg ?? null,
      })),
      remainingKcal: effectiveTarget != null ? Math.round(effectiveTarget - eaten) : null,
      remainingProteinG:
        plan.proteinG != null ? Math.round((plan.proteinG - (total.protein_g ?? 0)) * 10) / 10 : null,
    },
    askedBefore: prior.map((p) => ({ at: dayjs(p.created_at).format('HH:mm'), kind: p.kind })),
  }
}

/** 대화 화면에서도 그냥 읽히도록, 핵심 숫자는 질문 글 안에 넣는다. */
export function buildQuestion(s: AdviceSnapshot): string {
  const L: string[] = []
  const kcal = s.intake.total.kcal ?? 0
  const target = s.today.adjustedTargetKcal ?? s.goal.targetKcal

  L.push(
    s.kind === 'review'
      ? `${dayjs(s.day).format('M월 D일')} 섭취를 마감했습니다. 목표와 비교해 어땠는지 봐 주세요.`
      : `${dayjs(s.day).format('M월 D일')}, 아직 먹는 중입니다 (${s.askedAt} 기준). 남은 식사를 어떻게 할지 알려 주세요.`,
  )
  L.push('')

  L.push(`## 목표 (${s.goal.mode})`)
  L.push(
    `- 섭취 목표 ${s.goal.targetKcal ?? '-'}kcal · 단백질 ${s.goal.proteinG ?? '-'}g · 지방 ${
      s.goal.fatG ?? '-'
    }g · 탄수 ${s.goal.carbG ?? '-'}g`,
  )
  if (s.goal.avgExerciseKcal != null) {
    L.push(`- 이 목표에는 최근 4주 하루 평균 운동 소모 ${s.goal.avgExerciseKcal}kcal 이 이미 들어가 있습니다.`)
  }
  if (s.goal.bmr != null) L.push(`- 기초대사량 ${s.goal.bmr}kcal · 유지 ${s.goal.tdee ?? '-'}kcal`)
  L.push('')

  L.push('## 그날 실제 운동')
  if (s.today.energyUnknown) {
    L.push('- 활동 기록이 아직 없습니다 (쉬었거나, 동기화 전일 수 있습니다).')
  } else {
    L.push(`- 활동 소모 합계 ${s.today.exerciseKcal}kcal`)
    for (const a of s.today.activities) {
      L.push(`  - ${a.name ?? a.type ?? '활동'} · ${a.minutes ?? '-'}분 · ${a.kcal ?? '-'}kcal${a.avgHr ? ` · 평균 ${a.avgHr}bpm` : ''}`)
    }
    if (s.today.adjustedTargetKcal != null && s.goal.targetKcal != null) {
      const d = s.today.adjustedTargetKcal - s.goal.targetKcal
      L.push(
        `- 4주 평균보다 ${d >= 0 ? '더' : '덜'} 움직였으므로 **그날 기준 목표는 ${s.today.adjustedTargetKcal}kcal** 입니다 (${
          d >= 0 ? '+' : ''
        }${d}).`,
      )
    }
  }
  if (s.today.strength) {
    const st = s.today.strength
    L.push(`- 근력 ${st.sessions}세션 · ${st.sets}세트 · 볼륨 ${st.volumeKg.toLocaleString()}kg`)
    for (const e of st.exercises) {
      L.push(`  - ${e.name} ${e.sets}세트 · 최고 ${e.topWeightKg ?? '-'}kg · 총 ${e.totalReps}회`)
    }
    L.push('  (근력 기록에는 칼로리가 없습니다. 단백질 필요량과 회복 쪽으로만 참고하세요.)')
  }
  L.push('')

  L.push(s.kind === 'review' ? '## 하루 섭취' : '## 지금까지 섭취')
  L.push(
    `- 합계 ${Math.round(kcal)}kcal · 탄 ${s.intake.total.carb_g ?? '-'}g · 단 ${
      s.intake.total.protein_g ?? '-'
    }g · 지 ${s.intake.total.fat_g ?? '-'}g${s.intake.total.sugar_g != null ? ` · 당 ${s.intake.total.sugar_g}g` : ''}${
      s.intake.total.sodium_mg != null ? ` · 나트륨 ${s.intake.total.sodium_mg}mg` : ''
    }`,
  )
  if (target != null) {
    const left = Math.round(target - kcal)
    // 마감한 하루에 "남음" 은 말이 안 된다 — 끝난 날은 모자랐는지/넘겼는지로 적는다
    const gap =
      s.kind === 'review'
        ? left >= 0
          ? `${left}kcal 모자랍니다`
          : `${Math.abs(left)}kcal 넘겼습니다`
        : left >= 0
          ? `${left}kcal 남음`
          : `${Math.abs(left)}kcal 초과`
    L.push(`- 그날 기준 목표 ${target}kcal 대비 ${gap}`)
  }
  if (s.intake.remainingProteinG != null) {
    L.push(
      s.intake.remainingProteinG > 0
        ? `- 단백질 ${s.intake.remainingProteinG}g 더 필요`
        : `- 단백질 목표 달성 (${Math.abs(s.intake.remainingProteinG)}g 초과)`,
    )
  }
  if (s.intake.entries.length === 0) {
    L.push('- 아직 기록된 음식이 없습니다.')
  } else {
    for (const e of s.intake.entries) {
      L.push(
        `  - [${e.meal}] ${e.name} ${e.amount} · ${e.kcal ?? '-'}kcal (탄 ${e.carb_g ?? '-'} / 단 ${
          e.protein_g ?? '-'
        } / 지 ${e.fat_g ?? '-'})`,
      )
    }
  }
  L.push('')

  if (s.askedBefore.length) {
    L.push(`(오늘 이미 ${s.askedBefore.length}번 물어봤습니다: ${s.askedBefore.map((a) => `${a.at} ${KIND_LABEL[a.kind]}`).join(', ')})`)
    L.push('')
  }

  L.push('## 원하는 답')
  if (s.kind === 'review') {
    L.push('1. 목표 대비 잘 먹었는지 — 칼로리와 탄·단·지 각각. 그날 실제 운동량을 반영해서 판단해 주세요.')
    L.push('2. **문제가 된 음식을 콕 집어** 주세요. 무엇이 왜 문제였는지(칼로리·당·나트륨·포화지방·단백질 부족 등).')
    L.push('3. 그 음식 대신 무엇을 먹었으면 좋았을지 한두 개.')
  } else {
    L.push('1. 남은 식사로 무엇을 얼마나 먹으면 그날 기준 목표에 맞출 수 있는지 — 구체적인 음식과 양으로.')
    L.push('2. 단백질이 모자라면 그걸 먼저 채우는 쪽으로 제안해 주세요.')
    L.push('3. 이미 초과했다면 남은 끼니를 어떻게 줄일지 알려 주세요.')
  }
  L.push('')
  L.push('숫자는 위 값을 그대로 쓰세요 (다시 계산하지 마세요). 짧고 구체적으로, 한국어로 답해 주세요.')

  return L.join('\n')
}

// ── 조회 / 저장 ───────────────────────────────────────────

export async function fetchAdvice(day: string): Promise<FoodAdvice[]> {
  const { data, error } = await supabase
    .from('food_advice')
    .select(COLS)
    .eq('day', day)
    .order('created_at', { ascending: false })
  wrap(error)
  return (data ?? []) as unknown as FoodAdvice[]
}

/**
 * 물어본다.
 *
 * 질문 하나마다 **대화를 새로 판다.** 두 가지 이유가 있다.
 *  - 답이 어느 질문 것인지 트리거가 thread 로 찾는다 (0017).
 *  - 새 대화 = 새 에이전트 세션이라, 매번 이 스냅샷만 보고 답한다. 지난 조언이 섞이지 않는다.
 */
export async function askFoodAdvice(params: {
  day: string
  kind: AdviceKind
  plan: CoachPlan
  totals: DayTotals
  energy: DayEnergy
  prior: FoodAdvice[]
}): Promise<FoodAdvice> {
  const snapshot = buildSnapshot(params)
  const question = buildQuestion(snapshot)

  const thread = await createThread(
    `섭취 조언 · ${dayjs(params.day).format('M/D')} · ${KIND_LABEL[params.kind]}`,
  )

  const { data: msg, error: e1 } = await supabase
    .from('chat_messages')
    // ⚠️ `context` 는 비운다. 플러그인이 context 를 JSON 으로 풀어 질문 앞에 붙이는데(그것도
    //    6000자에서 잘린다), 우리 질문 글에는 같은 내용이 이미 사람이 읽을 형태로 다 들어 있다.
    //    같이 보내면 프롬프트가 두 배가 되고, 잘린 JSON 이 오히려 헷갈리게 만든다.
    //    스냅샷은 화면이 나중에 근거를 보여 주려고 `food_advice.snapshot` 에만 남긴다.
    .insert({ thread_id: thread.id, role: 'user', content: question, status: 'pending' })
    .select('id')
    .single()
  if (e1) throw new Error(e1.message)

  const { data, error } = await supabase
    .from('food_advice')
    .insert({
      day: params.day,
      kind: params.kind,
      question,
      snapshot,
      thread_id: thread.id,
      message_id: (msg as { id: string }).id,
    })
    .select(COLS)
    .single()
  wrap(error)
  return data as unknown as FoodAdvice
}

export async function deleteAdvice(id: string): Promise<void> {
  const { error } = await supabase.from('food_advice').delete().eq('id', id)
  wrap(error)
}

/** 답을 기다리는 게 있나 — 있으면 화면이 계속 훑는다 */
export function isAdviceWaiting(rows: FoodAdvice[]): boolean {
  return rows.some((r) => r.status === 'pending' || r.status === 'taken')
}
