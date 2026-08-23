import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { Markdown } from '../../lib/markdown'
import { errMsg } from '../../lib/exercise'
import type { CoachPlan } from '../../lib/coach'
import type { DayTotals } from '../../lib/food'
import {
  KIND_LABEL,
  adjustedTargetKcal,
  askFoodAdvice,
  deleteAdvice,
  fetchAdvice,
  fetchDayEnergy,
  isAdviceWaiting,
  type AdviceKind,
  type DayEnergy,
  type FoodAdvice as Advice,
} from '../../lib/foodAdvice'

// 섭취 조언 — 그날 기록을 놓고 에이전트에게 물어보고, 답을 그 날짜에 붙들어 둔다.
//
// 답은 보통 수십 초 뒤에 온다. 기다리는 동안만 훑는다 (어시스턴트 화면과 같은 방식 —
// Realtime 을 쓰면 publication 설정이 따로 필요한데 얻는 게 없다).

const POLL_MS = 2500

export function FoodAdvice({ day, plan, totals }: { day: string; plan: CoachPlan; totals: DayTotals }) {
  const [rows, setRows] = useState<Advice[]>([])
  const [energy, setEnergy] = useState<DayEnergy | null>(null)
  const [loading, setLoading] = useState(true)
  const [asking, setAsking] = useState<AdviceKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [rs, en] = await Promise.all([fetchAdvice(day), fetchDayEnergy(day)])
      setRows(rs)
      setEnergy(en)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [day])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  // 답을 기다리는 동안만 훑는다
  const waiting = isAdviceWaiting(rows)
  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(() => {
      void fetchAdvice(day)
        .then(setRows)
        .catch(() => {
          /* 폴링 실패는 조용히 넘긴다 — 다음 주기에 다시 시도한다 */
        })
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [waiting, day])

  async function ask(kind: AdviceKind) {
    if (!energy) return
    setAsking(kind)
    setError(null)
    try {
      const created = await askFoodAdvice({ day, kind, plan, totals, energy, prior: rows })
      setRows((p) => [created, ...p])
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setAsking(null)
    }
  }

  async function remove(id: string) {
    try {
      await deleteAdvice(id)
      setRows((p) => p.filter((r) => r.id !== id))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  // 질문에 실리는 숫자와 같아야 한다 — 계산은 foodAdvice 한 곳에서만 한다
  const adjusted = useMemo(() => adjustedTargetKcal(plan, energy), [plan, energy])

  const eaten = totals.total.kcal ?? 0
  const effective = adjusted ?? plan.targetKcal
  const left = effective != null ? Math.round(effective - eaten) : null
  const isToday = day === dayjs().format('YYYY-MM-DD')

  return (
    <CollapsibleCard
      id="ex-food-advice"
      title={
        <>
          <span className="sec-dot" /> AI 섭취 조언
        </>
      }
      actions={rows.length > 0 ? <span className="muted small">{rows.length}번 물어봄</span> : undefined}
    >
      {error && <p className="error small">{error}</p>}

      {/* 무엇을 근거로 묻는지 먼저 보인다 — 답을 읽을 때 기준이 뭐였는지 알아야 한다 */}
      <div className="fa-basis">
        <div className="fa-basis-row">
          <span className="muted small">그날 기준 목표</span>
          <b>{effective != null ? `${effective.toLocaleString()} kcal` : '—'}</b>
          {adjusted != null && plan.targetKcal != null && adjusted !== plan.targetKcal && (
            <span className="muted small">
              (기본 {plan.targetKcal.toLocaleString()} {adjusted > plan.targetKcal ? '+' : ''}
              {(adjusted - plan.targetKcal).toLocaleString()} · 그날 운동 반영)
            </span>
          )}
        </div>
        <div className="fa-basis-row">
          <span className="muted small">그날 운동 소모</span>
          {energy?.exerciseKcal != null ? (
            <b>{energy.exerciseKcal.toLocaleString()} kcal</b>
          ) : (
            <span className="muted small">기록 없음{isToday ? ' (동기화 전일 수 있음)' : ''}</span>
          )}
          {plan.exerciseKcal != null && (
            <span className="muted small">4주 평균 {plan.exerciseKcal.toLocaleString()}</span>
          )}
        </div>
        {energy?.strength && (
          <div className="fa-basis-row">
            <span className="muted small">근력</span>
            <b>
              {energy.strength.sets}세트 · {energy.strength.volumeKg.toLocaleString()}kg
            </b>
            <span className="muted small">{energy.strength.exercises.map((e) => e.name).join(', ')}</span>
          </div>
        )}
        <div className="fa-basis-row">
          <span className="muted small">지금까지</span>
          <b>{Math.round(eaten).toLocaleString()} kcal</b>
          {left != null && (
            <span className={left >= 0 ? 'delta-up' : 'delta-down'}>
              {left >= 0 ? `${left.toLocaleString()} 남음` : `${Math.abs(left).toLocaleString()} 초과`}
            </span>
          )}
        </div>
      </div>

      <div className="fa-actions">
        <button
          className="ghost-btn fa-ask"
          disabled={!energy || asking != null || loading}
          onClick={() => void ask('plan')}
          title="아직 먹는 중 — 남은 식사를 어떻게 할지"
        >
          ✦ {asking === 'plan' ? '보내는 중…' : '진행 중 — 남은 식사 조언'}
        </button>
        <button
          className="ghost-btn fa-ask"
          disabled={!energy || asking != null || loading}
          onClick={() => void ask('review')}
          title="하루가 끝났다 — 목표 대비 어땠는지, 문제가 된 음식은 무엇인지"
        >
          ✦ {asking === 'review' ? '보내는 중…' : '하루 마감 — 잘 먹었는지 판단'}
        </button>
      </div>

      {loading ? (
        <p className="muted small">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="muted small">
          아직 물어본 적이 없습니다. 위 버튼을 누르면 그때의 섭취·목표·운동 기록을 함께 보내 조언을 받습니다.
        </p>
      ) : (
        <div className="fa-list">
          {rows.map((r) => (
            <AdviceRow key={r.id} row={r} onDelete={() => void remove(r.id)} />
          ))}
        </div>
      )}
    </CollapsibleCard>
  )
}

function AdviceRow({ row, onDelete }: { row: Advice; onDelete: () => void }) {
  // 가장 최근 답 하나만 펼쳐 둔다 — 여러 번 물으면 화면이 답으로만 가득 찬다
  const [open, setOpen] = useState(row.status !== 'done')
  const [showAsked, setShowAsked] = useState(false)
  const waiting = row.status === 'pending' || row.status === 'taken'

  return (
    <div className={`fa-item ${row.status}`}>
      <button type="button" className="fa-item-head" onClick={() => setOpen((v) => !v)}>
        <span className={`caret ${open ? '' : 'collapsed'}`}>▾</span>
        <span className={`fa-kind ${row.kind}`}>{KIND_LABEL[row.kind]}</span>
        <span className="muted small">{dayjs(row.created_at).format('HH:mm')}</span>
        <span className="fa-item-state">
          {waiting && <span className="muted small">답을 기다리는 중…</span>}
          {row.status === 'error' && <span className="error small">답하지 못했습니다</span>}
          {row.status === 'done' && !open && <span className="muted small fa-peek">{peek(row.answer)}</span>}
        </span>
      </button>

      {open && (
        <div className="fa-item-body">
          {row.status === 'error' && <p className="error small">{row.error ?? '알 수 없는 이유로 실패했습니다.'}</p>}
          {waiting && <p className="muted small">집 PC 의 에이전트가 답하는 중입니다. 보통 수십 초 걸립니다.</p>}
          {row.answer && <Markdown text={row.answer} />}

          <div className="fa-item-foot">
            <button className="link-btn small" onClick={() => setShowAsked((v) => !v)}>
              {showAsked ? '물어본 내용 접기' : '물어본 내용 보기'}
            </button>
            {row.model && <span className="muted small">{row.model}</span>}
            {row.answered_at && <span className="muted small">{dayjs(row.answered_at).format('HH:mm')} 답변</span>}
            <button className="link-btn small fa-del" onClick={onDelete} title="이 조언 삭제">
              삭제
            </button>
          </div>

          {/* 물어본 그 시점의 수치가 그대로 들어 있다 — 나중에 음식을 고쳐도 근거는 남는다 */}
          {showAsked && <pre className="fa-asked">{row.question}</pre>}
        </div>
      )}
    </div>
  )
}

/** 접혀 있을 때 보여 줄 첫 줄 */
function peek(answer: string | null): string {
  if (!answer) return ''
  const line = answer
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\d.\s]+/, '').trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}
