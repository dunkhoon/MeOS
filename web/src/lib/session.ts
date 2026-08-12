// 활동을 "세션 종류" 로 분류한다 — 훈련 캘린더의 색과 라벨에 쓴다.
//
// intervals.icu 는 세션 종류를 따로 주지 않으므로 **활동 이름에서 읽어낸다.**
// 이름을 그렇게 적지 않는 활동도 있어서, 못 알아보면 종목(Run/Ride…)으로 떨어뜨린다.
// 규칙 기반이라 틀릴 수 있고, 그때는 캘린더 색만 어긋난다 (수치는 항상 실제 데이터).

export type SessionKind = 'race' | 'interval' | 'tempo' | 'long' | 'recovery' | 'easy' | 'other'

export const SESSION_LABEL: Record<SessionKind, string> = {
  race: 'RACE',
  interval: 'INTERVAL',
  tempo: 'TEMPO',
  long: 'LONG',
  recovery: 'RECOVERY',
  easy: 'EASY',
  other: '',
}

/** 캘린더 셀 색. 강도가 높을수록 따뜻한 색. */
export const SESSION_COLOR: Record<SessionKind, string> = {
  race: '#f85149',
  interval: '#ff6b35',
  tempo: '#d29922',
  long: '#a371f7',
  recovery: '#3fb950',
  easy: '#4a7cff',
  other: '#8b92a4',
}

/**
 * 이름에서 세션 종류를 읽는다. 순서가 곧 우선순위 —
 * "SubT 1km x6" 처럼 여러 단서가 겹치면 더 구체적인 쪽(템포)이 이긴다.
 */
const RULES: { kind: SessionKind; re: RegExp }[] = [
  { kind: 'race', re: /\brace\b|대회|마라톤|하프|10k\s*race/i },
  { kind: 'recovery', re: /\brecovery\b|\bregen\b|회복|리커버리/i },
  { kind: 'tempo', re: /\btempo\b|\bsubt\b|\bthreshold\b|\bthr\b|템포|역치/i },
  { kind: 'interval', re: /\binterval\b|\breps?\b|\d+\s*[x×]\s*\d+|\bvo2\b|인터벌|반복/i },
  { kind: 'long', re: /\blong\b|롱런|장거리/i },
  { kind: 'easy', re: /\beasy\b|\bjog\b|\baerobic\b|이지|조깅/i },
]

export function sessionKind(a: { name?: string | null; type?: string | null }): SessionKind {
  const name = a.name ?? ''
  for (const r of RULES) if (r.re.test(name)) return r.kind
  return 'other'
}

/** 한 셀에 여러 활동이 있을 때 대표로 보여줄 것 — 강도가 높은 세션을 앞세운다. */
const PRIORITY: SessionKind[] = ['race', 'interval', 'tempo', 'long', 'recovery', 'easy', 'other']

export function primaryKind(kinds: SessionKind[]): SessionKind {
  for (const k of PRIORITY) if (kinds.includes(k)) return k
  return 'other'
}
