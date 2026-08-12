// Perforce 파일 이동 계산 (순수 함수 — 화면·IPC 와 분리해 테스트할 수 있게).
//
// 여러 파일을 한 번에 옮길 수 있어서 경계 조건이 은근히 많다:
// 대상 CL 에 이미 있는 파일, 여러 CL 에 걸친 선택, 방금 만들어 목록에 없는 CL 등.

export type MovePlan = {
  /** 실제로 p4 reopen 을 걸 파일들 (이미 대상에 있는 건 빠진다) */
  moving: string[]
  /** 이동을 반영한 새 목록 — 화면에 먼저 보여줄 용도 */
  next: P4Change[]
  /** 되돌릴 때 쓸 기준 목록 (newCl 을 포함한 상태) */
  before: P4Change[]
}

/**
 * @param changes  현재 체인지리스트 목록
 * @param paths    옮길 파일 (depotFile)
 * @param toChange 대상 체인지리스트 번호 또는 'default'
 * @param newCl    방금 만들어 아직 changes 에 없는 체인지리스트
 */
export function planMove(
  changes: P4Change[],
  paths: string[],
  toChange: string,
  newCl?: P4Change,
): MovePlan {
  const before = newCl && !changes.some((c) => c.change === newCl.change) ? [...changes, newCl] : changes
  const wanted = new Set(paths)

  // 대상에 이미 있는 파일은 건너뛴다 (같은 CL 로 드롭했을 때 헛일 방지)
  const rows = new Map<string, P4File>()
  for (const c of before) {
    if (c.change === toChange) continue
    for (const f of c.files) if (wanted.has(f.depotFile)) rows.set(f.depotFile, f)
  }

  const moving = [...rows.keys()]
  if (!moving.length) return { moving, next: before, before }

  const movingSet = new Set(moving)
  const next = before.map((c) => {
    if (c.change === toChange) {
      return { ...c, files: [...c.files, ...moving.map((p) => ({ ...rows.get(p)!, change: toChange }))] }
    }
    return { ...c, files: c.files.filter((f) => !movingSet.has(f.depotFile)) }
  })

  return { moving, next, before }
}

/**
 * 선택 토글. Shift 범위는 기준점(anchor)부터 클릭한 행까지를 **추가**한다 —
 * 부분 선택 상태에서 범위를 넓혀갈 수 있도록 지우지 않는다.
 */
export function applyClick(
  selected: ReadonlySet<string>,
  files: readonly P4File[],
  index: number,
  opts: { shift?: boolean; anchor?: number | null } = {},
): Set<string> {
  const next = new Set(selected)
  const { shift, anchor } = opts
  if (shift && anchor != null && anchor >= 0 && anchor < files.length) {
    const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor]
    for (let i = lo; i <= hi; i++) next.add(files[i].depotFile)
    return next
  }
  const p = files[index].depotFile
  if (next.has(p)) next.delete(p)
  else next.add(p)
  return next
}

/** 한 체인지리스트 전체 선택/해제 (전부 선택돼 있으면 해제) */
export function toggleAll(selected: ReadonlySet<string>, files: readonly P4File[]): Set<string> {
  const next = new Set(selected)
  const allOn = files.length > 0 && files.every((f) => next.has(f.depotFile))
  for (const f of files) {
    if (allOn) next.delete(f.depotFile)
    else next.add(f.depotFile)
  }
  return next
}
