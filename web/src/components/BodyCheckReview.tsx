import { useEffect, useState, type CSSProperties } from 'react'
import dayjs from 'dayjs'
import {
  ILLNESS_META,
  SIGNAL_ADVICE,
  SIGNAL_LABEL,
  SUBJECTIVE_QUESTIONS,
  adviceBody,
  adviceSummary,
  askBodyCheckAdvice,
  faceFor,
  fetchBodyCheck,
  isAdviceWaiting,
  type BodyCheck,
  type SignalResult,
} from '../lib/bodyCheck'
import { Markdown } from '../lib/markdown'
import { errMsg } from '../lib/exercise'

/** 답은 보통 수십 초 뒤에 온다 — 기다리는 동안만 훑는다 (FoodAdvice 와 같은 방식) */
const POLL_MS = 2500

// 캘린더에 찍히는 몸상태 아이콘과, 그걸 눌렀을 때 뜨는 리뷰.
//
// 운동 화면의 훈련 캘린더와 캘린더 화면이 같은 것을 보여 줘야 하므로 여기 한 벌만 둔다.
// 리뷰는 **판단 당시에 저장해 둔 값**(signals)만 그린다 — 웰니스가 나중에 다시 동기화돼
// 값이 바뀌어도 그날의 판정 근거는 그대로 남아야 한다.

export function BodyCheckIcon({ check, onClick }: { check: BodyCheck; onClick: () => void }) {
  const m = faceFor(check.level, check.answers?.illness)
  return (
    <button
      type="button"
      className="bc-icon"
      style={{ '--bc': m.color } as CSSProperties}
      aria-label={`몸상태 ${m.label}`}
      title={`몸상태 ${m.label} · 신호 ${check.flag_count}개 — 눌러서 리뷰 보기`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <span aria-hidden>{m.icon}</span>
    </button>
  )
}

export function BodyCheckReview({
  check,
  onClose,
  onRedo,
}: {
  check: BodyCheck
  onClose: () => void
  /** 같은 날을 다시 판단할 길 (운동 화면에서만 넘긴다) */
  onRedo?: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 조언은 답이 늦게 오므로 이 화면이 직접 들고 훑는다. 리뷰를 닫아도 DB 트리거가 채워 두므로
  // 다시 열면 그대로 있다 (0019).
  const [row, setRow] = useState<BodyCheck>(check)
  const [asking, setAsking] = useState(false)
  const [askErr, setAskErr] = useState<string | null>(null)
  const [openAdvice, setOpenAdvice] = useState(false)
  useEffect(() => setRow(check), [check])

  const waiting = isAdviceWaiting(row)
  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(() => {
      void fetchBodyCheck(row.day)
        .then((r) => r && setRow(r))
        .catch(() => {
          /* 폴링 실패는 조용히 — 다음 주기에 다시 */
        })
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [waiting, row.day])

  async function ask() {
    setAsking(true)
    setAskErr(null)
    try {
      setRow(await askBodyCheckAdvice(row))
      setOpenAdvice(true)
    } catch (e) {
      setAskErr(errMsg(e))
    } finally {
      setAsking(false)
    }
  }

  const m = faceFor(check.level, check.answers?.illness)
  const signals = (check.signals ?? []) as SignalResult[]
  const on = signals.filter((s) => s.tripped === true)
  const unknown = signals.filter((s) => s.tripped == null)
  const a = check.answers
  const illness = a?.illness ?? []

  return (
    <div className="st-sheet-back" onClick={onClose}>
      <div className="st-sheet bc-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="몸상태 리뷰">
        <div className="st-sheet-head">
          <span>몸상태 · {dayjs(check.day).format('M월 D일 (ddd)')}</span>
          <button className="link-btn small" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="bc-verdict-big" style={{ '--bc': m.color } as CSSProperties}>
          <span className="bc-verdict-icon" aria-hidden>
            {m.icon}
          </span>
          <div>
            <div className="bc-verdict-label">
              {m.label}
              <span className="muted"> · 신호 {check.flag_count}개</span>
            </div>
            <div className="muted small">{m.summary}</div>
          </div>
        </div>

        <div className="st-sheet-sec">
          <div className="st-sheet-label">신호 다섯 가지</div>
          <ul className="bc-signals">
            {signals.map((s) => (
              <li key={s.key} className={`bc-signal ${s.tripped === true ? 'on' : s.tripped == null ? 'unknown' : ''}`}>
                <i />
                <div>
                  <div className="bc-signal-top">
                    <b>{SIGNAL_LABEL[s.key]}</b>
                    <span>{s.value}</span>
                  </div>
                  <div className="muted small">{s.basis}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="st-sheet-sec">
          <div className="st-sheet-label">그날 답변</div>
          <div className="bc-answers">
            {SUBJECTIVE_QUESTIONS.map((q) => (
              <span key={q.key} className={`bc-answer ${a?.[q.key] ? 'on' : ''}`}>
                {q.short} <b>{q.options[a?.[q.key] ?? 0]}</b>
              </span>
            ))}
            {illness.map((f) => (
              <span key={f} className="bc-answer danger">
                {ILLNESS_META[f].icon} <b>{ILLNESS_META[f].label}</b>
              </span>
            ))}
          </div>
          {a?.area && <p className="small bc-area">부위: {a.area}</p>}
        </div>

        {on.length > 0 && (
          <div className="st-sheet-sec">
            <div className="st-sheet-label">그래서 오늘은</div>
            <ul className="bc-advice">
              {on.map((s) => (
                <li key={s.key}>{s.advice ?? SIGNAL_ADVICE[s.key]}</li>
              ))}
            </ul>
          </div>
        )}

        {check.note && (
          <div className="st-sheet-sec">
            <div className="st-sheet-label">메모</div>
            <p className="bc-note">{check.note}</p>
          </div>
        )}

        <p className="muted small">
          {dayjs(check.checked_at).format('M월 D일 HH:mm')} 에 판단 · 그때의 값으로 그립니다
          {unknown.length > 0 && ` · ${unknown.length}개는 데이터가 없어 판단에서 뺐습니다`}
        </p>

        {/* 규칙이 판정하고 AI 는 해설한다 — 메모의 자유문장을 읽는 건 규칙이 못 하는 일이다.
            답은 그날 판단에 붙어 남으므로 며칠 뒤에 열어도 무슨 말을 들었는지 보인다. */}
        <div className="st-sheet-sec bc-advice-sec">
          <div className="st-sheet-label">AI 조언</div>
          {row.advice_status === 'done' && row.advice ? (
            <>
              <p className="bc-advice-sum">{adviceSummary(row.advice)}</p>
              {adviceBody(row.advice) &&
                (openAdvice ? (
                  <div className="bc-advice-full">
                    <Markdown text={adviceBody(row.advice)} />
                  </div>
                ) : (
                  <button className="link-btn small" onClick={() => setOpenAdvice(true)}>
                    전체 보기 ▾
                  </button>
                ))}
              <p className="muted small bc-advice-meta">
                {row.advice_at ? dayjs(row.advice_at).format('M/D HH:mm') : ''}
                {row.advice_model ? ` · ${row.advice_model}` : ''}
                {/* 다시 판단한 뒤라면 이 조언은 옛 판정에 대한 답이다 — 조용히 두면 오해한다 */}
                {row.advice_at && row.advice_at < row.checked_at && ' · ⚠️ 다시 판단하기 전에 받은 답입니다'}
                {' · '}
                <button className="link-btn small" onClick={() => void ask()} disabled={asking}>
                  다시 묻기
                </button>
              </p>
            </>
          ) : waiting ? (
            <p className="muted small bc-advice-wait">
              <span className="spinner" /> 답을 기다리는 중… 집 PC 의 에이전트가 가져가면 수십 초 안에 옵니다. 닫아도
              됩니다 — 답은 이 날짜에 남습니다.
            </p>
          ) : (
            <>
              {row.advice_status === 'error' && (
                <p className="error small">답을 받지 못했습니다: {row.advice_error ?? '알 수 없는 오류'}</p>
              )}
              <button className="ask-btn" onClick={() => void ask()} disabled={asking}>
                ✦ {asking ? '보내는 중…' : row.advice_status === 'error' ? '다시 물어보기' : 'AI 에게 물어보기'}
              </button>
            </>
          )}
          {askErr && <p className="error small">{askErr}</p>}
        </div>

        {onRedo && (
          <div className="modal-actions">
            <button className="btn-secondary" onClick={onRedo}>
              다시 판단하기
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
