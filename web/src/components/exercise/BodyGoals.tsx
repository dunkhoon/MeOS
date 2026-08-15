import { useState } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { errMsg } from '../../lib/exercise'
import {
  GOAL_METRICS,
  METRIC_META,
  dropGoal,
  goalProgress,
  milestones,
  saveGoal,
  type BodyGoal,
  type BodyMeasurement,
  type GoalMetric,
} from '../../lib/body'

// 목표는 "수치 + 날짜" 로 세운다. 화면이 대신 답하는 건 세 가지다 —
// 지금 어디쯤인가, 기한을 맞추려면 주당 얼마나 가야 하나, 지금 속도로는 언제 닿나.

export function BodyGoals({
  goals,
  measurements,
  onChanged,
}: {
  goals: BodyGoal[]
  measurements: BodyMeasurement[]
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)

  return (
    <CollapsibleCard
      id="ex-body-goals"
      title={
        <>
          <span className="sec-dot" /> 목표
        </>
      }
      actions={
        <button className="link-btn small" onClick={() => setAdding((v) => !v)}>
          {adding ? '닫기' : '목표 세우기'}
        </button>
      }
    >
      {adding && (
        <GoalForm
          measurements={measurements}
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}

      {goals.length === 0 && !adding && (
        <p className="muted small">아직 목표가 없습니다. 목표를 세우면 필요한 섭취량·운동량이 계산됩니다.</p>
      )}

      {goals.map((g) => (
        <GoalRow key={g.id} goal={g} measurements={measurements} onChanged={onChanged} />
      ))}
    </CollapsibleCard>
  )
}

function GoalRow({
  goal,
  measurements,
  onChanged,
}: {
  goal: BodyGoal
  measurements: BodyMeasurement[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const p = goalProgress(goal, measurements)
  const meta = METRIC_META[goal.metric]
  const steps = milestones(goal, measurements)
  const daysLeft = dayjs(goal.target_date).diff(dayjs(), 'day')

  return (
    <div className="bg-goal">
      <div className="bg-goal-head">
        <span className="bg-goal-name" style={{ color: 'var(--text)' }}>
          <span className="tf-dot" style={{ background: meta.color }} />
          {meta.label}
        </span>
        <span className="bg-goal-nums">
          <b>{p.current ?? '-'}</b>
          {meta.unit} → {goal.target_value}
          {meta.unit}
        </span>
        <span className="muted small">
          {daysLeft >= 0 ? `D-${daysLeft}` : `${-daysLeft}일 지남`} · {dayjs(goal.target_date).format('YYYY.MM.DD')}
        </span>
        <button className="link-btn small bg-goal-del" onClick={() => void dropGoal(goal.id).then(onChanged)}>
          접기
        </button>
      </div>

      <div className="bg-bar" title={`${Math.round(p.progress * 100)}%`}>
        <div
          className={`bg-bar-fill ${p.achieved ? 'done' : ''}`}
          style={{ width: `${p.progress * 100}%`, background: p.achieved ? 'var(--ok)' : meta.color }}
        />
        <span className="bg-bar-pct">{Math.round(p.progress * 100)}%</span>
      </div>

      <div className="bg-goal-meta">
        {p.achieved ? (
          <span className="delta-up">달성</span>
        ) : (
          <>
            <span>
              필요 <b>{p.neededPerWeek != null ? `${p.neededPerWeek > 0 ? '+' : ''}${p.neededPerWeek}` : '-'}</b>
              {meta.unit}/주
            </span>
            <span>
              최근 추세{' '}
              <b className={p.actualPerWeek != null && Math.sign(p.actualPerWeek) === p.dir ? 'delta-up' : 'delta-down'}>
                {p.actualPerWeek != null ? `${p.actualPerWeek > 0 ? '+' : ''}${p.actualPerWeek}` : '-'}
              </b>
              {meta.unit}/주
            </span>
            <span>
              도달 예상 <b>{p.projectedDate ? dayjs(p.projectedDate).format('YYYY.MM.DD') : '—'}</b>
            </span>
          </>
        )}
        {steps.length > 0 && (
          <button className="link-btn small" onClick={() => setOpen((v) => !v)}>
            {open ? '단계 접기' : '단계 보기'}
          </button>
        )}
      </div>

      {open && steps.length > 0 && (
        <ol className="bg-steps">
          {steps.map((s) => (
            <li key={s.date} className={`bg-step ${s.past ? 'past' : ''} ${s.reached ? 'ok' : s.past ? 'miss' : ''}`}>
              <span className="bg-step-mark">{s.reached ? '✓' : s.past ? '·' : '○'}</span>
              <span className="bg-step-date">{dayjs(s.date).format('YY.M.D')}</span>
              <span className="bg-step-exp">
                {s.expected}
                {meta.unit}
              </span>
              <span className="muted small">
                {s.actual != null ? `실측 ${s.actual}${meta.unit}` : s.past ? '측정 없음' : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function GoalForm({ measurements, onDone }: { measurements: BodyMeasurement[]; onDone: () => void }) {
  const last = measurements.length ? measurements[measurements.length - 1] : null
  const [metric, setMetric] = useState<GoalMetric>('body_fat_pct')
  const [value, setValue] = useState('')
  const [date, setDate] = useState(dayjs().add(3, 'month').format('YYYY-MM-DD'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const meta = METRIC_META[metric]
  // 시작값은 지금 값을 박아 둔다 — 진행률의 기준점이라 나중에 흔들리면 안 된다
  const startValue = last?.[metric] ?? null
  const target = value.trim() === '' ? null : Number(value)
  const ok = startValue != null && target != null && Number.isFinite(target) && dayjs(date).isAfter(dayjs())

  async function submit() {
    if (!ok || startValue == null || target == null) return
    setBusy(true)
    setError(null)
    try {
      await saveGoal({
        metric,
        target_value: target,
        target_date: date,
        start_value: startValue,
        start_date: dayjs().format('YYYY-MM-DD'),
      })
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-form">
      {startValue == null && (
        <p className="muted small">
          인바디 기록이 있어야 목표를 세울 수 있습니다 ({meta.label} 값이 필요합니다).
        </p>
      )}
      <div className="bg-form-row">
        <select className="st-select" value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>
          {GOAL_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="muted small">
          지금 {startValue ?? '-'}
          {meta.unit} →
        </span>
        <input
          className="em-input bg-form-num"
          inputMode="decimal"
          placeholder={`목표 ${meta.unit}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <input className="em-input bg-form-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="ghost-btn" disabled={!ok || busy} onClick={() => void submit()}>
          {busy ? '저장 중…' : '세우기'}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">같은 지표에 목표를 다시 세우면 이전 목표는 접힙니다.</p>
    </div>
  )
}
