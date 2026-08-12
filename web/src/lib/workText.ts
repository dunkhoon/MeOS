// 업무 항목의 문자열 처리 (순수 함수 — DB 접근과 섞지 않아 그대로 테스트할 수 있다).
// 데이터 접근은 ./work, 순서 계산은 ./reorder 가 맡는다.

import type { WorkItem } from './work'

/** 입력 문자열에서 URL 을 떼어내 제목/링크로 나눈다. ("제목 https://…" 붙여넣기 지원) */
export function splitTitleAndUrl(text: string): { title: string; url: string | null } {
  const m = text.match(/https?:\/\/\S+/)
  if (!m) return { title: text.trim(), url: null }
  const url = m[0]
  const title = text.replace(url, '').trim()
  return { title: title || url, url }
}

/** 이슈 번호 표기 — Redmine 은 #29580, JIRA 는 키 그대로(AT-13348). */
export function issueNo(system: 'redmine' | 'jira' | null, id: string): string {
  return system === 'jira' ? id : `#${id}`
}

/**
 * 복사 버튼이 클립보드에 넣을 문자열.
 *   Redmine  → `#29580 [토너먼트] 신석 점령전 전서버 토너먼트 개발 (아웃 게임)`
 *   JIRA     → `AT-13348 [260708C][테서랙트] 테서랙트 클리어시 기여도 보상이 …`
 *   직접 입력 → 제목 그대로
 * (`[토너먼트]` 같은 대괄호는 원본 이슈 제목에 이미 들어 있어 따로 붙이지 않는다)
 */
export function workCopyText(item: Pick<WorkItem, 'title' | 'origin' | 'btsSystem' | 'btsIssueId'>): string {
  const title = item.title.trim()
  if (item.origin === 'bts' && item.btsSystem && item.btsIssueId) {
    return `${issueNo(item.btsSystem, item.btsIssueId)} ${title}`.trim()
  }
  return title
}

/**
 * URL 입력칸에 적은 값을 정리한다. 스킴을 빼먹는 경우가 흔해서 붙여준다.
 * 비었으면 null → 링크 제거.
 */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  // 점이 있는 도메인 꼴이면 https 를 붙인다. 사내 호스트명처럼 판단이 어려운 건 그대로 둔다
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(s) || /^localhost(?::\d+)?(?:[/?#]|$)/i.test(s)) {
    return `https://${s}`
  }
  return s
}
