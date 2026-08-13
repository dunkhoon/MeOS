// 훈련 상세에서 쓰는 지표 한 벌.
//
// 그래프에 그리는 항목과 툴팁에만 뜨는 항목을 한 표로 관리한다 — 예전엔 그래프 쪽에만
// 표가 있어서, 같은 케이던스를 그래프는 93spm 으로 랩 표는 186spm 으로 보여주고 있었다.

import { paceFromSpeed } from './activityDetail'
import type { StreamKey } from './activityDetail'

export interface MetricSpec {
  key: StreamKey
  label: string
  /** 그래프 색 (테마 토큰). 그래프에 그릴 수 있는 항목만 갖는다 */
  color?: string
  /** 값 → 단위까지 붙인 표시 문자열 */
  fmt: (v: number) => string
  /** 세로축 눈금 (단위 없이 짧게) */
  tick?: (v: number) => string
  /** 그래프 토글에 넣을지 */
  plot?: boolean
  /** m/s 로 와서 작을수록 빠른 항목 — 축·정렬에서 따로 다뤄야 한다 */
  pace?: boolean
}

const r0 = (v: number) => String(Math.round(v))

/** 표시 순서 = 툴팁에 뜨는 순서. */
export const METRICS: MetricSpec[] = [
  {
    key: 'velocity_smooth',
    label: '페이스',
    color: 'var(--h-green)',
    plot: true,
    pace: true,
    fmt: (v) => `${paceFromSpeed(v)} /km`,
    tick: (v) => paceFromSpeed(v),
  },
  { key: 'heartrate', label: '심박수', color: 'var(--h-blue)', plot: true, fmt: (v) => `${r0(v)} bpm`, tick: r0 },
  { key: 'altitude', label: '고도', color: 'var(--h-cyan)', plot: true, fmt: (v) => `${r0(v)} m`, tick: r0 },
  { key: 'watts', label: '파워', color: 'var(--h-yellow)', plot: true, fmt: (v) => `${r0(v)} W`, tick: r0 },
  // intervals.icu 는 한쪽 발 기준(rpm)으로 준다 — 러닝에서 흔히 말하는 spm 은 그 두 배다
  {
    key: 'cadence',
    label: '케이던스',
    color: 'var(--h-purple)',
    plot: true,
    fmt: (v) => `${r0(v * 2)} spm`,
    tick: (v) => r0(v * 2),
  },
  { key: 'step_length', label: '보행 길이', fmt: (v) => `${(v / 1000).toFixed(2)} m` },
  {
    key: 'vertical_ratio',
    label: '수직 비율',
    color: 'var(--h-pink)',
    plot: true,
    fmt: (v) => `${v.toFixed(1)} %`,
    tick: (v) => v.toFixed(1),
  },
  { key: 'vertical_oscillation', label: '수직 진폭', fmt: (v) => `${(v / 10).toFixed(1)} cm` },
  { key: 'stance_time', label: '접지 시간', fmt: (v) => `${r0(v)} ms` },
]

export const PLOTTABLE = METRICS.filter((m) => m.plot)

export function metric(key: StreamKey): MetricSpec {
  return METRICS.find((m) => m.key === key) ?? METRICS[0]
}
