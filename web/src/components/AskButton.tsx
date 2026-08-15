import { useNavigate } from 'react-router-dom'

// 화면에서 바로 물어보는 버튼.
//
// 지금 보고 있는 수치를 그대로 실어 보낸다 — 에이전트가 도구를 안 불러도 첫 답이 정확해진다.
// (더 필요하면 에이전트가 meos_* 도구로 직접 더 읽는다)

export function AskButton({
  question,
  context,
  label = '물어보기',
  title,
}: {
  question: string
  context?: unknown
  label?: string
  title?: string
}) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className="ask-btn"
      title={title ?? `어시스턴트에게: ${question}`}
      onClick={() => navigate('/assistant', { state: { question, context } })}
    >
      ✦ {label}
    </button>
  )
}
