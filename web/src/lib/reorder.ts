// 목록 순서 바꾸기 계산 (순수 함수 — DB/네트워크 의존 없음).

export const SORT_GAP = 1000

/** 간격이 이보다 좁아지면 중간값을 더 쪼개지 않고 전체를 다시 매긴다. */
const MIN_GAP = 0.001

/**
 * sort 오름차순으로 정렬된 목록에서 fromIndex 항목을 toIndex 로 옮겼을 때의 새 sort 값.
 *
 * 보통은 옮긴 항목 하나만 이웃 사이 중간값으로 바뀐다. 중간값을 계속 반으로 쪼개면
 * double 정밀도가 언젠가 고갈되므로, 이웃 간격이 바닥나면 전체를 0·1000·2000… 으로 다시 매긴다.
 *
 * @returns 실제로 바뀐 항목만. 바뀔 게 없으면 빈 배열.
 */
export function computeReorder<T extends { id: string; sort: number }>(
  list: T[],
  fromIndex: number,
  toIndex: number,
): { id: string; sort: number }[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length
  ) {
    return []
  }

  const next = [...list]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)

  const before = next[toIndex - 1]
  const after = next[toIndex + 1]

  if (!before && !after) return [] // 항목이 하나뿐

  // 이웃 간격이 바닥났으면 전체 재배치
  if (before && after && after.sort - before.sort < MIN_GAP) {
    return next.map((x, i) => ({ id: x.id, sort: i * SORT_GAP }))
  }

  let sort: number
  if (!before) sort = after.sort - SORT_GAP
  else if (!after) sort = before.sort + SORT_GAP
  else sort = (before.sort + after.sort) / 2

  return [{ id: moved.id, sort }]
}
