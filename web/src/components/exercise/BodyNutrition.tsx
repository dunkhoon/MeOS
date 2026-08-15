import { useState } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { errMsg } from '../../lib/exercise'
import { saveNutrition, type NutritionLog } from '../../lib/body'
import type { CoachPlan } from '../../lib/coach'

// 음식 DB 는 두지 않는다 — 하루 총 kcal 과 단백질만 숫자로 받는다.
// 목표 대비 얼마나 맞췄는지만 보면 되는 용도라, 끼니별 기록은 유지 비용만 커진다.

export function BodyNutrition({
  nutrition,
  plan,
  onChanged,
}: {
  nutrition: NutritionLog[]
  plan: CoachPlan
  onChanged: () => void
}) {
  const today = dayjs().format('YYYY-MM-DD')
  const todayLog = nutrition.find((n) => n.day === today)
  const [kcal, setKcal] = useState(todayLog?.kcal != null ? String(todayLog.kcal) : '')
  const [protein, setProtein] = useState(todayLog?.protein_g != null ? String(todayLog.protein_g) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await saveNutrition({
        day: today,
        kcal: kcal.trim() === '' ? null : Math.round(Number(kcal)),
        protein_g: protein.trim() === '' ? null : Math.round(Number(protein)),
        note: null,
      })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
      onChanged()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // 최근 7일 (오늘 포함) — 기록이 없는 날도 칸을 비워 두고 보여 준다
  const days = Array.from({ length: 7 }, (_, i) => dayjs().subtract(6 - i, 'day'))

  return (
    <CollapsibleCard id="ex-body-nutri" title="섭취 기록">
      <div className="bn-form">
        <label className="bn-field">
          <span className="muted small">오늘 kcal</span>
          <input
            className="em-input"
            inputMode="numeric"
            value={kcal}
            placeholder={plan.targetKcal != null ? String(plan.targetKcal) : ''}
            onChange={(e) => setKcal(e.target.value)}
          />
        </label>
        <label className="bn-field">
          <span className="muted small">단백질 g</span>
          <input
            className="em-input"
            inputMode="numeric"
            value={protein}
            placeholder={plan.proteinG != null ? String(plan.proteinG) : ''}
            onChange={(e) => setProtein(e.target.value)}
          />
        </label>
        <button className="ghost-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? '저장 중…' : saved ? '저장됨' : '기록'}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}

      <div className="bn-week">
        {days.map((d) => {
          const key = d.format('YYYY-MM-DD')
          const log = nutrition.find((n) => n.day === key)
          const pct = plan.targetKcal && log?.kcal ? Math.min(1.4, log.kcal / plan.targetKcal) : null
          // 목표의 ±10% 안이면 맞춘 것으로 본다
          const good = pct != null && pct >= 0.9 && pct <= 1.1
          return (
            <div key={key} className="bn-day" title={log?.kcal ? `${log.kcal}kcal` : '기록 없음'}>
              <div className="bn-day-bar">
                {pct != null && (
                  <div
                    className="bn-day-fill"
                    style={{ height: `${Math.min(100, pct * 71)}%`, background: good ? 'var(--ok)' : 'var(--warn)' }}
                  />
                )}
                {plan.targetKcal != null && <div className="bn-day-target" />}
              </div>
              <div className="bn-day-label">{d.format('D')}</div>
              <div className="bn-day-p muted">{log?.protein_g != null ? `${log.protein_g}g` : '·'}</div>
            </div>
          )
        })}
      </div>
      <p className="muted small">가로선이 목표 kcal 입니다. 아래 숫자는 단백질.</p>
    </CollapsibleCard>
  )
}
