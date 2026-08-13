// 테마 — 널리 쓰이는 에디터 테마의 공식 팔레트를 그대로 옮겼다.
//
// 색 자체는 `index.css` 의 `:root[data-theme=…]` 블록에 있다. 여기엔 목록과 적용 함수만 둔다.
// 색을 CSS 에 두는 이유: 미리보기 조각(`[data-swatch=…]`)이 같은 블록을 재사용하므로
// 색을 두 벌 적을 필요가 없고, 첫 화면이 뜨기 전에 `index.html` 에서 바로 입힐 수 있다.

export type ThemeId =
  | 'meos'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'tokyo-night'
  | 'nord'
  | 'gruvbox'
  | 'one-dark'
  | 'catppuccin-latte'
  | 'github-light'
  | 'solarized-light'

export interface ThemeMeta {
  id: ThemeId
  name: string
  mode: 'dark' | 'light'
  /** 어디서 왔는지 — 고를 때 판단 근거가 된다 */
  note: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'meos', name: 'MeOS 기본', mode: 'dark', note: '거의 검정 + 주황' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', mode: 'dark', note: '파스텔, 요즘 가장 인기' },
  { id: 'dracula', name: 'Dracula', mode: 'dark', note: '보라·분홍, 오래된 정석' },
  { id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark', note: '남색 + 네온' },
  { id: 'nord', name: 'Nord', mode: 'dark', note: '차분한 북극 블루' },
  { id: 'gruvbox', name: 'Gruvbox Dark', mode: 'dark', note: '따뜻한 레트로' },
  { id: 'one-dark', name: 'One Dark', mode: 'dark', note: 'Atom·VS Code 최다 설치' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', mode: 'light', note: '파스텔 밝은 판' },
  { id: 'github-light', name: 'GitHub Light', mode: 'light', note: '가장 익숙한 밝은 화면' },
  { id: 'solarized-light', name: 'Solarized Light', mode: 'light', note: '눈이 편한 미색 종이' },
]

export const DEFAULT_THEME: ThemeId = 'meos'
export const THEME_KEY = 'pp:theme'

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v)
}

export function getTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (isThemeId(v)) return v
  } catch {
    /* localStorage 를 못 쓰면 기본값 */
  }
  return DEFAULT_THEME
}

export function applyTheme(id: ThemeId): void {
  const meta = THEMES.find((t) => t.id === id) ?? THEMES[0]
  const root = document.documentElement
  root.dataset.theme = meta.id
  // 스크롤바·기본 폼 컨트롤이 테마를 따라오게 한다 (안 주면 밝은 테마에 검은 스크롤바가 남는다)
  root.style.colorScheme = meta.mode
  // 모바일 주소창 색
  const meta_ = document.querySelector('meta[name="theme-color"]')
  if (meta_) meta_.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim())
}

export function setTheme(id: ThemeId): void {
  applyTheme(id)
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch {
    /* 저장 실패해도 이번 세션엔 적용된다 */
  }
}

/** 지금 테마가 밝은 계열인지 — 지도 타일처럼 CSS 밖에서 색을 골라야 하는 곳에서 쓴다. */
export function isLightTheme(): boolean {
  const id = document.documentElement.dataset.theme
  return THEMES.find((t) => t.id === id)?.mode === 'light'
}
