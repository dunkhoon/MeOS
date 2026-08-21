// 디스크 정리 화면의 순수 계산.
//
// 화면(Disk.tsx)에는 상태와 그리기만 두고, 표시 규칙은 여기에 모은다 —
// 실제 프로젝트를 스캔해 보면 후보가 70건을 넘어(플러그인마다 Intermediate·Binaries 가 하나씩)
// "무엇을 지울지" 를 사람이 못 고른다. 묶는 규칙이 이 화면의 핵심이다.

export function fmtBytes(n: number): string {
  const b = Number(n) || 0
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)}TB`
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)}GB`
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)}MB`
  if (b >= 1024) return `${Math.round(b / 1024)}KB`
  return `${b}B`
}

/** 이력 목록의 시각 — 오늘이면 시:분만, 아니면 날짜까지. 목록을 훑을 때 날짜가 눈에 걸리게. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export function riskLabel(risk: string): string {
  return risk === 'safe' ? '안전' : risk === 'caution' ? '주의' : '보존'
}

export function totalOf(rows: { size: number }[]): number {
  return rows.reduce((s, r) => s + r.size, 0)
}

/** 자식을 큰 순으로. main 에서 이미 정렬해 오지만 화면에서 다시 보장한다(순서가 곧 읽는 순서다). */
export function sortTree(node: DiskNode): DiskNode {
  return {
    ...node,
    children: node.children.slice().sort((a, b) => b.size - a.size).map(sortTree),
  }
}

export type CandRow =
  | { type: 'item'; key: string; item: DiskCandidate }
  | {
      type: 'group'
      key: string
      label: string
      risk: DiskRisk
      size: number
      count: number
      items: DiskCandidate[]
    }

const GB = 1024 ** 3

/**
 * 큰 것은 한 줄씩, 자잘한 것은 종류별로 묶는다.
 *
 * 실제 UE 프로젝트에서 이렇게 나온다:
 *   Intermediate 224.9GB · DerivedDataCacheChunks 85.4GB · .vs 77.8GB … (각각 한 줄)
 *   + 플러그인 Intermediate 30개 3.2GB (한 줄로 접힘)
 *
 * 묶는 기준은 종류 + 위험도다. 위험도가 다른 것을 한 줄에 묶으면 체크 한 번에
 * 안전한 것과 주의할 것이 같이 선택된다.
 */
export function groupCandidates(items: DiskCandidate[], flatAbove = GB): CandRow[] {
  const flat: DiskCandidate[] = []
  const buckets = new Map<string, DiskCandidate[]>()

  for (const it of items) {
    if (it.size >= flatAbove) {
      flat.push(it)
      continue
    }
    const key = `${it.kind || '정체 불명'}|${it.risk}`
    const list = buckets.get(key) ?? []
    list.push(it)
    buckets.set(key, list)
  }

  const rows: CandRow[] = flat.map((item) => ({ type: 'item' as const, key: item.path, item }))

  for (const [key, list] of buckets) {
    // 한 건뿐이면 묶을 이유가 없다 — 접힌 줄을 펼치게 만드는 건 손해다
    if (list.length === 1) {
      rows.push({ type: 'item', key: list[0].path, item: list[0] })
      continue
    }
    rows.push({
      type: 'group',
      key,
      label: `${list[0].kind || '정체 불명'} ${list.length}곳`,
      risk: list[0].risk,
      size: list.reduce((s, x) => s + x.size, 0),
      count: list.length,
      items: list.slice().sort((a, b) => b.size - a.size),
    })
  }

  return rows.sort((a, b) => sizeOf(b) - sizeOf(a))
}

function sizeOf(r: CandRow): number {
  return r.type === 'item' ? r.item.size : r.size
}

/** 그 줄이 담고 있는 경로들 (묶음이면 전부). 체크박스가 이 단위로 움직인다. */
export function pathsOf(r: CandRow): string[] {
  return r.type === 'item' ? [r.item.path] : r.items.map((i) => i.path)
}
