import { useEffect, useState } from 'react'
import { CATEGORIES, CATEGORY_COLOR, addExercise, type StrengthExercise } from '../../lib/strength'
import { errMsg } from '../../lib/exercise'

// 세트 하나를 고르고 고치는 화면 부품. 두 곳이 같이 쓴다 —
// 운동 중인 세트 타이머(SetTracker)와, 이미 저장된 기록(StrengthCalendar).
//
// 두 곳의 차이는 **저장하는 곳뿐**이다. 진행 중이면 localStorage 를 고치고,
// 저장된 기록이면 서버 행을 고친다. 그래서 onSave 는 동기·비동기 둘 다 받고,
// 실패했을 때 시트를 열어 둔 채 이유를 보여 주는 것도 여기서 맡는다.

/** 고른 종목. id 가 null 인 건 종목 목록과 이어지지 않은, 이름뿐인 기록이다. */
export interface Picked {
  id: string | null
  name: string
}

export interface SetDraft {
  exerciseId: string | null
  exerciseName: string
  weightKg: number | null
  reps: number | null
}

export const WEIGHT_STEP = 2.5 // 바벨 원판 최소 증량

/** 빈 칸은 null(맨몸·미기록). 잘못 친 값은 NaN 으로 남겨 저장 버튼이 막히게 한다. */
export function numOrNull(s: string): number | null {
  return s.trim() === '' ? null : Number(s)
}

export function weightOk(w: number | null): boolean {
  return w == null || (Number.isFinite(w) && w >= 0)
}

export function repsOk(r: number | null): boolean {
  return r == null || (Number.isInteger(r) && r > 0)
}

// ── 종목 고르기 (+ 그 자리에서 새로 만들기) ───────────────
//
// 처음 하는 종목이 나오면 여기서 바로 만들 수 있어야 한다 — 시트를 닫고
// 아래 '종목 관리' 까지 내려갔다 오는 동안 휴식 시간이 그만큼 흘러간다.
export function ExercisePicker({
  exercises,
  picked,
  onPick,
  onExercisesChanged,
}: {
  exercises: StrengthExercise[]
  picked: Picked | null
  onPick: (p: Picked) => void
  onExercisesChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [cat, setCat] = useState<string>('chest')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = exercises.filter((e) => !e.archived)
  // 이름뿐인 기록(id 없음)을 고칠 때도 지금 고른 게 뭔지 보여야 한다 — 그땐 이름으로 짚는다
  const isPicked = (e: StrengthExercise) => (!picked ? false : picked.id ? picked.id === e.id : picked.name === e.name)
  // 감춘 종목으로 기록해 둔 세트를 고치는 중이면, 그 종목이 격자에 없어 아무것도 안 골라진 것처럼 보인다
  const missing = picked && !active.some(isPicked) ? picked.name : null

  async function create() {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await addExercise(n, cat)
      onPick({ id: made.id, name: made.name }) // 만들자마자 이 종목으로 시작하는 흐름이라 골라 둔다
      setName('')
      setAdding(false)
      onExercisesChanged()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {active.length === 0 && !adding && <p className="muted small">종목이 없습니다. 아래에서 하나 만들어 주세요.</p>}
      {missing && (
        <p className="muted small">
          지금 종목: <b>{missing}</b> (감춘 종목입니다 — 아래에서 다른 것을 고르면 바뀝니다)
        </p>
      )}

      {CATEGORIES.map((c) => {
        const list = active.filter((e) => (e.category ?? 'other') === c.key)
        if (!list.length) return null
        return (
          <div key={c.key} className="st-cat">
            <div className="st-cat-name">
              <i style={{ background: CATEGORY_COLOR[c.key] }} />
              {c.label}
            </div>
            <div className="st-ex-grid">
              {list.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`st-ex-btn ${isPicked(e) ? 'active' : ''}`}
                  onClick={() => onPick({ id: e.id, name: e.name })}
                >
                  {e.name}
                </button>
              ))}
            </div>
          </div>
        )
      })}

      {adding ? (
        <form
          className="st-newex"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <input
            className="em-input"
            placeholder="새 종목 이름 (예: 케이블 크로스오버)"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <select className="st-select" value={cat} onChange={(e) => setCat(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <button className="ghost-btn" type="submit" disabled={busy || !name.trim()}>
            {busy ? '추가 중…' : '추가'}
          </button>
          <button
            type="button"
            className="link-btn small"
            disabled={busy}
            onClick={() => {
              setAdding(false)
              setError(null)
            }}
          >
            취소
          </button>
        </form>
      ) : (
        <button type="button" className="st-ex-btn st-ex-new" onClick={() => setAdding(true)}>
          + 새 종목
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </>
  )
}

/** ± 로도 맞출 수 있는 숫자 칸 — 젖은 손으로 작은 키보드를 두드리는 것보다 빠르다. */
export function NumField({
  value,
  onChange,
  step,
  placeholder,
  inputMode,
}: {
  value: string
  onChange: (v: string) => void
  step: number
  placeholder: string
  inputMode: 'decimal' | 'numeric'
}) {
  // 칸에 이상한 값이 들어 있어도 ± 는 동작해야 한다 — 잘못 친 값을 되돌릴 길이 이것뿐이다
  const bump = (d: number) => {
    const n = numOrNull(value)
    const base = n != null && Number.isFinite(n) ? n : 0
    onChange(String(Math.max(0, Math.round((base + d) * 10) / 10)))
  }
  return (
    <div className="st-num">
      <button type="button" className="st-num-btn" onClick={() => bump(-step)}>
        −
      </button>
      <input
        className="st-num-input"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="st-num-btn" onClick={() => bump(step)}>
        +
      </button>
    </div>
  )
}

// ── 시트: 이미 넣은 내용 고치기 ──────────────────────────
export function SetEditSheet({
  title,
  exercises,
  initial,
  withReps,
  onExercisesChanged,
  onCancel,
  onSave,
}: {
  title: string
  exercises: StrengthExercise[]
  initial: SetDraft
  /** 돌고 있는 세트는 아직 횟수가 없다 — 그땐 종목·중량만 묻는다 */
  withReps: boolean
  onExercisesChanged: () => void
  onCancel: () => void
  /** 서버에 쓰는 쪽은 Promise 를 준다. 실패하면 시트를 닫지 않고 여기서 이유를 보여 준다. */
  onSave: (v: SetDraft) => void | Promise<void>
}) {
  const [picked, setPicked] = useState<Picked | null>({ id: initial.exerciseId, name: initial.exerciseName })
  const [weight, setWeight] = useState<string>(initial.weightKg != null ? String(initial.weightKg) : '')
  const [reps, setReps] = useState<string>(initial.reps != null ? String(initial.reps) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const w = numOrNull(weight)
  const r = numOrNull(reps)
  const ok = !!picked && weightOk(w) && repsOk(r)

  async function save() {
    if (!picked || !ok || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave({
        exerciseId: picked.id,
        exerciseName: picked.name,
        weightKg: w,
        reps: withReps ? r : initial.reps,
      })
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
    // 성공하면 부모가 시트를 닫는다 — 여기서 busy 를 되돌리지 않는다
  }

  return (
    <Sheet title={title} onCancel={onCancel}>
      <div className="st-sheet-sec">
        <div className="st-sheet-label">종목</div>
        <ExercisePicker
          exercises={exercises}
          picked={picked}
          onPick={setPicked}
          onExercisesChanged={onExercisesChanged}
        />
      </div>

      <div className="st-sheet-sec">
        <div className="st-sheet-label">중량 (kg) · 비우면 맨몸</div>
        <NumField value={weight} onChange={setWeight} step={WEIGHT_STEP} placeholder="맨몸" inputMode="decimal" />
      </div>

      {withReps && (
        <div className="st-sheet-sec">
          <div className="st-sheet-label">횟수 · 비워도 됩니다</div>
          <NumField value={reps} onChange={setReps} step={1} placeholder="—" inputMode="numeric" />
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      <button type="button" className="st-big-btn go" disabled={!ok || busy} onClick={() => void save()}>
        {busy ? '저장 중…' : '저장'}
      </button>
    </Sheet>
  )
}

export function Sheet({
  title,
  onCancel,
  children,
}: {
  title: string
  onCancel: () => void
  children: React.ReactNode
}) {
  // 세트 중에 뒤로가기 대신 Esc 로 빠져나올 수 있게 (PC에서 쓸 때)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="st-sheet-back" onClick={onCancel}>
      <div className="st-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="st-sheet-head">
          <span>{title}</span>
          <button className="link-btn small" onClick={onCancel}>
            취소
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
