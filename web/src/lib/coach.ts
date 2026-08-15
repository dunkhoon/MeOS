import dayjs from 'dayjs'
import { METRIC_META, goalProgress, leanMassKg, type BodyGoal, type BodyMeasurement, type BodySettings, type NutritionLog } from './body'
import type { Activity } from './exercise'
import type { StrengthSession } from './strength'

// 목표에서 "오늘 뭘 어떻게" 를 뽑아내는 규칙 엔진.
//
// 전부 공식이다 — 오프라인에서 돌고, 같은 입력이면 언제나 같은 답이 나온다.
// 값이 흔들리면 어제 조언과 오늘 조언이 달라져서 따라갈 수가 없다.
//
// 기준으로 삼은 것들:
//  - 지방 1kg ≈ 7,700 kcal
//  - 감량 속도는 주당 체중의 0.5~1.0% 가 안전 구간. 넘기면 제지방이 같이 빠진다.
//  - 섭취를 기초대사량 아래로 내리지 않는다.
//  - 단백질은 체중이 아니라 **제지방량** 기준으로 잡는다 (체지방은 단백질을 안 쓴다).

const KCAL_PER_KG_FAT = 7700

export type CoachMode = 'cut' | 'bulk' | 'recomp' | 'maintain'

export const MODE_LABEL: Record<CoachMode, string> = {
  cut: '감량',
  bulk: '증량',
  recomp: '리컴포지션',
  maintain: '유지',
}

export interface Advice {
  level: 'good' | 'info' | 'warn'
  text: string
}

export interface CoachPlan {
  mode: CoachMode
  bmr: number | null
  /** 운동을 뺀 하루 소모 (BMR × 생활계수) */
  baseKcal: number | null
  /** 최근 4주 활동에서 뽑은 하루 평균 운동 소모 */
  exerciseKcal: number | null
  tdee: number | null
  targetKcal: number | null
  /** 유지 대비 적자(−)/잉여(+) */
  deltaKcal: number | null
  proteinG: number | null
  fatG: number | null
  carbG: number | null
  strengthPerWeek: number
  cardioMinPerWeek: number
  actualStrengthPerWeek: number
  actualCardioMinPerWeek: number
  /** 목표 달성에 필요한 주당 체중 변화(kg). 감량이면 음수. */
  neededKgPerWeek: number | null
  advice: Advice[]
}

/** 체지방률 목표를 체중 변화로 옮긴다 — 제지방량은 유지된다고 본다 */
function weightForBodyFatPct(weight: number, curPct: number, targetPct: number): number {
  const lean = weight * (1 - curPct / 100)
  return lean / (1 - targetPct / 100)
}

export function buildPlan(input: {
  measurements: BodyMeasurement[]
  goals: BodyGoal[]
  activities: Activity[]
  sessions: StrengthSession[]
  nutrition: NutritionLog[]
  settings: BodySettings
}): CoachPlan {
  const { measurements, goals, activities, sessions, nutrition, settings } = input
  const m = measurements.length ? measurements[measurements.length - 1] : null
  const lean = leanMassKg(m)
  const advice: Advice[] = []

  // ── 소모 ──
  // 인바디가 준 기초대사량을 쓴다. 없으면 제지방량 기반(Katch-McArdle)으로 채운다.
  const bmr = m?.bmr_kcal ?? (lean != null ? Math.round(370 + 21.6 * lean) : null)
  const baseKcal = bmr != null ? Math.round(bmr * settings.neat_factor) : null

  const since = dayjs().subtract(28, 'day')
  const recent = activities.filter((a) => a.start_date_local && dayjs(a.start_date_local).isAfter(since))
  const burned = recent.reduce((s, a) => s + (a.calories ?? 0), 0)
  const exerciseKcal = recent.length ? Math.round(burned / 28) : 0
  const tdee = baseKcal != null ? baseKcal + exerciseKcal : null

  // ── 목표에서 필요한 주당 체중 변화 ──
  const weight = m?.weight_kg ?? null
  let neededKgPerWeek: number | null = null

  const weightGoal = goals.find((g) => g.metric === 'weight_kg')
  const fatGoal = goals.find((g) => g.metric === 'body_fat_pct')
  const muscleGoal = goals.find((g) => g.metric === 'skeletal_muscle_kg')

  if (weightGoal && weight != null) {
    const p = goalProgress(weightGoal, measurements)
    if (p.weeksLeft > 0) neededKgPerWeek = (weightGoal.target_value - weight) / p.weeksLeft
  } else if (fatGoal && weight != null && m?.body_fat_pct != null) {
    const p = goalProgress(fatGoal, measurements)
    const targetWeight = weightForBodyFatPct(weight, m.body_fat_pct, fatGoal.target_value)
    if (p.weeksLeft > 0) neededKgPerWeek = (targetWeight - weight) / p.weeksLeft
  } else if (muscleGoal && weight != null) {
    // 근육만 목표면 린벌크 — 주당 체중의 0.25% 를 넘기지 않는다 (넘는 만큼은 지방이 된다)
    const p = goalProgress(muscleGoal, measurements)
    if (p.remaining != null && p.remaining > 0) neededKgPerWeek = Math.min(weight * 0.0025, p.weeksLeft > 0 ? p.remaining / p.weeksLeft : 0)
  }

  // ── 모드 ──
  const mode: CoachMode = ((): CoachMode => {
    if (!goals.length) return 'maintain'
    const losing = neededKgPerWeek != null && neededKgPerWeek < -0.05
    const gaining = neededKgPerWeek != null && neededKgPerWeek > 0.05
    if (losing && muscleGoal) return 'recomp'
    if (losing) return 'cut'
    if (gaining) return 'bulk'
    if (muscleGoal || fatGoal) return 'recomp'
    return 'maintain'
  })()

  // ── 섭취 ──
  let targetKcal: number | null = null
  let deltaKcal: number | null = null
  if (tdee != null) {
    let raw = neededKgPerWeek != null ? (neededKgPerWeek * KCAL_PER_KG_FAT) / 7 : 0
    // 적자는 유지의 25%, 잉여는 15% 까지. 그 이상은 각각 근손실·지방증가로 새어 나간다.
    const maxDeficit = -tdee * 0.25
    const maxSurplus = tdee * 0.15
    raw = Math.max(maxDeficit, Math.min(maxSurplus, raw))
    let t = Math.round((tdee + raw) / 10) * 10
    // 기초대사량 아래로는 절대 내리지 않는다
    if (bmr != null && t < bmr) t = Math.round(bmr / 10) * 10
    targetKcal = t
    deltaKcal = t - tdee
  }

  // ── 매크로 ──
  // 단백질: 감량 중엔 근육을 지키느라 더 먹는다
  const proteinPerLean = mode === 'cut' || mode === 'recomp' ? 2.2 : mode === 'bulk' ? 2.0 : 1.8
  const proteinG = lean != null ? Math.round(lean * proteinPerLean) : null
  // 지방: 호르몬 유지 최소선 위로 (체중당 0.8g)
  const fatG = weight != null ? Math.round(weight * 0.8) : null
  const carbG =
    targetKcal != null && proteinG != null && fatG != null
      ? Math.max(0, Math.round((targetKcal - proteinG * 4 - fatG * 9) / 4))
      : null

  // ── 운동 처방 ──
  const strengthPerWeek = mode === 'bulk' || mode === 'recomp' ? 4 : mode === 'cut' ? 3 : 2
  const cardioMinPerWeek = mode === 'cut' ? 240 : mode === 'bulk' ? 120 : 150

  const wSince = dayjs().subtract(28, 'day')
  const actualStrengthPerWeek =
    Math.round((sessions.filter((s) => dayjs(s.started_at).isAfter(wSince)).length / 4) * 10) / 10
  const cardioS = recent
    .filter((a) => a.type !== 'WeightTraining')
    .reduce((s, a) => s + (a.moving_time_s ?? 0), 0)
  const actualCardioMinPerWeek = Math.round(cardioS / 60 / 4)

  // ── 조언 ──
  if (!m) {
    advice.push({ level: 'info', text: '인바디 CSV 를 올리면 여기에 필요한 섭취량과 운동량이 계산됩니다.' })
  }
  if (!goals.length && m) {
    advice.push({ level: 'info', text: '목표를 세우면 유지 칼로리 대신 목표에 맞춘 섭취량을 알려 드립니다.' })
  }

  // 감량 속도 점검
  if (neededKgPerWeek != null && weight != null && neededKgPerWeek < 0) {
    const pctPerWeek = Math.abs(neededKgPerWeek) / weight
    if (pctPerWeek > 0.01) {
      advice.push({
        level: 'warn',
        text: `기한을 맞추려면 주당 ${Math.abs(neededKgPerWeek).toFixed(2)}kg (체중의 ${(pctPerWeek * 100).toFixed(
          1,
        )}%) 을 빼야 합니다. 주당 1% 를 넘으면 근육이 같이 빠집니다 — 목표 날짜를 미루는 편이 낫습니다.`,
      })
    } else if (pctPerWeek >= 0.003) {
      advice.push({ level: 'good', text: `주당 ${Math.abs(neededKgPerWeek).toFixed(2)}kg 은 안전한 감량 속도입니다.` })
    }
  }

  if (targetKcal != null && bmr != null && tdee != null && targetKcal <= bmr && deltaKcal != null && deltaKcal < 0) {
    advice.push({
      level: 'warn',
      text: `계산상 필요한 섭취가 기초대사량(${bmr}kcal) 아래라 ${targetKcal}kcal 로 막았습니다. 목표 기한이 무리입니다.`,
    })
  }

  if (mode === 'recomp') {
    advice.push({
      level: 'info',
      text: '체지방을 줄이면서 근육을 늘리는 구간입니다. 둘 다 느리게 갑니다 — 체중보다 인바디 수치를 보세요.',
    })
  }

  if (m?.body_fat_pct != null && fatGoal && fatGoal.target_value < 10 && settings.sex !== 'female') {
    advice.push({ level: 'warn', text: '체지방률 10% 미만은 오래 유지하기 어렵고 컨디션·호르몬에 영향을 줍니다.' })
  }

  // 목표별 진행 상황
  for (const g of goals) {
    const p = goalProgress(g, measurements)
    const meta = METRIC_META[g.metric]
    if (p.achieved) {
      advice.push({ level: 'good', text: `${meta.label} 목표 달성 — ${g.target_value}${meta.unit}.` })
      continue
    }
    if (p.actualPerWeek == null) continue
    if (p.neededPerWeek == null) continue
    const onTrack = Math.sign(p.actualPerWeek) === p.dir && Math.abs(p.actualPerWeek) >= Math.abs(p.neededPerWeek) * 0.8
    if (onTrack) {
      advice.push({
        level: 'good',
        text: `${meta.label}: 최근 추세 주당 ${p.actualPerWeek > 0 ? '+' : ''}${p.actualPerWeek}${meta.unit} — 기한 안에 닿습니다.`,
      })
    } else {
      advice.push({
        level: 'warn',
        text: `${meta.label}: 필요한 속도는 주당 ${p.neededPerWeek > 0 ? '+' : ''}${p.neededPerWeek}${
          meta.unit
        } 인데 최근 추세는 ${p.actualPerWeek > 0 ? '+' : ''}${p.actualPerWeek}${meta.unit} 입니다.${
          p.projectedDate ? ` 이대로면 ${dayjs(p.projectedDate).format('YYYY-MM-DD')} 도달.` : ''
        }`,
      })
    }
  }

  // 운동량 점검
  if (actualStrengthPerWeek + 0.4 < strengthPerWeek) {
    advice.push({
      level: 'warn',
      text: `근력 운동이 주 ${actualStrengthPerWeek}회입니다. ${MODE_LABEL[mode]} 구간에선 주 ${strengthPerWeek}회가 필요합니다${
        mode === 'cut' ? ' (근육을 지키는 쪽이 먼저입니다)' : ''
      }.`,
    })
  } else if (actualStrengthPerWeek >= strengthPerWeek) {
    advice.push({ level: 'good', text: `근력 운동 주 ${actualStrengthPerWeek}회 — 권장량을 채우고 있습니다.` })
  }

  if (actualCardioMinPerWeek < cardioMinPerWeek * 0.7) {
    advice.push({
      level: 'info',
      text: `유산소가 주 ${actualCardioMinPerWeek}분입니다. 권장은 주 ${cardioMinPerWeek}분(존2 위주)입니다.`,
    })
  }

  // 섭취 기록 점검 (최근 7일)
  const last7 = nutrition.filter((n) => dayjs(n.day).isAfter(dayjs().subtract(7, 'day')))
  const logged = last7.filter((n) => n.kcal != null)
  if (logged.length >= 3 && targetKcal != null) {
    const avg = Math.round(logged.reduce((s, n) => s + (n.kcal ?? 0), 0) / logged.length)
    const gap = avg - targetKcal
    if (Math.abs(gap) > targetKcal * 0.1) {
      advice.push({
        level: 'warn',
        text: `최근 ${logged.length}일 평균 ${avg}kcal — 목표보다 ${gap > 0 ? '+' : ''}${gap}kcal 입니다.`,
      })
    } else {
      advice.push({ level: 'good', text: `최근 ${logged.length}일 평균 ${avg}kcal — 목표 범위 안입니다.` })
    }
  }
  const proteinLogged = last7.filter((n) => n.protein_g != null)
  if (proteinLogged.length >= 3 && proteinG != null) {
    const avgP = Math.round(proteinLogged.reduce((s, n) => s + (n.protein_g ?? 0), 0) / proteinLogged.length)
    if (avgP < proteinG * 0.85) {
      advice.push({ level: 'warn', text: `단백질이 평균 ${avgP}g 으로 목표(${proteinG}g)에 못 미칩니다.` })
    }
  }

  return {
    mode,
    bmr,
    baseKcal,
    exerciseKcal,
    tdee,
    targetKcal,
    deltaKcal,
    proteinG,
    fatG,
    carbG,
    strengthPerWeek,
    cardioMinPerWeek,
    actualStrengthPerWeek,
    actualCardioMinPerWeek,
    neededKgPerWeek: neededKgPerWeek != null ? Math.round(neededKgPerWeek * 100) / 100 : null,
    advice,
  }
}
