// 세션 규칙 기반 분석 — 랩·심박 데이터에서 산술로 뽑아내는 것들.
//
// LLM 이 아니다. LTHR 초과 시간, 심박 드리프트, 반복 구간 편차 같은 건 전부 계산이라
// 오프라인에서 즉시, 항상 같은 결과가 나온다. AI 코멘트는 이 위에 따로 얹는다.
//
// **세션 종류마다 보는 항목이 다르다.** 이지런에 "반복 편차" 를 따지는 건 의미가 없고,
// 레이스에서 LTHR 초과는 실패가 아니라 당연한 일이다. 그래서 기준값만이 아니라
// **항목 구성 자체**를 종류별로 고른다 (세션 타입을 바꾸면 목록이 달라진다).
//
// 판정 기준은 **LTHR 대비 %** 로 잡는다 (MaxHR 은 intervals.icu 활동 데이터에 없다).
// 임계값은 여기 한곳에 모아 두었다.

import type { Lap, Streams } from './activityDetail'
import type { SessionKind } from './session'

export type Level = 'good' | 'info' | 'warn'

export interface Finding {
  level: Level
  icon: string
  text: string
}

export interface SessionAnalysis {
  verdict: '우수' | '양호' | '보통' | '주의' | '-'
  headline: string
  findings: Finding[]
}

/** 반복(인터벌) 구조를 따지는 세션 */
const REP_KINDS: SessionKind[] = ['tempo', 'interval', 'race']

/** 세션 종류별 목표 심박대 (LTHR 대비 %). 위쪽 값은 정속 세션에서 "상한" 으로도 쓴다. */
const TARGET: Record<SessionKind, [number, number] | null> = {
  race: [0.95, 1.05],
  interval: [0.95, 1.02],
  tempo: [0.94, 0.99],
  long: [0.8, 0.9],
  easy: [0, 0.82],
  recovery: [0, 0.78],
  other: null,
}

/** 이 시간(초) 미만 랩은 자동 랩 잡음으로 보고 계산에서 뺀다. */
const MIN_LAP_SEC = 20

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0
  const m = avg(xs)
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)))
}
const pace = (speed: number | null) => (speed && speed > 0.3 ? 1000 / speed : null)
const paceText = (secPerKm: number | null) => {
  if (!secPerKm) return '-'
  let m = Math.floor(secPerKm / 60)
  let s = Math.round(secPerKm % 60)
  if (s === 60) {
    s = 0
    m += 1
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * "주 세트" 를 찾는다 (반복 세션용).
 *
 * intervals.icu 는 워밍업·쿨다운까지 대부분 type=WORK 로 주므로 type 은 쓰지 않고,
 * intervals.icu 가 묶어둔 **반복 그룹(group_id)** 을 본다 — 예: `284s@165bpm` × 6.
 *
 * ⚠️ 단순히 "심박이 가장 높은 그룹" 으로 고르면 안 된다. 롱런 막판 **57초 스퍼트 하나**가
 * 14개 × 344초짜리 본체를 제치고 주 세트로 뽑히는 일이 실제로 있었다.
 * 그래서 **덩치가 있는 그룹만 후보**로 두고 그중에서 심박이 높은 것을 고른다.
 */
function mainSet(laps: Lap[]): { reps: Lap[]; between: Lap[] } {
  const usable = laps.filter((l) => l.movingTime >= MIN_LAP_SEC && l.avgHr != null)
  if (!usable.length) return { reps: [], between: [] }

  const groups = new Map<string, Lap[]>()
  for (const l of usable) {
    if (!l.groupId) continue
    groups.set(l.groupId, [...(groups.get(l.groupId) ?? []), l])
  }
  if (!groups.size) return { reps: usable, between: [] }

  const totalTime = usable.reduce((s, l) => s + l.movingTime, 0)
  const all = [...groups.values()]
  // 후보: 2회 이상 반복됐거나, 세션 시간의 15% 이상을 차지하는 그룹
  const candidates = all.filter(
    (g) => g.length >= 2 || g.reduce((s, l) => s + l.movingTime, 0) >= totalTime * 0.15,
  )
  const pool = candidates.length ? candidates : all

  let best = pool[0]
  let bestHr = -1
  for (const g of pool) {
    const hr = avg(g.map((l) => l.avgHr as number))
    if (hr > bestHr) {
      bestHr = hr
      best = g
    }
  }
  const reps = best.slice().sort((a, b) => a.index - b.index)

  // 반복 사이에 낀 구간 = 회복 (그룹 이름과 무관하게 위치로 판단)
  const lo = reps[0]?.index ?? 0
  const hi = reps[reps.length - 1]?.index ?? 0
  const repIdx = new Set(reps.map((l) => l.index))
  const between = laps.filter((l) => l.index > lo && l.index < hi && !repIdx.has(l.index) && l.minHr != null)

  return { reps, between }
}

export interface AnalyzeInput {
  kind: SessionKind
  lthr: number | null
  laps: Lap[]
  streams: Streams
  /** 이 활동 전체 평균 심박 (DB 값). 비교는 반드시 같은 단위끼리 한다. */
  activityAvgHr?: number | null
  /** 같은 종류 최근 세션들의 **활동 평균** 심박 */
  recentAvgHr?: number | null
}

export function analyzeSession(input: AnalyzeInput): SessionAnalysis {
  const { kind, lthr, laps, streams, activityAvgHr, recentAvgHr } = input
  const findings: Finding[] = []
  const isRep = REP_KINDS.includes(kind)
  const band = TARGET[kind]

  const hr = (streams.heartrate ?? []).filter((v): v is number => v != null)
  const steady = laps.filter((l) => l.movingTime >= MIN_LAP_SEC && l.avgHr != null).sort((a, b) => a.index - b.index)
  const { reps, between } = isRep ? mainSet(laps) : { reps: [] as Lap[], between: [] as Lap[] }
  /** 드리프트·페이스를 볼 대상: 반복 세션은 반복 구간만, 정속 세션은 전체 */
  const flow = isRep ? reps : steady

  // ── 강도 상한 (이지·회복·롱런) ─────────────────────────────
  // 이런 세션의 성패는 "얼마나 잘 눌렀나" 다.
  if (!isRep && band && lthr && hr.length) {
    const ceil = Math.round(lthr * band[1])
    const over = hr.filter((v) => v > ceil).length / hr.length
    findings.push({
      level: over <= 0.05 ? 'good' : over <= 0.2 ? 'info' : 'warn',
      icon: over <= 0.05 ? '✅' : over <= 0.2 ? 'ℹ️' : '⚠️',
      text:
        over <= 0.05
          ? `상한 ${ceil}bpm 이하를 ${Math.round((1 - over) * 100)}% 지켰습니다 — 목적에 맞게 눌렀습니다`
          : `상한 ${ceil}bpm 초과 ${Math.round(over * 100)}% — ${
              over <= 0.2 ? '조금 셌습니다' : '이 세션 의도보다 확실히 셌습니다'
            }`,
    })
  }

  // ── LTHR 초과 (반복 세션) ──────────────────────────────────
  if (isRep && lthr && hr.length) {
    const ratio = hr.filter((v) => v > lthr).length / hr.length
    if (kind === 'race') {
      findings.push({
        level: 'info',
        icon: 'ℹ️',
        text: `LTHR(${lthr}bpm) 초과 ${(ratio * 100).toFixed(0)}% — 레이스에서는 정상입니다`,
      })
    } else if (ratio === 0) {
      findings.push({ level: 'good', icon: '✅', text: `LTHR(${lthr}bpm)를 한 번도 넘지 않았습니다 — 상한 준수` })
    } else if (ratio < 0.05) {
      findings.push({
        level: 'info',
        icon: 'ℹ️',
        text: `LTHR(${lthr}bpm) 순간 초과 ${(ratio * 100).toFixed(1)}% — 자연 변동 범위`,
      })
    } else {
      findings.push({
        level: 'warn',
        icon: '⚠️',
        text: `LTHR(${lthr}bpm) 초과 구간이 ${(ratio * 100).toFixed(0)}% — 의도한 강도보다 높았습니다`,
      })
    }
  }

  // ── 반복 구간 일관성 · 목표존 · 회복 (반복 세션 전용) ──────
  if (isRep && reps.length >= 2) {
    const hrs = reps.map((l) => l.avgHr as number)
    const dev = sd(hrs)
    findings.push({
      level: dev <= 4 ? 'good' : dev <= 8 ? 'info' : 'warn',
      icon: dev <= 4 ? '✅' : dev <= 8 ? 'ℹ️' : '⚠️',
      text: `반복 ${reps.length}개 HR 편차 ±${dev.toFixed(1)}bpm — ${
        dev <= 4 ? '매우 안정적' : dev <= 8 ? '무난한 편' : '들쭉날쭉했습니다'
      }`,
    })

    if (band && lthr) {
      const [lo, hi] = [Math.round(lthr * band[0]), Math.round(lthr * band[1])]
      const hit = hrs.filter((v) => v >= lo && v <= hi).length
      const near = hrs.filter((v) => v >= lo - 3 && v <= hi + 3).length - hit
      const rate = hit / hrs.length
      findings.push({
        level: rate >= 0.7 ? 'good' : rate >= 0.4 ? 'info' : 'warn',
        icon: '🎯',
        text: `반복 ${hrs.length}개 중 ${hit}개 목표존(${lo}~${hi}bpm) 적중${
          near ? ` + 근접 ${near}` : ''
        } — ${Math.round(rate * 100)}%`,
      })
    }

    if (between.length) {
      const restMin = avg(between.map((l) => l.minHr as number))
      const drop = Math.round(avg(hrs) - restMin)
      const ok = drop >= 12
      findings.push({
        level: ok ? 'good' : 'info',
        icon: ok ? '✅' : 'ℹ️',
        text: `회복 구간 최저 HR 평균 ${restMin.toFixed(0)}bpm (반복 대비 −${drop}bpm) — ${
          ok ? '적절히 떨어졌습니다' : '회복이 얕습니다'
        }`,
      })
    }
  }

  // ── 심박 드리프트 ──────────────────────────────────────────
  // 롱런에서는 어느 정도 오르는 게 정상이라 기준을 느슨하게 잡는다.
  if (flow.length >= 4) {
    const hrs = flow.map((l) => l.avgHr as number)
    const half = Math.floor(hrs.length / 2)
    const drift = avg(hrs.slice(-half)) - avg(hrs.slice(0, half))
    const limit = kind === 'long' ? 10 : 5
    findings.push({
      level: drift <= limit ? 'good' : drift <= limit * 2 ? 'info' : 'warn',
      icon: drift <= limit ? '✅' : '📈',
      text: `드리프트 ${drift >= 0 ? '+' : ''}${drift.toFixed(0)}bpm — 후반 ${
        drift > limit * 2
          ? '심박이 크게 올랐습니다 (더위·수분·과부하 확인)'
          : drift > limit
            ? '약간 상승, 정상 범위'
            : '거의 그대로 유지'
      }`,
    })
  }

  // ── 페이스 유지 / 스플릿 ───────────────────────────────────
  const paces = flow.map((l) => pace(l.speed)).filter((p): p is number => p != null)
  if (isRep && paces.length >= 2) {
    const drop = paces[paces.length - 1] - paces[0]
    findings.push({
      level: Math.abs(drop) <= 8 ? 'good' : 'info',
      icon: Math.abs(drop) <= 8 ? '✅' : 'ℹ️',
      text: `반복 페이스 ${paceText(paces[0])} → ${paceText(paces[paces.length - 1])} — ${
        Math.abs(drop) <= 8 ? '일정하게 유지' : drop > 0 ? `${Math.round(drop)}초 느려짐` : `${Math.round(-drop)}초 빨라짐`
      }`,
    })
  } else if (!isRep && paces.length >= 4) {
    // 정속 세션은 전·후반 스플릿으로 본다 (랩마다 흔들려 첫/끝 한 개 비교는 신뢰도가 낮다)
    const half = Math.floor(paces.length / 2)
    const first = avg(paces.slice(0, half))
    const last = avg(paces.slice(-half))
    const diff = last - first
    const negative = diff < -3
    findings.push({
      level: Math.abs(diff) <= 15 ? 'good' : 'info',
      icon: negative ? '🔥' : Math.abs(diff) <= 15 ? '✅' : 'ℹ️',
      text: `전반 ${paceText(first)} → 후반 ${paceText(last)} — ${
        negative ? '네거티브 스플릿' : Math.abs(diff) <= 15 ? '고른 페이스' : `후반 ${Math.round(diff)}초 느려짐`
      }`,
    })
  }

  // ── 최근 같은 세션과 비교 ──────────────────────────────────
  // ⚠️ 반드시 **활동 평균끼리** 비교한다. 예전엔 이번 값만 "주 세트 평균" 을 써서
  // 롱런이 143 → 167 (+24) 처럼 엉뚱하게 나왔다 (양쪽 기준이 서로 달랐다).
  if (recentAvgHr && activityAvgHr) {
    const diff = activityAvgHr - recentAvgHr
    findings.push({
      level: 'info',
      icon: '📊',
      text: `최근 같은 세션 활동 평균 ${recentAvgHr.toFixed(0)} → 이번 ${activityAvgHr.toFixed(0)}bpm (${
        diff >= 0 ? '+' : ''
      }${diff.toFixed(0)})`,
    })
  }

  if (!findings.length) {
    return { verdict: '-', headline: '분석할 랩·심박 데이터가 없습니다.', findings: [] }
  }

  const warns = findings.filter((f) => f.level === 'warn').length
  const goods = findings.filter((f) => f.level === 'good').length
  const verdict: SessionAnalysis['verdict'] =
    warns >= 2 ? '주의' : warns === 1 ? '보통' : goods >= 3 ? '우수' : '양호'

  const headline =
    warns > 0
      ? `경고 ${warns}건 — ${findings.find((f) => f.level === 'warn')!.text}`
      : goods >= 3
        ? isRep
          ? '반복 구간을 계획대로 소화했습니다'
          : kind === 'long'
            ? '긴 거리를 안정적으로 마쳤습니다'
            : '목적에 맞게 눌러 뛰었습니다'
        : '무리 없이 마쳤습니다'

  return { verdict, headline, findings }
}
