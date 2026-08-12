// 세션 규칙 기반 분석 — 랩·심박 데이터에서 산술로 뽑아내는 것들.
//
// LLM 이 아니다. LTHR 초과 시간, 심박 드리프트, 워크 구간 편차 같은 건 전부 계산이라
// 오프라인에서 즉시, 항상 같은 결과가 나온다. AI 코멘트는 이 위에 따로 얹는다.
//
// 판정 기준은 **LTHR 대비 %** 로 잡는다 (MaxHR 은 intervals.icu 활동 데이터에 없다).
// 러너마다 철학이 다르므로 임계값은 여기 한곳에 모아 두고 바꾸기 쉽게 했다.

import type { Lap, Streams } from './activityDetail'
import type { SessionKind } from './session'

export type Level = 'good' | 'info' | 'warn'

export interface Finding {
  level: Level
  /** 화면 아이콘 */
  icon: string
  text: string
}

export interface SessionAnalysis {
  /** 한 줄 판정 */
  verdict: '우수' | '양호' | '보통' | '주의' | '-'
  headline: string
  findings: Finding[]
}

/** 세션 종류별 워크 구간 목표 심박대 (LTHR 대비 %). */
const TARGET: Partial<Record<SessionKind, [number, number]>> = {
  tempo: [0.94, 0.99], // 역치 근처 — 넘지 않고 붙이는 게 목적
  interval: [0.95, 1.02],
  race: [0.95, 1.05],
  long: [0.8, 0.9],
  easy: [0, 0.82],
  recovery: [0, 0.78],
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
    // 반올림이 60초가 되면 5:60 같은 표기가 나온다
    s = 0
    m += 1
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * "주 세트" 를 찾는다.
 *
 * intervals.icu 는 워밍업·쿨다운까지 대부분 type=WORK 로 주기 때문에, WORK 를 다 합치면
 * 조깅과 인터벌이 섞여 편차·적중률이 엉망이 된다. 대신 intervals.icu 가 이미 묶어둔
 * **반복 그룹(group_id)** 을 쓴다 — 예: `284s@165bpm91rpm` × 6 = 1km 반복 6개.
 *
 * 주 세트 = 쓸 만한 그룹 중 **평균 심박이 가장 높은** 그룹.
 * 인터벌이 없는 이지런이면 그룹이 하나뿐이라 그 전체가 주 세트가 된다 (그래도 드리프트·일관성은 유효).
 */
function mainSet(laps: Lap[]): { reps: Lap[]; between: Lap[] } {
  const usable = laps.filter((l) => l.movingTime >= MIN_LAP_SEC && l.avgHr != null)
  const groups = new Map<string, Lap[]>()
  for (const l of usable) {
    if (!l.groupId) continue
    groups.set(l.groupId, [...(groups.get(l.groupId) ?? []), l])
  }
  if (!groups.size) return { reps: usable, between: [] }

  let best: Lap[] = []
  let bestHr = -1
  for (const g of groups.values()) {
    const hr = avg(g.map((l) => l.avgHr as number))
    if (hr > bestHr) {
      bestHr = hr
      best = g
    }
  }
  const reps = best.slice().sort((a, b) => a.index - b.index)

  // 반복 사이에 낀 구간 = 회복 (그룹 이름과 무관하게 위치로 판단한다)
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
  /** 같은 종류의 최근 세션 평균 심박 (비교용, 이번 활동 제외) */
  recentAvgHr?: number | null
}

export function analyzeSession({ kind, lthr, laps, streams, recentAvgHr }: AnalyzeInput): SessionAnalysis {
  const findings: Finding[] = []
  const { reps: work, between: rest } = mainSet(laps)

  // ── LTHR 초과 시간 ──
  const hr = (streams.heartrate ?? []).filter((v): v is number => v != null)
  if (lthr && hr.length) {
    const over = hr.filter((v) => v > lthr).length
    const ratio = over / hr.length
    if (over === 0) {
      findings.push({ level: 'good', icon: '✅', text: `LTHR(${lthr}bpm)를 한 번도 넘지 않았습니다 — 상한 준수` })
    } else if (ratio < 0.05) {
      findings.push({
        level: 'info',
        icon: 'ℹ️',
        // 역치 근처 세션에서 몇 % 스치는 건 흔하다 — 5% 넘어야 "의도보다 셌다" 고 본다
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

  // ── 워크 구간 편차 (일관성) ──
  if (work.length >= 2) {
    const hrs = work.map((l) => l.avgHr as number)
    const dev = sd(hrs)
    findings.push({
      level: dev <= 4 ? 'good' : dev <= 8 ? 'info' : 'warn',
      icon: dev <= 4 ? '✅' : dev <= 8 ? 'ℹ️' : '⚠️',
      text: `반복 ${work.length}개 HR 편차 ±${dev.toFixed(1)}bpm — ${dev <= 4 ? '매우 안정적' : dev <= 8 ? '무난한 편' : '들쭉날쭉했습니다'}`,
    })

    // ── 심박 드리프트 (전반 → 후반) ──
    const half = Math.floor(work.length / 2)
    const first = avg(hrs.slice(0, half))
    const last = avg(hrs.slice(-half))
    const drift = last - first
    findings.push({
      level: drift <= 5 ? 'good' : drift <= 10 ? 'info' : 'warn',
      icon: drift <= 5 ? '✅' : '📈',
      text: `드리프트 ${drift >= 0 ? '+' : ''}${drift.toFixed(0)}bpm — 후반 ${
        drift > 10 ? '심박이 크게 올랐습니다 (더위·수분·과부하 확인)' : drift > 5 ? '약간 상승, 정상 범위' : '거의 그대로 유지'
      }`,
    })

    // ── 워크 페이스 유지 ──
    const paces = work.map((l) => pace(l.speed)).filter((p): p is number => p != null)
    if (paces.length >= 2) {
      const drop = paces[paces.length - 1] - paces[0]
      findings.push({
        level: Math.abs(drop) <= 8 ? 'good' : 'info',
        icon: Math.abs(drop) <= 8 ? '✅' : 'ℹ️',
        text: `반복 페이스 ${paceText(paces[0])} → ${paceText(paces[paces.length - 1])} — ${
          Math.abs(drop) <= 8 ? '일정하게 유지' : drop > 0 ? `${Math.round(drop)}초 느려짐` : `${Math.round(-drop)}초 빨라짐`
        }`,
      })
    }

    // ── 목표 심박대 적중 ──
    const band = TARGET[kind]
    if (band && lthr) {
      const [lo, hi] = [Math.round(lthr * band[0]), Math.round(lthr * band[1])]
      const hit = hrs.filter((v) => v >= lo && v <= hi).length
      const near = hrs.filter((v) => v >= lo - 3 && v <= hi + 3).length - hit
      const rate = hit / hrs.length
      findings.push({
        level: rate >= 0.7 ? 'good' : rate >= 0.4 ? 'info' : 'warn',
        icon: '🎯',
        text: `반복 ${hrs.length}개 중 ${hit}개 목표존(${lo}~${hi}bpm) 적중${near ? ` + 근접 ${near}` : ''} — ${Math.round(
          rate * 100,
        )}%`,
      })
    }
  }

  // ── 회복 구간 ──
  if (rest.length && work.length) {
    const restMin = avg(rest.map((l) => l.minHr as number))
    const workAvg = avg(work.map((l) => l.avgHr as number))
    // 화면에 반올림해 보여주므로 판정도 반올림값으로 한다 (−12 인데 "얕다" 로 나오면 헷갈린다)
    const drop = Math.round(workAvg - restMin)
    const ok = drop >= 12
    findings.push({
      level: ok ? 'good' : 'info',
      icon: ok ? '✅' : 'ℹ️',
      text: `회복 구간 최저 HR 평균 ${restMin.toFixed(0)}bpm (반복 대비 −${drop}bpm) — ${
        ok ? '적절히 떨어졌습니다' : '회복이 얕습니다'
      }`,
    })
  }

  // ── 최근 같은 세션과 비교 ──
  if (recentAvgHr && work.length) {
    const now = avg(work.map((l) => l.avgHr as number))
    const diff = now - recentAvgHr
    findings.push({
      level: 'info',
      icon: '📊',
      text: `최근 같은 세션 평균 ${recentAvgHr.toFixed(0)} → 이번 ${now.toFixed(0)}bpm (${
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
    warns === 0
      ? goods >= 3
        ? '계획대로 잘 수행했습니다'
        : '무리 없이 마쳤습니다'
      : `경고 ${warns}건 — ${findings.find((f) => f.level === 'warn')!.text}`

  return { verdict, headline, findings }
}
