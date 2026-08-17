// 숫자 입력칸 다루기.
//
// ⚠️ 파싱한 숫자를 그대로 입력칸 value 로 되돌려 넣으면 안 된다. 두 가지가 깨진다.
//    ① 소수점을 못 찍는다 — "0." 을 치는 순간 Number("0.") = 0 이 되어 칸이 "0" 으로
//       다시 그려지고 방금 찍은 점이 사라진다. 영원히 소수를 입력할 수 없다.
//    ② 숫자가 아닌 글자를 치면 NaN 이 값이 되고, 칸에 "NaN" 이 박혀 고칠 수도 없다.
//
//    그래서 **입력 중에는 원문(문자열)을 들고 있다가** 저장할 때만 숫자로 바꾼다.
//    이 파일은 그 변환 규칙만 모아 둔 곳이다.

/**
 * 입력칸 문자열 → 값.
 *   ''(빈칸)  → null      "모름" (0 과 다르다 — 0 으로 두면 합계가 조용히 틀어진다)
 *   숫자      → number
 *   그 외     → undefined "잘못된 입력" (호출부가 막아야 한다)
 *
 * 천 단위 쉼표는 지운다 — "1,000" 을 치는 건 오타가 아니라 습관이다.
 */
export function parseNum(s: string): number | null | undefined {
  const t = s.replace(/,/g, '').trim()
  if (t === '') return null
  // "0." 이나 "-" 처럼 아직 덜 친 입력은 잘못된 게 아니라 "아직" 이다 → 0 으로 본다
  if (/^-?\d*\.?$/.test(t)) {
    const partial = Number(t.replace(/\.$/, '') || '0')
    return Number.isFinite(partial) ? partial : undefined
  }
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** 값 → 입력칸 문자열. null/undefined 는 빈칸. */
export function numText(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '' : String(v)
}

/** 입력 중에도 계속 부를 수 있는 검사 — 잘못된 글자가 섞였나 */
export function isBadNum(s: string): boolean {
  return parseNum(s) === undefined
}
