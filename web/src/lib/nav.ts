// 화면 목록 한 벌. 사이드바와 Quick Search 가 같은 걸 쓴다.
//
// 예전엔 QuickSearch 가 목록을 따로 들고 있어서, 화면을 추가해도 검색에는 안 나왔다
// (Perforce·휴지통이 그렇게 빠져 있었다). 목록이 둘이면 반드시 어긋난다.

export interface NavEntry {
  to: string
  label: string
  icon: string
  /** react-router NavLink 의 end (루트 경로용) */
  end?: boolean
  /** 데스크톱 앱에서만 쓸 수 있는 화면 */
  desktopOnly?: boolean
  /** 검색용 별칭 — 라벨과 표기가 다른 경우(영문/한글, 줄임말)를 위해 */
  keywords?: string[]
}

/**
 * Quick Search 순위. 낮을수록 위. -1 이면 결과에서 뺀다.
 * 라벨 앞부분 > 라벨 포함 > 별칭 앞부분 > 별칭 포함 순 — "퍼포스" 는 별칭으로 Perforce 를 찾는다.
 */
export function rankMatch(query: string, label: string, keywords?: readonly string[]): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const l = label.toLowerCase()
  if (l.startsWith(q)) return 0
  if (l.includes(q)) return 1
  const ks = (keywords ?? []).map((k) => k.toLowerCase())
  if (ks.some((k) => k.startsWith(q))) return 2
  if (ks.some((k) => k.includes(q))) return 3
  return -1
}

export const NAV: NavEntry[] = [
  { to: '/', label: '대시보드', icon: '▦', end: true, keywords: ['dashboard', '홈', 'home'] },
  { to: '/calendar', label: '캘린더', icon: '▤', keywords: ['calendar', '일정', '달력'] },
  // BTS 목록만 PC 전용 — 나머지는 모바일에서도 보인다
  { to: '/tasks', label: '업무', icon: '✔', keywords: ['tasks', '할일', 'todo', '루틴', 'bts', 'redmine', 'jira'] },
  {
    to: '/perforce',
    label: 'Perforce',
    icon: '⑂',
    desktopOnly: true,
    keywords: ['퍼포스', 'p4', '체인지리스트', 'cl', '서밋', 'submit'],
  },
  { to: '/exercise', label: '운동', icon: '◠', keywords: ['exercise', '활동', '훈련', 'intervals'] },
  {
    to: '/assistant',
    label: '어시스턴트',
    icon: '✦',
    keywords: ['assistant', 'ai', '챗', 'chat', '대화', '물어보기', 'openclaw'],
  },
  { to: '/report', label: '리포트', icon: '▧', keywords: ['report', '보고서', '요약'] },
  { to: '/trash', label: '휴지통', icon: '🗑', keywords: ['trash', '삭제', '복원'] },
  { to: '/settings', label: '설정', icon: '⚙', keywords: ['settings', '환경설정', 'config', '비밀번호'] },
]
