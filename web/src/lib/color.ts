// 색 계산 도우미.
//
// 테마가 생기면서 색이 전부 `var(--h-blue)` 같은 토큰이 됐다. 예전처럼 `색 + '33'` 으로
// 투명도를 붙이면 `var(--h-blue)33` 이 되어 그냥 깨진다 — 값을 모르는 채로 섞어야 한다.

/** `color` 를 `pct`% 만 남기고 투명하게. 토큰(var(--x))이든 hex 든 똑같이 동작한다. */
export function alpha(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}
