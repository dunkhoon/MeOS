import { useEffect, useState, type ReactNode } from 'react'

// 차트 공통 규칙. 8개 차트가 같은 손맛을 갖도록 여기 한 곳에서 정한다.
//
// 모바일에서 **오른쪽 끝을 못 보는 문제**가 있었다. 원인이 둘이다.
//   1) 마지막 점이 컨테이너 가장자리(여백 8px)에 붙어 있어 손가락으로 집기 어렵다.
//      화면 가장자리라 스와이프 제스처와도 겹친다.
//   2) 눌러도 손가락이 그 지점을 덮고, 툴팁이 커서를 따라다녀 가장자리에서 잘린다.

/** 손가락으로 쓰는 기기인가. 마우스 화면은 지금 동작을 그대로 둔다. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(pointer: coarse)')
    const on = () => setCoarse(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return coarse
}

/**
 * 차트 여백. 터치 기기에서는 오른쪽을 넉넉히 줘서 **마지막 점이 가장자리에서 떨어지게** 한다.
 * `left` 는 Y축 눈금 때문에 음수로 당겨 쓰는 곳이 많아 인자로 받는다.
 */
export function chartMargin(coarse: boolean, left = -16) {
  return { top: 8, right: coarse ? 20 : 8, left, bottom: 0 }
}

/**
 * 툴팁을 차트 왼쪽 위에 **고정**한다 (터치 기기 한정).
 *
 * 커서를 따라다니면 ① 손가락이 값을 가리고 ② 오른쪽 끝에서 화면 밖으로 밀린다.
 * 고정해 두면 어디를 문질러도 같은 자리에서 읽히므로, 가장자리 지점도 문제없이 확인된다.
 */
export function pinnedTooltipProps(coarse: boolean) {
  return coarse ? ({ position: { x: 0, y: 0 }, wrapperStyle: { zIndex: 5 } } as const) : {}
}

export interface LatestItem {
  label: string
  value: string
  color?: string
  /** 직전 값 대비 변화 (부호 포함 문자열). 없으면 표시하지 않는다. */
  delta?: string
  /** 그 변화가 좋은 쪽인가. 지정하지 않으면 색을 입히지 않는다. */
  good?: boolean
}

/**
 * 차트 위에 붙는 "최근 값" 줄.
 *
 * 오른쪽 끝 = 가장 최근 값이고 그게 대개 제일 궁금한 값이다. 글로 띄워 두면
 * **터치 자체가 필요 없어진다.** (중간 지점은 여전히 눌러서 본다)
 *
 * 화면에 이미 같은 값이 KPI 로 떠 있는 카드에는 붙이지 않는다 — 중복은 노이즈다.
 */
export function LatestValues({ at, items }: { at?: string; items: LatestItem[] }) {
  const shown = items.filter((i) => i.value !== '-' && i.value !== '')
  if (!shown.length) return null
  return (
    <div className="chart-latest">
      <span className="chart-latest-at">{at ? `최근 ${at}` : '최근'}</span>
      {shown.map((i) => (
        <span key={i.label} className="chart-latest-item">
          {i.color && <i className="chart-latest-dot" style={{ background: i.color }} />}
          <span className="muted">{i.label}</span>
          <b>{i.value}</b>
          {i.delta && (
            <em className={i.good === undefined ? 'muted' : i.good ? 'delta-up' : 'delta-down'}>{i.delta}</em>
          )}
        </span>
      ))}
    </div>
  )
}

/** 직전 값 대비 변화를 문자열로. 값이 없거나 변화가 없으면 undefined. */
export function deltaText(cur: number | null | undefined, prev: number | null | undefined, unit = '', digits = 1): string | undefined {
  if (cur == null || prev == null) return undefined
  const d = Math.round((cur - prev) * 10 ** digits) / 10 ** digits
  if (d === 0) return undefined
  return `${d > 0 ? '+' : ''}${d}${unit}`
}

/** 시리즈에서 값이 있는 마지막 두 점을 고른다 (중간에 빈 날이 있어도 건너뛴다). */
export function lastTwo<T, V>(rows: T[], pick: (r: T) => V | null | undefined): { cur?: V; prev?: V; row?: T } {
  const withVal: { v: V; r: T }[] = []
  for (const r of rows) {
    const v = pick(r)
    if (v != null) withVal.push({ v, r })
  }
  const n = withVal.length
  if (!n) return {}
  return { cur: withVal[n - 1].v, prev: n > 1 ? withVal[n - 2].v : undefined, row: withVal[n - 1].r }
}

/** 카드 제목 옆에 두는 안내 — 터치 기기에서만 의미가 있다 */
export function TouchHint({ coarse, children }: { coarse: boolean; children: ReactNode }) {
  if (!coarse) return null
  return <p className="muted small chart-hint">{children}</p>
}
