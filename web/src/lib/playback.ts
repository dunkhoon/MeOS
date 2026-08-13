// 훈련 재생 — 지도·그래프·랩을 하나의 커서(경과 시간, 초)로 묶는다.
//
// 순수 함수만 둔다. 화면 없이 테스트할 수 있어야 "3.2km 지점인데 랩은 2번" 같은
// 어긋남을 눈으로 찾지 않아도 된다.

/** 오름차순 배열에서 `t` 이하인 마지막 인덱스. 전부 크면 0, 비었으면 -1. */
export function indexAtTime(times: number[], t: number): number {
  if (!times.length) return -1
  if (t <= times[0]) return 0
  if (t >= times[times.length - 1]) return times.length - 1
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * `t` 시점의 값. 앞뒤로 선형 보간한다 — 다운샘플된 스트림은 점 간격이 수 초라
 * 그냥 가장 가까운 값을 쓰면 심박이 계단처럼 튄다.
 * 구멍(null)은 건너뛰지 않고 그대로 null 을 돌려준다 (없는 데이터를 지어내지 않게).
 */
export function sampleAt(times: number[], values: (number | null)[] | undefined, t: number): number | null {
  if (!values?.length || !times.length) return null
  const i = indexAtTime(times, t)
  if (i < 0) return null
  const a = values[i] ?? null
  if (i >= times.length - 1) return a
  const b = values[i + 1] ?? null
  if (a == null || b == null) return a
  const span = times[i + 1] - times[i]
  if (span <= 0) return a
  const f = Math.min(1, Math.max(0, (t - times[i]) / span))
  return a + (b - a) * f
}

export interface LapSpan {
  startT: number
  endT: number
}

/**
 * `t` 가 속한 랩의 인덱스(0-based). 어느 랩에도 안 걸리면 바로 앞 랩.
 * 랩 경계는 [startT, endT) 로 본다 — 경계 시각에서 두 랩이 동시에 잡히지 않게.
 */
export function lapAtTime(laps: LapSpan[], t: number): number {
  if (!laps.length) return -1
  if (t < laps[0].startT) return 0
  for (let i = laps.length - 1; i >= 0; i--) {
    if (t >= laps[i].startT) return i
  }
  return 0
}

/** 재생이 끝난(=완주한) 랩 수. 진행 표시 "3/11" 의 3. */
export function lapsDone(laps: LapSpan[], t: number): number {
  let n = 0
  for (const l of laps) if (t >= l.endT) n++
  return n
}

/**
 * 다음 프레임의 커서 위치.
 * `realMs` 는 실제로 흐른 시간, `total` 은 활동 전체 길이(초),
 * `baseSec` 는 1배속에서 전체를 재생하는 데 걸릴 시간(초).
 * 끝에 닿으면 total 에서 멈춘다 (되감기·순환 없음 — 훈련 재생은 한 번 보는 것이다).
 */
export function advance(cursor: number, realMs: number, total: number, speed: number, baseSec: number): number {
  if (total <= 0 || baseSec <= 0) return total
  const rate = (total / baseSec) * speed
  return Math.min(total, cursor + (realMs / 1000) * rate)
}
