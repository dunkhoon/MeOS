// 색 계산 도우미.
//
// 테마가 생기면서 색이 전부 `var(--h-blue)` 같은 토큰이 됐다. 예전처럼 `색 + '33'` 으로
// 투명도를 붙이면 `var(--h-blue)33` 이 되어 그냥 깨진다 — 값을 모르는 채로 섞어야 한다.

/** `color` 를 `pct`% 만 남기고 투명하게. 토큰(var(--x))이든 hex 든 똑같이 동작한다. */
export function alpha(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

/**
 * 색을 **글자**로 쓸 때 통과시킨다.
 *
 * 팔레트 색(`var(--h-*)`)은 차트 선·점·막대를 **칠하는** 색이다. 그대로 글자에 얹으면
 * 밝은 테마에서 안 읽힌다 (실측 최악 2.15:1). `--ink-*` 는 같은 색상·채도에 밝기만
 * 테마별 한계로 조인 값이다 (정의는 `index.css` 의 ink 블록).
 *
 * 의미 토큰(`--ok` 등)은 이미 ink 에 엮여 있고, 토큰이 아닌 값(구글 캘린더 색 등)은
 * 그대로 돌려준다 — 그런 값은 애초에 글자색으로 쓰면 안 되고 배경·점으로 써야 한다.
 */
export function ink(color: string): string
export function ink(color: string | undefined): string | undefined
export function ink(color: string | undefined): string | undefined {
  if (!color) return color
  const m = color.match(/^var\(--h-([a-z]+)\)$/)
  if (m) return `var(--ink-${m[1]})`
  return color === 'var(--accent)' ? 'var(--ink-accent)' : color
}
