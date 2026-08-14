import { Fragment, type ReactNode } from 'react'

/**
 * 아주 작은 마크다운 렌더러 — 리뷰 결과(md)를 화면에 보여주려고 만들었다.
 *
 * 라이브러리를 붙이지 않은 이유는 하나다: **innerHTML 을 쓰고 싶지 않아서**.
 * 본문은 LLM 이 만든 글이라 무엇이 들어올지 모르는데, 여기서는 React 노드로만 조립하므로
 * 문자열이 마크업으로 해석될 여지가 없다.
 *
 * 지원: 제목 · 코드펜스 · 인용 · 목록(중첩 없음) · 표 · 구분선 · 문단,
 *       인라인은 `코드` **굵게** *기울임* [글](주소).
 */

/** 리뷰 프롬프트가 쓰게 시킨 심각도 표시 — 색 있는 칩으로 뽑아 준다. */
const SEVERITY: Record<string, string> = { 심각: 'sev-high', 주의: 'sev-mid', 제안: 'sev-low' }

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g

/** 한 줄 안의 인라인 문법을 React 노드로 바꾼다. */
function inline(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of src.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) out.push(src.slice(last, i))
    const t = m[0]
    const k = `${key}-i${n++}`
    if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('**') || t.startsWith('__')) out.push(<b key={k}>{t.slice(2, -2)}</b>)
    else if (t.startsWith('[')) {
      const close = t.indexOf('](')
      out.push(
        <a key={k} href={t.slice(close + 2, -1)} target="_blank" rel="noreferrer noopener">
          {t.slice(1, close)}
        </a>,
      )
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>)
    last = i + t.length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

/** `[심각] 제목` → 칩 + 제목 */
function headingContent(text: string, key: string): ReactNode {
  const m = text.match(/^\[(심각|주의|제안)\]\s*(.*)$/)
  if (!m) return inline(text, key)
  return (
    <>
      <span className={`md-sev ${SEVERITY[m[1]]}`}>{m[1]}</span>
      {inline(m[2], key)}
    </>
  )
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

const isDivider = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')

export function Markdown({ text }: { text: string }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let n = 0
  const key = () => `b${n++}`

  // 앞머리의 프론트매터는 파일용 메타데이터라 화면에는 안 보여준다
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) i = end + 1
  }

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    // 코드펜스
    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++])
      i++ // 닫는 펜스
      out.push(
        <pre key={key()} className="md-code">
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // 구분선
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key()} />)
      i++
      continue
    }

    // 제목
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = Math.min(6, h[1].length)
      const Tag = `h${level}` as 'h1'
      const k = key()
      out.push(
        <Tag key={k} className={`md-h md-h${level}`}>
          {headingContent(h[2].trim(), k)}
        </Tag>,
      )
      i++
      continue
    }

    // 인용
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      const k = key()
      out.push(
        <blockquote key={k} className="md-quote">
          {body.map((b, j) => (
            <p key={j}>{inline(b, `${k}-${j}`)}</p>
          ))}
        </blockquote>,
      )
      continue
    }

    // 표 — 헤더 + 구분줄이 있어야 표로 본다
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = tableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableRow(lines[i++]))
      const k = key()
      out.push(
        <div key={k} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${k}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c, `${k}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // 목록 — 이어지는 줄(들여쓴 줄)은 같은 항목에 붙인다
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      const ordered = /\d/.test(bullet[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (m) {
          items.push(m[3])
          i++
        } else if (/^\s+\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`
          i++
        } else break
      }
      const k = key()
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={k} className="md-list">
          {items.map((t, j) => (
            <li key={j}>{inline(t, `${k}-${j}`)}</li>
          ))}
        </List>,
      )
      continue
    }

    // 문단 — 빈 줄이 나올 때까지
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) {
      para.push(lines[i++])
    }
    const k = key()
    out.push(
      <p key={k} className="md-p">
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l, `${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    )
  }

  return <div className="md">{out}</div>
}
