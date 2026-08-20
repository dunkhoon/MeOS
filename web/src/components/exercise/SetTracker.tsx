import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fmtClock,
  fmtDur,
  readLive,
  saveLiveSession,
  volumeOf,
  writeLive,
  type LiveSession,
  type StrengthExercise,
} from '../../lib/strength'
import {
  ExercisePicker,
  NumField,
  Sheet,
  SetEditSheet,
  WEIGHT_STEP,
  numOrNull,
  repsOk,
  weightOk,
  type Picked,
  type SetDraft,
} from './SetSheets'
import { errMsg } from '../../lib/exercise'

// 세트 타이머. 헬스장에서 폰 한 손으로 쓰는 화면이라 버튼이 크고, 한 번에 하나만 묻는다.
//
// 흐름: [운동 시작] → [세트 시작] → 종목·중량 고르기 → 타이머 → [세트 중단] → 횟수 →
//       (휴식은 그 사이 시간으로 자동) → [다음 세트] … → [운동 종료]
//
// 잘못 넣은 값은 그 자리에서 고친다 — 돌고 있는 세트는 종목 이름 옆 「수정」,
// 이미 기록한 세트는 목록에서 그 줄을 누르면 종목·중량·횟수를 모두 바꿀 수 있다.
// 아직 서버에 올리기 전이라 로컬 기록만 고치면 된다.

type SheetState =
  | { kind: 'pick' }
  | { kind: 'reps' }
  | { kind: 'editCurrent' }
  | { kind: 'editSet'; seq: number }
  | null

/** 화면이 꺼지면 타이머를 못 본다. 세션 도는 동안만 잠금을 잡는다. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    type Sentinel = { released: boolean; release: () => Promise<void> }
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }).wakeLock
    if (!wl) return
    let sentinel: Sentinel | null = null
    let dropped = false

    const acquire = async () => {
      try {
        sentinel = await wl.request('screen')
      } catch {
        /* 배터리 절약 모드 등에서 거부된다 — 기능 자체는 그대로 돌아간다 */
      }
    }
    // 탭이 뒤로 갔다 오면 잠금이 풀려 있다. 돌아올 때마다 다시 잡는다.
    const onVis = () => {
      if (document.visibilityState === 'visible' && !dropped) void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      dropped = true
      document.removeEventListener('visibilitychange', onVis)
      void sentinel?.release().catch(() => {})
    }
  }, [active])
}

export function SetTracker({
  exercises,
  onSaved,
  onLiveChange,
  onExercisesChanged,
}: {
  exercises: StrengthExercise[]
  onSaved: () => void
  /** 운동 중일 땐 탭의 나머지(캘린더·통계)를 접어 타이머만 보이게 하려고 알려 준다 */
  onLiveChange: (live: boolean) => void
  /** 시트에서 종목을 새로 만들었다 — 목록을 다시 읽어 달라고 알린다 */
  onExercisesChanged: () => void
}) {
  const [live, setLiveState] = useState<LiveSession | null>(readLive)
  const [now, setNow] = useState(() => Date.now())
  const [sheet, setSheet] = useState<SheetState>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const running = !!live && live.endedAt == null
  useWakeLock(running)

  useEffect(() => {
    onLiveChange(running)
  }, [running, onLiveChange])

  const setLive = useCallback((next: LiveSession | null) => {
    setLiveState(next)
    writeLive(next)
  }, [])

  // ⚠️ 남은 시간을 더해 세지 않는다 — 화면이 꺼지면 이 콜백이 안 돌거나 뜸해진다.
  //    매번 Date.now() 를 다시 읽어야 실제 경과 시간과 어긋나지 않는다.
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    const onVis = () => document.visibilityState === 'visible' && setNow(Date.now())
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [running])

  // ⚠️ 저장은 절대 두 번 나가면 안 된다 — 같은 운동이 두 건으로 쌓인다.
  //    finish() 가 직접 올리고, 마운트 때 밀린 세션도 올린다. 둘이 같은 빗장을 쓴다.
  const savingRef = useRef(false)

  const doSave = useCallback(
    async (target: LiveSession) => {
      if (savingRef.current) return
      savingRef.current = true
      setSaving(true)
      setError(null)
      try {
        await saveLiveSession(target)
        setLiveState(null)
        onSaved()
      } catch (e) {
        // 로컬 기록은 그대로 둔다 — 통신이 돌아오면 다시 올릴 수 있어야 한다
        setError(errMsg(e))
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [onSaved],
  )

  // 지난번에 저장 못 하고 끝난 세션(통신 끊김 등)이 있으면 켤 때 한 번 올려 본다.
  // 마운트 때만 본다 — live 를 의존성에 넣으면 finish() 가 올리는 중에 또 올린다.
  useEffect(() => {
    const pending = readLive()
    if (pending && pending.endedAt != null) void doSave(pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function start() {
    setError(null)
    setLive({ startedAt: Date.now(), endedAt: null, sets: [], current: null, note: '' })
  }

  function beginSet(exerciseId: string | null, exerciseName: string, weightKg: number | null) {
    if (!live) return
    setLive({ ...live, current: { exerciseId, exerciseName, weightKg, startedAt: Date.now() } })
    setSheet(null)
  }

  /** 돌고 있는 세트의 종목·중량을 고친다. 시작 시각은 건드리지 않는다 — 세트는 계속 도는 중이다. */
  function editCurrent(v: SetDraft) {
    if (!live?.current) return
    setLive({
      ...live,
      current: { ...live.current, exerciseId: v.exerciseId, exerciseName: v.exerciseName, weightKg: v.weightKg },
    })
    setSheet(null)
  }

  /** 이미 기록한 세트를 고친다. 시각(휴식 계산의 근거)은 그대로 두고 내용만 바꾼다. */
  function editSet(seq: number, v: SetDraft) {
    if (!live) return
    setLive({
      ...live,
      sets: live.sets.map((s) =>
        s.seq === seq
          ? { ...s, exerciseId: v.exerciseId, exerciseName: v.exerciseName, weightKg: v.weightKg, reps: v.reps }
          : s,
      ),
    })
    setSheet(null)
  }

  function endSet(reps: number | null) {
    if (!live?.current) return
    const c = live.current
    setLive({
      ...live,
      current: null,
      sets: [
        ...live.sets,
        {
          seq: live.sets.length + 1,
          exerciseId: c.exerciseId,
          exerciseName: c.exerciseName,
          weightKg: c.weightKg,
          reps,
          startedAt: c.startedAt,
          endedAt: Date.now(),
        },
      ],
    })
    setSheet(null)
  }

  function finish() {
    if (!live) return
    // 세트가 하나도 없으면 남길 게 없다 — 그냥 버린다
    if (live.sets.length === 0 && !live.current) {
      setLive(null)
      return
    }
    // 세트가 돌고 있는 채로 끝내면 그 세트도 지금 시점으로 닫는다
    const closed: LiveSession = live.current
      ? {
          ...live,
          current: null,
          endedAt: Date.now(),
          sets: [
            ...live.sets,
            {
              seq: live.sets.length + 1,
              exerciseId: live.current.exerciseId,
              exerciseName: live.current.exerciseName,
              weightKg: live.current.weightKg,
              reps: null,
              startedAt: live.current.startedAt,
              endedAt: Date.now(),
            },
          ],
        }
      : { ...live, endedAt: Date.now() }
    setLive(closed)
    void doSave(closed)
  }

  // ── 진행 중인 세션이 없다 ──
  if (!live) {
    return (
      <div className="card st-start-card">
        <button type="button" className="st-big-btn go" onClick={start}>
          운동 시작
        </button>
        <p className="muted small st-start-hint">세트마다 시간이 기록되고, 세트 사이는 자동으로 휴식이 됩니다.</p>
      </div>
    )
  }

  // ── 저장 대기 (종료했는데 아직 못 올림) ──
  if (live.endedAt != null) {
    return (
      <div className="card st-live">
        <div className="st-pending">
          <div className="st-pending-head">{saving ? '저장 중…' : '저장하지 못한 운동이 있습니다'}</div>
          <div className="muted small">
            세트 {live.sets.length}개 · 볼륨{' '}
            {Math.round(volumeOf(live.sets.map((s) => ({ weight_kg: s.weightKg, reps: s.reps }))))}kg
          </div>
          {error && <p className="error small">{error}</p>}
          <div className="st-pending-actions">
            <button className="sync-btn" disabled={saving} onClick={() => void doSave(live)}>
              {saving ? <span className="spinner" /> : '↻'} 다시 저장
            </button>
            <button
              className="link-btn small"
              disabled={saving}
              onClick={() => {
                if (window.confirm('이 운동 기록을 버립니다. 되돌릴 수 없습니다.')) setLive(null)
              }}
            >
              버리기
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 진행 중 ──
  const sessionMs = now - live.startedAt
  const lastSet = live.sets[live.sets.length - 1]
  const restFrom = lastSet?.endedAt ?? live.startedAt
  const vol = Math.round(volumeOf(live.sets.map((s) => ({ weight_kg: s.weightKg, reps: s.reps }))))
  const editingSet = sheet?.kind === 'editSet' ? (live.sets.find((s) => s.seq === sheet.seq) ?? null) : null

  return (
    <>
      <div className="card st-live">
        <div className="st-live-head">
          <span className="st-live-dot" />
          <span className="st-live-total">{fmtClock(sessionMs)}</span>
          <span className="muted small">
            세트 {live.sets.length} · {vol}kg
          </span>
          <button className="link-btn small st-finish" onClick={finish}>
            운동 종료
          </button>
        </div>

        {live.current ? (
          <div className="st-stage working">
            <div className="st-what">
              {live.current.exerciseName}
              {live.current.weightKg != null && <b> {live.current.weightKg}kg</b>}
              <button className="link-btn small st-edit-cur" onClick={() => setSheet({ kind: 'editCurrent' })}>
                수정
              </button>
            </div>
            <div className="st-timer">{fmtClock(now - live.current.startedAt)}</div>
            <button type="button" className="st-big-btn stop" onClick={() => setSheet({ kind: 'reps' })}>
              세트 중단
            </button>
          </div>
        ) : (
          <div className="st-stage resting">
            <div className="st-what muted">휴식 중</div>
            <div className="st-timer rest">{fmtClock(now - restFrom)}</div>
            <button type="button" className="st-big-btn go" onClick={() => setSheet({ kind: 'pick' })}>
              {live.sets.length === 0 ? '세트 시작' : '다음 세트'}
            </button>
          </div>
        )}

        {live.sets.length > 0 && <LiveSetList live={live} onEdit={(seq) => setSheet({ kind: 'editSet', seq })} />}
      </div>

      {sheet?.kind === 'pick' && (
        <PickSheet
          exercises={exercises}
          last={lastSet}
          onExercisesChanged={onExercisesChanged}
          onCancel={() => setSheet(null)}
          onStart={beginSet}
        />
      )}
      {sheet?.kind === 'reps' && live.current && (
        <RepsSheet
          exerciseName={live.current.exerciseName}
          weightKg={live.current.weightKg}
          elapsedMs={now - live.current.startedAt}
          defaultReps={
            [...live.sets].reverse().find((s) => s.exerciseName === live.current!.exerciseName)?.reps ?? null
          }
          onCancel={() => setSheet(null)}
          onDone={endSet}
        />
      )}
      {sheet?.kind === 'editCurrent' && live.current && (
        <SetEditSheet
          title="세트 수정"
          exercises={exercises}
          initial={{
            exerciseId: live.current.exerciseId,
            exerciseName: live.current.exerciseName,
            weightKg: live.current.weightKg,
            reps: null,
          }}
          withReps={false}
          onExercisesChanged={onExercisesChanged}
          onCancel={() => setSheet(null)}
          onSave={editCurrent}
        />
      )}
      {editingSet && (
        <SetEditSheet
          title={`${editingSet.seq}번째 세트 수정`}
          exercises={exercises}
          initial={{
            exerciseId: editingSet.exerciseId,
            exerciseName: editingSet.exerciseName,
            weightKg: editingSet.weightKg,
            reps: editingSet.reps,
          }}
          withReps
          onExercisesChanged={onExercisesChanged}
          onCancel={() => setSheet(null)}
          onSave={(v) => editSet(editingSet.seq, v)}
        />
      )}
    </>
  )
}

/** 지금까지 한 세트와 그 사이 휴식 — 저장 전이라 여기서 바로 간격을 계산한다 */
function LiveSetList({ live, onEdit }: { live: LiveSession; onEdit: (seq: number) => void }) {
  return (
    <ol className="st-list">
      {live.sets.map((s, i) => {
        const rest = i > 0 ? Math.round((s.startedAt - live.sets[i - 1].endedAt) / 1000) : 0
        return (
          <li key={s.seq}>
            {rest > 0 && (
              <div className="st-row rest">
                <span className="chip lap-rest">휴식</span>
                <span className="muted small">{fmtDur(rest)}</span>
              </div>
            )}
            {/* 줄 전체가 수정 버튼이다 — 헬스장에서 작은 아이콘을 조준할 여유가 없다 */}
            <button
              type="button"
              className="st-row"
              onClick={() => onEdit(s.seq)}
              aria-label={`${s.seq}번째 세트 수정`}
            >
              <span className="chip lap-work">{s.seq}</span>
              <span className="st-row-name">{s.exerciseName}</span>
              <span className="st-row-load">
                {s.weightKg != null ? `${s.weightKg}kg` : '맨몸'}
                {s.reps != null && ` × ${s.reps}`}
              </span>
              <span className="muted small">{fmtDur(Math.round((s.endedAt - s.startedAt) / 1000))}</span>
              <span className="st-row-edit" aria-hidden="true">
                ✎
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ── 시트: 종목 + 중량 고르기 ─────────────────────────────
function PickSheet({
  exercises,
  last,
  onExercisesChanged,
  onCancel,
  onStart,
}: {
  exercises: StrengthExercise[]
  last: LiveSession['sets'][number] | undefined
  onExercisesChanged: () => void
  onCancel: () => void
  onStart: (id: string | null, name: string, weight: number | null) => void
}) {
  // 직전 세트를 그대로 이어 가는 게 대부분이다 — 기본값으로 채워 두고 바로 시작할 수 있게
  const [picked, setPicked] = useState<Picked | null>(
    last ? { id: last.exerciseId, name: last.exerciseName } : null,
  )
  const [weight, setWeight] = useState<string>(last?.weightKg != null ? String(last.weightKg) : '')

  const w = numOrNull(weight)

  return (
    <Sheet title="세트 준비" onCancel={onCancel}>
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

      <button
        type="button"
        className="st-big-btn go"
        disabled={!picked || !weightOk(w)}
        onClick={() => picked && onStart(picked.id, picked.name, w)}
      >
        세트 시작
      </button>
    </Sheet>
  )
}

// ── 시트: 횟수 입력 ──────────────────────────────────────
function RepsSheet({
  exerciseName,
  weightKg,
  elapsedMs,
  defaultReps,
  onCancel,
  onDone,
}: {
  exerciseName: string
  weightKg: number | null
  elapsedMs: number
  defaultReps: number | null
  onCancel: () => void
  onDone: (reps: number | null) => void
}) {
  const [reps, setReps] = useState<string>(defaultReps != null ? String(defaultReps) : '')
  const n = numOrNull(reps)
  const ok = repsOk(n)

  return (
    <Sheet title="세트 완료" onCancel={onCancel}>
      <div className="st-done-head">
        <div className="st-what">
          {exerciseName}
          {weightKg != null && <b> {weightKg}kg</b>}
        </div>
        <div className="st-timer small">{fmtClock(elapsedMs)}</div>
      </div>

      <div className="st-sheet-sec">
        <div className="st-sheet-label">횟수 · 비워도 됩니다</div>
        <NumField value={reps} onChange={setReps} step={1} placeholder="—" inputMode="numeric" />
      </div>

      <button type="button" className="st-big-btn stop" disabled={!ok} onClick={() => onDone(n)}>
        기록하고 휴식
      </button>
    </Sheet>
  )
}
