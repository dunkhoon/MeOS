import { useMemo, useState, type CSSProperties } from 'react'
import dayjs from 'dayjs'
import {
  EMPTY_ANSWERS,
  ILLNESS_FLAGS,
  ILLNESS_META,
  SIGNAL_LABEL,
  SUBJECTIVE_QUESTIONS,
  byDayMap,
  evaluateBodyCheck,
  faceFor,
  illnessHint,
  recoveryHint,
  saveBodyCheck,
  type AnswerValue,
  type BodyCheck,
  type IllnessFlag,
  type SignalResult,
  type SubjectiveAnswers,
} from '../../lib/bodyCheck'
import { BodyCheckReview } from '../BodyCheckReview'
import { errMsg, type Activity, type Wellness } from '../../lib/exercise'

// "오늘 훈련해도 되나" 를 다섯 신호로 판단하는 자리. 컨디션/웰니스 카드 안에 붙는다.
//
// 수면·HRV·안정시심박은 이미 있는 웰니스에서 자동으로 나오고,
// 회복 시간과 주관적 신호(다리 무거움·뻣뻣함·통증)만 질문지로 받는다.

export function BodyCheckSection({
  wellness,
  activities,
  checks,
  onSaved,
}: {
  wellness: Wellness[]
  activities: Activity[]
  checks: BodyCheck[]
  onSaved: (check: BodyCheck) => void
}) {
  const [sheet, setSheet] = useState(false)
  const [review, setReview] = useState(false)

  const today = dayjs().format('YYYY-MM-DD')
  const check = byDayMap(checks).get(today) ?? null
  // 아파서 나쁜 날은 '나쁨' 이 아니라 **왜** 나쁜지를 얼굴로 보여 준다 (🤒 · 🤕)
  const m = check ? faceFor(check.level, check.answers?.illness) : null

  return (
    <div className="bc-bar">
      {check && m ? (
        <>
          <button
            type="button"
            className="bc-verdict"
            style={{ '--bc': m.color } as CSSProperties}
            onClick={() => setReview(true)}
            title="오늘 판단 리뷰 보기"
          >
            <span aria-hidden>{m.icon}</span>
            <span className="bc-verdict-text">
              오늘 몸상태 <b>{m.label}</b>
              <span className="muted"> · 신호 {check.flag_count}개</span>
            </span>
          </button>
          <button className="link-btn small" onClick={() => setSheet(true)}>
            다시 판단
          </button>
        </>
      ) : (
        <>
          <button type="button" className="sync-btn bc-start" onClick={() => setSheet(true)}>
            오늘 몸상태 판단
          </button>
          <span className="muted small">회복 시간 · 수면 · HRV · 안정시심박 · 주관적 신호</span>
        </>
      )}

      {sheet && (
        <BodyCheckSheet
          day={today}
          wellness={wellness}
          activities={activities}
          checks={checks}
          existing={check}
          onClose={() => setSheet(false)}
          onSaved={(c) => {
            setSheet(false)
            setReview(true)
            onSaved(c)
          }}
        />
      )}
      {review && check && (
        <BodyCheckReview
          check={check}
          onClose={() => setReview(false)}
          onRedo={() => {
            setReview(false)
            setSheet(true)
          }}
        />
      )}
    </div>
  )
}

/** 회복 시간 빠른 선택 — 시계에 뜨는 값이 대개 이 언저리다 */
const RECOVERY_CHIPS: { label: string; hours: number | null }[] = [
  { label: '없음', hours: 0 },
  { label: '6시간', hours: 6 },
  { label: '12시간', hours: 12 },
  { label: '24시간', hours: 24 },
  { label: '모름', hours: null },
]

function BodyCheckSheet({
  day,
  wellness,
  activities,
  checks,
  existing,
  onClose,
  onSaved,
}: {
  day: string
  wellness: Wellness[]
  activities: Activity[]
  checks: BodyCheck[]
  existing: BodyCheck | null
  onClose: () => void
  onSaved: (check: BodyCheck) => void
}) {
  // 지난 판단에서 받아 둔 회복 시간을 지금 시점으로 굴려 기본값으로 쓴다 (가민이 API 로 안 준다)
  const hint = useMemo(() => recoveryHint(checks, activities), [checks, activities])
  // 감기·부상은 하루로 안 끝난다 — 지난 판단 것을 켜 둔 채로 시작하고 아래에서 다시 물어본다
  const carried = useMemo(() => illnessHint(checks), [checks])
  const [recovery, setRecovery] = useState<number | null>(hint ? hint.hours : null)
  const [answers, setAnswers] = useState<SubjectiveAnswers>(
    existing?.answers ?? { ...EMPTY_ANSWERS, illness: carried?.flags ?? [] },
  )
  const [note, setNote] = useState(existing?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const verdict = useMemo(
    () => evaluateBodyCheck({ wellness, day, recoveryHours: recovery, answers }),
    [wellness, day, recovery, answers],
  )
  const m = faceFor(verdict.level, answers.illness)
  // 자동으로 나오는 신호만 따로 — 질문지에서는 읽기만 한다
  const autoSignals = verdict.signals.filter((s) => s.key === 'sleep' || s.key === 'hrv' || s.key === 'restingHr')

  const set = (key: 'heaviness' | 'stiffness' | 'pain', v: AnswerValue) =>
    setAnswers((prev) => ({ ...prev, [key]: v }))

  const illness = answers.illness ?? []
  const toggleIllness = (f: IllnessFlag) =>
    setAnswers((prev) => {
      const cur = prev.illness ?? []
      return { ...prev, illness: cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f] }
    })

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const saved = await saveBodyCheck({ day, verdict, answers, recoveryHours: recovery, note })
      onSaved(saved)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="st-sheet-back" onClick={onClose}>
      <div className="st-sheet bc-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="몸상태 판단">
        <div className="st-sheet-head">
          <span>몸상태 판단 · {dayjs(day).format('M월 D일 (ddd)')}</span>
          <button className="link-btn small" onClick={onClose}>
            닫기
          </button>
        </div>

        {/* ① 자동으로 읽히는 신호 — 무엇을 보고 판단하는지 먼저 보여 준다 */}
        <div className="st-sheet-sec">
          <div className="st-sheet-label">가민 데이터에서 읽은 것</div>
          <ul className="bc-signals">
            {autoSignals.map((s: SignalResult) => (
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

        {/* ② 회복 시간 — 가민이 API 로 주지 않아 직접 받는다 */}
        <div className="st-sheet-sec">
          <div className="st-sheet-label">시계에 남은 회복 시간</div>
          <div className="bc-chips">
            {RECOVERY_CHIPS.map((c) => (
              <button
                key={c.label}
                type="button"
                className={`bc-chip ${recovery === c.hours ? 'active' : ''}`}
                onClick={() => setRecovery(c.hours)}
              >
                {c.label}
              </button>
            ))}
            <label className="bc-hours">
              <input
                type="number"
                min={0}
                max={96}
                step={0.5}
                value={recovery ?? ''}
                placeholder="직접"
                onChange={(e) => setRecovery(e.target.value === '' ? null : Number(e.target.value))}
              />
              시간
            </label>
          </div>
          {hint ? (
            <p className="muted small bc-hint">
              {dayjs(hint.from).format('M/D')} 판단에서 받은 값으로 계산 — 지금 {hint.hours}시간 남음.
              {hint.stale && ' 그 뒤로 활동이 있었으니 시계를 한 번 보세요.'}
            </p>
          ) : (
            <p className="muted small bc-hint">
              가민 Connect 가 회복 시간을 API 로 주지 않습니다(FR255 는 Training Readiness 미지원). 시계 ·
              Connect 앱에 뜬 값을 넣어 두면 다음부터는 남은 시간을 알아서 계산합니다.
            </p>
          )}
        </div>

        {/* ③ 주관적 신호 */}
        <div className="st-sheet-sec">
          <div className="st-sheet-label">지금 몸이 어떤가</div>
          {SUBJECTIVE_QUESTIONS.map((q) => (
            <div key={q.key} className="bc-q">
              <div className="bc-q-label">
                {q.label}
                <span className="muted small"> — {q.hint}</span>
              </div>
              <div className="bc-seg">
                {q.options.map((opt, i) => (
                  <button
                    key={opt}
                    type="button"
                    className={`bc-seg-btn ${answers[q.key] === i ? 'active' : ''} lv${i}`}
                    onClick={() => set(q.key, i as AnswerValue)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <input
            className="bc-area-input"
            type="text"
            placeholder="뻣뻣하거나 아픈 부위 (예: 오른쪽 종아리)"
            value={answers.area ?? ''}
            onChange={(e) => setAnswers((prev) => ({ ...prev, area: e.target.value }))}
          />
        </div>

        {/* ④ 아픔·부상 — 개수로 세는 게 아니라 판정을 덮는 항목이라 따로 둔다 */}
        <div className="st-sheet-sec">
          <div className="st-sheet-label">아픔 · 부상 (있으면 고르기)</div>
          <div className="bc-chips">
            <button
              type="button"
              className={`bc-chip ${illness.length === 0 ? 'active' : ''}`}
              onClick={() => setAnswers((prev) => ({ ...prev, illness: [] }))}
            >
              없음
            </button>
            {ILLNESS_FLAGS.map((f) => (
              <button
                key={f}
                type="button"
                className={`bc-chip ${illness.includes(f) ? 'active danger' : ''}`}
                title={ILLNESS_META[f].hint}
                onClick={() => toggleIllness(f)}
              >
                {ILLNESS_META[f].icon} {ILLNESS_META[f].label}
              </button>
            ))}
          </div>
          {carried && !existing && (
            <p className="muted small bc-hint">
              {dayjs(carried.from).format('M/D')} 판단에서 {carried.flags.map((f) => `'${ILLNESS_META[f].label}'`).join(' · ')}{' '}
              을 표시했어요 — <b>아직 그런가요?</b> 나았으면 '없음' 을 눌러 주세요.
            </p>
          )}
          <p className="muted small bc-hint">
            발열·몸살과 부상은 <b>다른 신호가 다 좋아도 '나쁨'</b> 으로 갑니다. 목 위 증상(감기 기운)만이면
            가볍게는 가능하되 강도를 올리지 않습니다.
          </p>
        </div>

        <div className="st-sheet-sec">
          <div className="st-sheet-label">메모 (선택)</div>
          <input
            className="bc-area-input"
            type="text"
            placeholder="오늘 컨디션에 대해 남길 말"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* 지금 답변 기준 판정 — 저장 전에 결과가 보인다 */}
        <div className="bc-verdict-big" style={{ '--bc': m.color } as CSSProperties}>
          <span className="bc-verdict-icon" aria-hidden>
            {m.icon}
          </span>
          <div>
            <div className="bc-verdict-label">
              {m.label}
              <span className="muted"> · 신호 {verdict.flagCount}개</span>
            </div>
            <div className="muted small">{m.summary}</div>
          </div>
        </div>

        {error && <p className="error small">{error}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button onClick={() => void save()} disabled={saving}>
            {saving ? '저장 중…' : existing ? '다시 저장' : '판단 저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
