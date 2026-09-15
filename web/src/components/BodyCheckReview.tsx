import { useEffect, type CSSProperties } from 'react'
import dayjs from 'dayjs'
import {
  LEVEL_META,
  SIGNAL_ADVICE,
  SIGNAL_LABEL,
  SUBJECTIVE_QUESTIONS,
  type BodyCheck,
  type SignalResult,
} from '../lib/bodyCheck'

// 캘린더에 찍히는 몸상태 아이콘과, 그걸 눌렀을 때 뜨는 리뷰.
//
// 운동 화면의 훈련 캘린더와 캘린더 화면이 같은 것을 보여 줘야 하므로 여기 한 벌만 둔다.
// 리뷰는 **판단 당시에 저장해 둔 값**(signals)만 그린다 — 웰니스가 나중에 다시 동기화돼
// 값이 바뀌어도 그날의 판정 근거는 그대로 남아야 한다.

export function BodyCheckIcon({ check, onClick }: { check: BodyCheck; onClick: () => void }) {
  const m = LEVEL_META[check.level]
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

  const m = LEVEL_META[check.level]
  const signals = (check.signals ?? []) as SignalResult[]
  const on = signals.filter((s) => s.tripped === true)
  const unknown = signals.filter((s) => s.tripped == null)
  const a = check.answers

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
          </div>
          {a?.area && <p className="small bc-area">부위: {a.area}</p>}
        </div>

        {on.length > 0 && (
          <div className="st-sheet-sec">
            <div className="st-sheet-label">그래서 오늘은</div>
            <ul className="bc-advice">
              {on.map((s) => (
                <li key={s.key}>{SIGNAL_ADVICE[s.key]}</li>
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
