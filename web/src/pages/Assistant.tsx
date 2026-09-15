import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { errMsg } from '../lib/exercise'
import { Markdown } from '../lib/markdown'
import {
  askQuestion,
  deleteThread,
  fetchMessages,
  fetchThreads,
  isWaiting,
  type ChatMessage,
  type ChatThread,
} from '../lib/assistant'

// 어시스턴트 — 집 PC 의 OpenClaw 와 앱 안에서 바로 주고받는다.
//
// 답이 오기까지 보통 수십 초다. 기다리는 동안만 2초로 훑고, 답이 달리면 멈춘다.

const POLL_MS = 2000

/** 다른 화면의 '물어보기' 버튼이 navigate state 로 넘겨주는 것 */
export interface AskPayload {
  question: string
  context?: unknown
}

export default function Assistant() {
  const location = useLocation()
  const navigate = useNavigate()
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const seeded = useRef(false)

  const loadThreads = useCallback(async () => {
    try {
      const t = await fetchThreads()
      setThreads(t)
      return t
    } catch (e) {
      setError(errMsg(e))
      return []
    }
  }, [])

  const loadMessages = useCallback(async (id: string) => {
    try {
      setMessages(await fetchMessages(id))
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  // 첫 진입: 대화 목록을 읽고 가장 최근 것을 연다
  useEffect(() => {
    void (async () => {
      const t = await loadThreads()
      if (t.length) {
        setThreadId(t[0].id)
        await loadMessages(t[0].id)
      }
      setLoading(false)
    })()
  }, [loadThreads, loadMessages])

  const send = useCallback(
    async (content: string, context?: unknown, opts?: { newThread?: boolean }) => {
      const text = content.trim()
      if (!text || sending) return
      setSending(true)
      setError(null)
      try {
        // newThread 는 **인자로** 받는다. setThreadId(null) 로는 안 된다 —
        // 이미 만들어진 이 클로저는 다음 렌더까지 옛 threadId 를 그대로 본다.
        const r = await askQuestion({ threadId: opts?.newThread ? null : threadId, content: text, context })
        setThreadId(r.threadId)
        setInput('')
        await loadMessages(r.threadId)
        await loadThreads()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setSending(false)
      }
    },
    [threadId, sending, loadMessages, loadThreads],
  )

  // 다른 화면에서 '물어보기' 로 넘어온 경우 — **반드시 새 대화**에서 시작한다.
  //
  // ⚠️ 여기서 옛 대화에 얹으면 화면 질문이 **지난 대화의 맥락을 그대로 물려받는다.**
  //    플러그인이 대화(thread)마다 에이전트 세션을 가르기 때문이다(inbound.ts 참고) —
  //    실제로 며칠 전 대화에 나왔던 통증 부위를 오늘 몸상태 답에 끌어다 쓴 일이 있었다.
  //    예전엔 `setThreadId(null)` 로 비우려 했는데, setState 는 다음 렌더에 반영되므로
  //    바로 이어서 부른 send 는 여전히 **직전에 열려 있던 대화**로 보냈다. 인자로 넘긴다.
  useEffect(() => {
    const payload = location.state as AskPayload | null
    if (seeded.current || !payload?.question || loading) return
    seeded.current = true
    // state 를 지워 둔다. 안 지우면 뒤로 갔다 오면서 같은 질문이 또 나간다.
    navigate(location.pathname, { replace: true, state: null })
    void send(payload.question, payload.context, { newThread: true })
  }, [location, loading, navigate, send])

  // 답을 기다리는 동안만 훑는다
  useEffect(() => {
    if (!threadId || !isWaiting(messages)) return
    const id = window.setInterval(() => void loadMessages(threadId), POLL_MS)
    return () => window.clearInterval(id)
  }, [threadId, messages, loadMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const waiting = isWaiting(messages)

  async function startNew() {
    setThreadId(null)
    setMessages([])
    setInput('')
  }

  async function removeThread(id: string) {
    if (!window.confirm('이 대화를 지웁니다. 되돌릴 수 없습니다.')) return
    try {
      await deleteThread(id)
      const t = await loadThreads()
      if (threadId === id) {
        const next = t[0]?.id ?? null
        setThreadId(next)
        setMessages(next ? await fetchMessages(next) : [])
      }
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="page as-page">
      <header className="page-head ex-head">
        <div>
          <h2>어시스턴트</h2>
          <p className="muted">집 PC 의 OpenClaw 가 답합니다 · 내 운동·체형 기록을 직접 읽습니다</p>
        </div>
        <button className="sync-btn" onClick={() => void startNew()}>
          + 새 대화
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="as-body">
        <aside className="as-threads">
          {threads.length === 0 && !loading && <p className="muted small">아직 대화가 없습니다.</p>}
          {threads.map((t) => (
            <div key={t.id} className={`as-thread ${t.id === threadId ? 'active' : ''}`}>
              <button
                className="as-thread-btn"
                onClick={() => {
                  setThreadId(t.id)
                  void loadMessages(t.id)
                }}
              >
                <span className="as-thread-title">{t.title || '(제목 없음)'}</span>
                <span className="as-thread-date">{dayjs(t.updated_at).format('M/D HH:mm')}</span>
              </button>
              <button className="link-btn small as-thread-del" onClick={() => void removeThread(t.id)} title="대화 삭제">
                ✕
              </button>
            </div>
          ))}
        </aside>

        <section className="as-chat">
          <div className="as-log">
            {loading ? (
              <p className="muted">불러오는 중…</p>
            ) : messages.length === 0 ? (
              <div className="as-empty">
                <p className="muted">무엇이든 물어보세요.</p>
                <div className="as-suggest">
                  {[
                    '이번 주 운동 어땠어?',
                    '체지방 목표 잘 가고 있어?',
                    '요즘 근력 볼륨 어때?',
                    '내일 뭐 하면 좋을까?',
                  ].map((q) => (
                    <button key={q} className="ghost-btn" onClick={() => void send(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => <Bubble key={m.id} m={m} />)
            )}
            {waiting && (
              <div className="as-msg assistant">
                <div className="as-bubble as-thinking">
                  <span className="spinner" /> 생각하는 중…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form
            className="as-input"
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
          >
            <textarea
              className="as-textarea"
              rows={2}
              placeholder="질문을 입력하세요"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter 로 보내고 Shift+Enter 로 줄바꿈 — 채팅에서 기대하는 동작
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
            />
            <button className="sync-btn" type="submit" disabled={sending || !input.trim()}>
              {sending ? <span className="spinner" /> : '보내기'}
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="as-msg user">
        <div className="as-bubble">{m.content}</div>
        {m.status === 'error' && <div className="as-err">답하지 못했습니다: {m.error}</div>}
      </div>
    )
  }
  return (
    <div className="as-msg assistant">
      {/* 에이전트 답은 마크다운으로 온다 — 코드리뷰 화면과 같은 렌더러를 쓴다 */}
      <div className="as-bubble">
        <Markdown text={m.content} />
      </div>
      <div className="as-meta muted small">
        {dayjs(m.created_at).format('M/D HH:mm')}
        {m.model && ` · ${m.model}`}
      </div>
    </div>
  )
}
