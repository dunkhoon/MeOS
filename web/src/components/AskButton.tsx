import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// 화면에서 바로 물어보는 버튼.
//
// 지금 보고 있는 수치를 그대로 실어 보낸다 — 에이전트가 도구를 안 불러도 첫 답이 정확해진다.
// (더 필요하면 에이전트가 meos_* 도구로 직접 더 읽는다)
//
// `compose` 를 켜면 보내기 전에 **내가 궁금한 것을 한 줄 덧붙일** 칸이 뜬다.
// 정해진 질문만 나가면 "후반에 왜 무너졌나" 같은, 그날 진짜 궁금한 건 물어볼 자리가 없다.

export function AskButton({
  question,
  context,
  label = '물어보기',
  title,
  compose = false,
  composeHint,
  placeholder,
}: {
  question: string
  context?: unknown
  label?: string
  title?: string
  /** 보내기 전에 추가 질문을 적는 칸을 띄운다 */
  compose?: boolean
  /** 칸 위에 붙는 안내 한 줄 */
  composeHint?: string
  placeholder?: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const go = (extra: string) => {
    const text = extra.trim()
    // 덧붙인 질문은 **맨 뒤**에 둔다. 앞에 두면 화면이 실어 보낸 맥락보다 먼저 읽혀
    // 에이전트가 기본 분석을 건너뛴다. 뒤에 두고 "이건 꼭 답하라" 고 적어 둔다.
    const full = text ? `${question}\n\n## 내가 추가로 묻는 것 (이 질문에 반드시 답해 줘)\n${text}` : question
    navigate('/assistant', { state: { question: full, context } })
  }

  return (
    <>
      <button
        type="button"
        className="ask-btn"
        title={title ?? (compose ? '추가로 묻고 싶은 것을 적고 보냅니다' : `어시스턴트에게: ${question}`)}
        onClick={() => (compose ? setOpen(true) : go(''))}
      >
        ✦ {label}
      </button>
      {open && (
        <ComposeModal
          title={label}
          hint={composeHint}
          placeholder={placeholder}
          onClose={() => setOpen(false)}
          onSend={(extra) => {
            setOpen(false)
            go(extra)
          }}
        />
      )}
    </>
  )
}

function ComposeModal({
  title,
  hint,
  placeholder,
  onSend,
  onClose,
}: {
  title: string
  hint?: string
  placeholder?: string
  onSend: (extra: string) => void
  onClose: () => void
}) {
  const [extra, setExtra] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal ask-compose" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <p className="muted small">{hint ?? '추가로 묻고 싶은 게 있으면 적어 주세요. 비워 두면 기본 분석만 받습니다.'}</p>
        <textarea
          ref={ref}
          rows={4}
          value={extra}
          placeholder={placeholder ?? '예: 후반에 페이스가 무너진 게 더위 때문일까?'}
          onChange={(e) => setExtra(e.target.value)}
          // 줄바꿈이 필요한 칸이라 Enter 로 보내지 않는다 (Ctrl/⌘+Enter 로 보낸다)
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSend(extra)
          }}
        />
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            취소
          </button>
          <button onClick={() => onSend(extra)}>보내기</button>
        </div>
        <p className="muted small ask-compose-tip">Ctrl+Enter 로도 보냅니다</p>
      </div>
    </div>
  )
}
