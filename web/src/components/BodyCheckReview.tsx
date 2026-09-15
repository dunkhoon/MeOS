import { useEffect, type CSSProperties } from 'react'
import dayjs from 'dayjs'
import {
  ILLNESS_META,
  SIGNAL_ADVICE,
  SIGNAL_LABEL,
  SUBJECTIVE_QUESTIONS,
  faceFor,
  type BodyCheck,
  type SignalResult,
} from '../lib/bodyCheck'
import { AskButton } from './AskButton'

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

        <div className="modal-actions bc-review-actions">
          {/* 규칙이 판정하고 AI 는 해설한다 — 메모의 자유문장까지 읽는 건 규칙이 못 하는 일이다.
              판정·신호·답변·메모를 통째로 실어 보낸다 (BodyCoach 와 같은 방식). */}
          <AskButton {...askAboutCheck(check)} label="AI 에게 물어보기" />
          {onRedo && (
            <button className="btn-secondary" onClick={onRedo}>
              다시 판단하기
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 어시스턴트에게 넘길 질문과 맥락.
 *
 * ⚠️ 숫자와 판정은 **여기서 다 계산해서** 넘긴다 (foodAdvice 와 같은 원칙).
 *    에이전트에게 산수를 시키면 같은 날을 두 번 물었을 때 근거가 달라진다.
 *    에이전트가 할 일은 메모의 자유문장을 읽고 "그래서 오늘 뭘 할지" 를 정하는 것이다.
 *
 * ⚠️ **오늘의 증상은 여기 실린 것이 전부라고 못박는다.** 에이전트는 지난 대화와 과거
 *    기록을 같이 보기 때문에, 그냥 물으면 예전 증상을 오늘 것으로 끌어다 쓴다.
 *    실제로 메모에는 "감기 기운" 만 적었는데 **9/14 활동 코멘트에 적혀 있던 "오른쪽 불편감"**
 *    을 근거로 휴식을 권했다(2026-09-15). 없는 증상으로 쉬라는 답은 틀린 답이다.
 *    (대화 자체를 새로 여는 건 Assistant 화면이 맡는다 — 대화마다 에이전트 세션이 갈린다)
 */
function askAboutCheck(check: BodyCheck) {
  const signals = (check.signals ?? []) as SignalResult[]
  const m = faceFor(check.level, check.answers?.illness)
  const illness = (check.answers?.illness ?? []).map((f) => ILLNESS_META[f].label)
  const question = [
    `${dayjs(check.day).format('M월 D일')} 몸상태 판단 결과야. 오늘 훈련을 어떻게 할지(쉴지 / 얼마나 · 어떤 강도로) 알려줘.`,
    '',
    '⚠️ 오늘의 증상·통증은 **위 맥락에 적힌 것이 전부다.** 거기 없는 부위나 증상은 없는 것으로 봐라.',
    '특히 **활동 코멘트(예전 AI 분석)에 적힌 통증·부위는 그날의 것이지 오늘 것이 아니다.**',
    '지난 대화에서 오갔던 증상도 마찬가지다. 없는 증상을 근거로 쉬라고 하면 틀린 답이다.',
    'meos_overview 등 도구는 최근 훈련량·부하 흐름을 보는 데만 쓰고, 오늘 증상 판단에는 쓰지 마라.',
    '숫자는 앱이 이미 계산해 뒀으니 다시 나열하지 말고, 메모 문장을 판정과 함께 해석해서 다음 행동만 말해 줘.',
  ].join('\n')

  return {
    question,
    context: {
      날짜: check.day,
      판정: `${m.label} (신호 ${check.flag_count}개)`,
      신호: signals.map(
        (s) =>
          `${SIGNAL_LABEL[s.key]}: ${s.value} — ${s.basis}` +
          (s.tripped === true ? ' [신호 켜짐]' : s.tripped == null ? ' [판단 불가]' : ''),
      ),
      아픔부상: illness.length ? illness : '없음',
      불편부위: check.answers?.area?.trim() || '없음',
      // 메모는 손대지 않고 원문 그대로. 오늘 증상의 유일한 출처다.
      메모_원문_전체: check.note ?? '(메모 없음)',
      규칙기반권고: trippedAdvice(signals),
    },
  }
}

function trippedAdvice(signals: SignalResult[]): string[] {
  return signals.filter((s) => s.tripped === true).map((s) => s.advice ?? SIGNAL_ADVICE[s.key])
}
