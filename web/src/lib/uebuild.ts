// UE 빌드 화면이 쓰는 순수 함수들. 판정은 전부 main(electron/uebuild.js)이 끝내 놓았고,
// 여기서는 **사람이 읽는 말로 바꾸는 일**만 한다.

/** 주체(누가 빌드를 걸었나)를 아이콘 한 글자로. 라벨과 짝지어 쓴다. */
export function originIcon(kind: UeOriginKind): string {
  switch (kind) {
    case 'vs':
      return '◆'
    case 'rider':
      return '◈'
    case 'editor':
      return '◐'
    case 'claude':
      return '✦'
    case 'codex':
      return '✧'
    case 'meos':
      return '▦'
    case 'msbuild':
      return '⚒'
    case 'vscode':
      return '❯'
    case 'terminal':
      return '▶'
    case 'explorer':
      return '🗀'
    case 'ci':
      return '⟳'
    default:
      return '?'
  }
}

/** 「ProjectTTEditor · Win64 · Development」 처럼. 못 알아본 칸은 빼고 붙인다. */
export function targetLabel(t: UeTargetSpec): string {
  return [t.target, t.platform, t.configuration].filter(Boolean).join(' · ') || '(대상 불명)'
}

/** 경로에서 파일명만. Windows·POSIX 구분자 둘 다 받는다. */
export function baseName(p: string | null | undefined): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** 경과 시간 — 1분 미만은 초, 그 뒤로는 분:초, 한 시간 넘으면 시간까지. */
export function fmtElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}분 ${String(rs).padStart(2, '0')}초`
  const h = Math.floor(m / 60)
  return `${h}시간 ${String(m % 60).padStart(2, '0')}분`
}

/** UBT 가 적어 준 초 단위 총 시간 (끝난 빌드용). */
export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  return fmtElapsed(sec * 1000)
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return sameDay ? hms : `${d.getMonth() + 1}/${d.getDate()} ${hms}`
}

export const PHASE_LABEL: Record<string, string> = {
  prepare: '준비 중',
  compile: '컴파일',
  link: '링크',
  done: '완료',
  uptodate: '고칠 것 없음',
  error: '오류',
}

export function phaseLabel(phase: string | null | undefined): string {
  return (phase && PHASE_LABEL[phase]) || '—'
}

/**
 * 진행률 근거를 사람 말로.
 * 분산 빌드(FASTBuild)는 완료 표시를 안 찍어 **착수** 개수로 셀 수밖에 없다 —
 * 그걸 "완료" 라고 부르면 거짓말이 되므로 화면에도 그대로 적는다.
 */
export function basisLabel(basis: UeProgress['basis']): string {
  return basis === 'completed' ? '완료 기준' : '착수 기준'
}

export function pct(p: UeProgress | null | undefined): number {
  if (!p || !p.total) return 0
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)))
}

/**
 * 지금 화면 맨 위에 뭐라고 띄울지.
 *
 * 프로세스가 곧 진실이다 — 로그는 늦게 따라오고, 끝난 뒤에도 남아 있다.
 * 그래서 "도는가" 는 builds 로 판정하고, 로그는 **무엇을 하고 있는지**에만 쓴다.
 */
export function headline(s: UeStatus | null): { state: 'running' | 'idle' | 'error' | 'unknown'; text: string } {
  if (!s) return { state: 'unknown', text: '확인 중…' }
  if (!s.ok) return { state: 'error', text: s.error || '상태를 읽지 못했습니다' }
  if (s.running) {
    const n = s.builds.length
    return { state: 'running', text: n > 1 ? `빌드 ${n}건 진행 중` : '빌드 중' }
  }
  return { state: 'idle', text: '도는 빌드 없음' }
}
