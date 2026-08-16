import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { errMsg } from '../../lib/exercise'
import { FoodEditor } from './FoodEditor'
import {
  MEALS,
  MEAL_LABEL,
  NUTRIENT_LABEL,
  NUTRIENT_UNIT,
  addEntry,
  archiveFood,
  buildEntry,
  deleteEntry,
  fetchEntries,
  fetchFoods,
  kcalByDay,
  macroSplit,
  today,
  totalsForDay,
  unitsFor,
  type Food,
  type FoodEntry,
  type Meal,
} from '../../lib/food'
import type { CoachPlan } from '../../lib/coach'
// 섭취 기록 — 날짜를 고르고, 끼니별로 음식을 담고, 합계를 본다.
// 구조는 FatSecret 과 같다: 음식 목록에서 고르고 → 수량·단위·끼니를 정해 담는다.
export function FoodDiary({ plan, onChanged }: { plan: CoachPlan; onChanged: () => void }) {
  const [day, setDay] = useState(today)
  const [foods, setFoods] = useState<Food[]>([])
  const [entries, setEntries] = useState<FoodEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Food | null | 'new'>(null)
  const [picking, setPicking] = useState<Meal | null>(null)
  // 캘린더가 두 달치를 보여 주므로 넉넉히 읽는다
  const load = useCallback(async () => {
    setError(null)
    try {
      const from = dayjs(day).subtract(60, 'day').format('YYYY-MM-DD')
      const to = dayjs(day).add(30, 'day').format('YYYY-MM-DD')
      const [fs, es] = await Promise.all([fetchFoods(), fetchEntries(from, to)])
      setFoods(fs)
      setEntries(es)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [day])
  useEffect(() => {
    void load()
  }, [load])
  const totals = useMemo(() => totalsForDay(entries, day), [entries, day])
  const macro = macroSplit(totals.total)
  const kcal = totals.total.kcal ?? 0
  const target = plan.targetKcal
  const left = target != null ? Math.round(target - kcal) : null
  async function remove(id: string) {
    try {
      await deleteEntry(id)
      setEntries((p) => p.filter((e) => e.id !== id))
      onChanged()
    } catch (e) {
      setError(errMsg(e))
    }
  }
  async function add(food: Food, amount: number, unit: string, meal: Meal) {
    const row = buildEntry({ food, day, meal, amount, unit })
    if (!row) {
      setError(`${unit} 단위로는 환산할 수 없습니다. 음식에 그램 환산을 넣어 주세요.`)
      return
    }
    try {
      await addEntry(row)
      setPicking(null)
      await load()
      onChanged()
    } catch (e) {
      setError(errMsg(e))
    }
  }
  if (loading) return <p className="muted">섭취 기록 불러오는 중…</p>
  return (
    <>
      {error && <p className="error small">{error}</p>}
      <CollapsibleCard
        id="ex-food-diary"
        title={
          <>
            <span className="sec-dot" /> 섭취 기록
          </>
        }
        actions={
          <div className="fd-daynav">
            <button className="ghost-btn tcal-arrow" onClick={() => setDay(dayjs(day).subtract(1, 'day').format('YYYY-MM-DD'))}>
              ←
            </button>
            <span className="tcal-month">{dayjs(day).format('M월 D일 (ddd)')}</span>
            <button
              className="ghost-btn tcal-arrow"
              onClick={() => setDay(dayjs(day).add(1, 'day').format('YYYY-MM-DD'))}
              disabled={day >= today()}
            >
              →
            </button>
            {day !== today() && (
              <button className="link-btn small" onClick={() => setDay(today())}>
                오늘
              </button>
            )}
          </div>
        }
      >
        {/* 오늘 얼마나 먹었나 — 목표가 있으면 남은 양까지 */}
        <div className="fd-summary">
          <div className="fd-sum-main">
            <div className="fd-sum-kcal">{Math.round(kcal).toLocaleString()}</div>
            <div className="muted small">
              kcal
              {target != null && ` · 목표 ${target.toLocaleString()}`}
              {left != null && (
                <>
                  {' · '}
                  <b className={left >= 0 ? 'delta-up' : 'delta-down'}>
                    {left >= 0 ? `${left.toLocaleString()} 남음` : `${Math.abs(left).toLocaleString()} 초과`}
                  </b>
                </>
              )}
            </div>
          </div>
          {macro && (
            <div className="fd-macro">
              <div className="fd-macro-bar">
                <div className="fd-macro-seg" style={{ width: `${macro.carb}%`, background: 'var(--h-blue)' }} />
                <div className="fd-macro-seg" style={{ width: `${macro.fat}%`, background: 'var(--h-yellow)' }} />
                <div className="fd-macro-seg" style={{ width: `${macro.protein}%`, background: 'var(--h-pink)' }} />
              </div>
              <div className="fd-macro-legend">
                <span><i style={{ background: 'var(--h-blue)' }} />탄수 {macro.carb}%</span>
                <span><i style={{ background: 'var(--h-yellow)' }} />지방 {macro.fat}%</span>
                <span><i style={{ background: 'var(--h-pink)' }} />단백 {macro.protein}%</span>
              </div>
              <div className="muted small">
                탄 {totals.total.carb_g ?? '-'}g · 단 {totals.total.protein_g ?? '-'}g · 지 {totals.total.fat_g ?? '-'}g
                {plan.proteinG != null && ` (단백질 목표 ${plan.proteinG}g)`}
              </div>
            </div>
          )}
        </div>
        {/* 끼니별 */}
        {MEALS.map((m) => {
          const rows = totals.entries.filter((e) => e.meal === m.key)
          const mk = totals.byMeal[m.key].kcal
          return (
            <div key={m.key} className="fd-meal">
              <div className="fd-meal-head">
                <span className="fd-meal-name">
                  <i style={{ background: m.color }} />
                  {m.label}
                </span>
                <span className="muted small">{mk != null ? `${Math.round(mk)} kcal` : '—'}</span>
                <button className="link-btn small fd-meal-add" onClick={() => setPicking(m.key)}>
                  + 추가
                </button>
              </div>
              {rows.length === 0 ? (
                <p className="muted small fd-meal-empty">기록 없음</p>
              ) : (
                rows.map((e) => (
                  <div key={e.id} className="fd-entry">
                    <span className="fd-entry-name">
                      {e.brand && <span className="muted">{e.brand} </span>}
                      {e.name}
                    </span>
                    <span className="muted small fd-entry-amt">
                      {e.amount}
                      {e.unit}
                      {e.grams != null && e.unit !== 'g' && ` (${e.grams}g)`}
                    </span>
                    <span className="fd-entry-kcal">{e.kcal != null ? Math.round(e.kcal) : '-'}</span>
                    <button className="link-btn small" onClick={() => void remove(e.id)} title="삭제">
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          )
        })}
        <div className="fd-foot">
          <button className="ghost-btn" onClick={() => setEditing('new')}>
            + 음식 등록
          </button>
          <span className="muted small">등록해 두면 다음부터 골라서 담습니다</span>
        </div>
      </CollapsibleCard>
      <FoodCalendar entries={entries} day={day} onPick={setDay} />
      <FoodList foods={foods} onEdit={setEditing} onChanged={() => void load()} />
      {picking && (
        <PickSheet
          foods={foods.filter((f) => !f.archived)}
          meal={picking}
          onCancel={() => setPicking(null)}
          onAdd={(f, a, u) => void add(f, a, u, picking)}
          onNew={() => {
            setPicking(null)
            setEditing('new')
          }}
        />
      )}
      {editing && (
        <div className="st-sheet-back" onClick={() => setEditing(null)}>
          <div className="st-sheet fd-sheet" onClick={(e) => e.stopPropagation()}>
            <FoodEditor
              initial={editing === 'new' ? undefined : editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                void load()
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
// ── 음식 고르기 ─────────────────────────────────────────
function PickSheet({
  foods,
  meal,
  onCancel,
  onAdd,
  onNew,
}: {
  foods: Food[]
  meal: Meal
  onCancel: () => void
  onAdd: (f: Food, amount: number, unit: string) => void
  onNew: () => void
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Food | null>(null)
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState('')
  const list = foods.filter((f) => {
    const s = `${f.brand ?? ''} ${f.name}`.toLowerCase()
    return s.includes(q.trim().toLowerCase())
  })
  function choose(f: Food) {
    setSel(f)
    setAmount(String(f.base_amount))
    setUnit(f.base_unit)
  }
  const n = Number(amount)
  const ok = sel && Number.isFinite(n) && n > 0
  return (
    <div className="st-sheet-back" onClick={onCancel}>
      <div className="st-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="st-sheet-head">
          <span>{MEAL_LABEL[meal]}에 추가</span>
          <button className="link-btn small" onClick={onCancel}>
            취소
          </button>
        </div>
        {!sel ? (
          <>
            <input className="em-input" placeholder="음식 검색" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            <div className="fd-picklist">
              {list.length === 0 ? (
                <p className="muted small">
                  {foods.length === 0 ? '등록된 음식이 없습니다.' : '검색 결과가 없습니다.'}
                </p>
              ) : (
                list.slice(0, 40).map((f) => (
                  <button key={f.id} className="fd-pick" onClick={() => choose(f)}>
                    <span className="fd-pick-name">
                      {f.brand && <span className="muted">{f.brand} </span>}
                      {f.name}
                    </span>
                    <span className="muted small">
                      {f.base_amount}
                      {f.base_unit} · {f.kcal != null ? `${Math.round(f.kcal)}kcal` : '—'}
                    </span>
                  </button>
                ))
              )}
            </div>
            <button className="ghost-btn" onClick={onNew}>
              + 새 음식 등록
            </button>
          </>
        ) : (
          <>
            <div className="fd-pick-sel">
              {sel.brand && <span className="muted">{sel.brand} </span>}
              <b>{sel.name}</b>
              <button className="link-btn small" onClick={() => setSel(null)}>
                다시 고르기
              </button>
            </div>
            <div className="fd-row">
              <label className="bn-field fd-narrow">
                <span className="muted small">수량</span>
                <input className="em-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
              </label>
              <label className="bn-field fd-narrow">
                <span className="muted small">단위</span>
                <select className="st-select" value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {unitsFor(sel).map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Preview food={sel} amount={n} unit={unit} />
            <button className="st-big-btn go" disabled={!ok} onClick={() => ok && onAdd(sel, n, unit)}>
              추가
            </button>
          </>
        )}
      </div>
    </div>
  )
}
/** 담기 전에 얼마나 되는지 보여 준다 — 단위를 잘못 골랐을 때 여기서 걸린다 */
function Preview({ food, amount, unit }: { food: Food; amount: number; unit: string }) {
  const row = buildEntry({ food, day: today(), meal: 'snack', amount, unit })
  if (!row) return <p className="muted small">이 단위로는 환산할 수 없습니다.</p>
  return (
    <p className="fd-preview">
      {(['kcal', 'carb_g', 'protein_g', 'fat_g'] as const).map((k) => (
        <span key={k}>
          <span className="muted">{NUTRIENT_LABEL[k]}</span> <b>{row[k] ?? '-'}</b>
          {NUTRIENT_UNIT[k]}
        </span>
      ))}
    </p>
  )
}
// ── 섭취 캘린더 ─────────────────────────────────────────
function FoodCalendar({ entries, day, onPick }: { entries: FoodEntry[]; day: string; onPick: (d: string) => void }) {
  const [month, setMonth] = useState(() => dayjs(day).startOf('month'))
  const byDay = useMemo(() => kcalByDay(entries), [entries])
  const weeks = useMemo(() => {
    const start = month.startOf('month').startOf('week')
    const cells = Array.from({ length: 42 }, (_, i) => start.add(i, 'day'))
    const out: dayjs.Dayjs[][] = []
    for (let i = 0; i < 42; i += 7) out.push(cells.slice(i, i + 7))
    return out.filter((w) => w.some((d) => d.isSame(month, 'month')))
  }, [month])
  const monthDays = [...byDay.entries()].filter(([d]) => dayjs(d).isSame(month, 'month'))
  const avg = monthDays.length ? Math.round(monthDays.reduce((s, [, v]) => s + v, 0) / monthDays.length) : 0
  const isThisMonth = month.isSame(dayjs(), 'month')
  return (
    <CollapsibleCard
      id="ex-food-cal"
      title={
        <>
          <span className="sec-dot" /> 섭취 캘린더
        </>
      }
      actions={
        <div className="tcal-nav">
          {!isThisMonth && (
            <button className="link-btn tcal-today" onClick={() => setMonth(dayjs().startOf('month'))}>
              오늘
            </button>
          )}
          <button className="ghost-btn tcal-arrow" onClick={() => setMonth((m) => m.subtract(1, 'month'))}>
            ←
          </button>
          <span className="tcal-month">{month.format('YYYY년 M월')}</span>
          <button className="ghost-btn tcal-arrow" onClick={() => setMonth((m) => m.add(1, 'month'))} disabled={isThisMonth}>
            →
          </button>
        </div>
      }
    >
      <div className="tcal-total">
        <b>{avg.toLocaleString()}</b> <span className="muted">kcal · 기록한 날 평균</span>
        <span className="muted scal-total-sub">{monthDays.length}일 기록</span>
      </div>
      <div className="tcal-grid" role="grid">
        {['일', '월', '화', '수', '목', '금', '토'].map((d) => (
          <div key={d} className="tcal-dow">
            {d}
          </div>
        ))}
        {weeks.flat().map((d) => {
          const key = d.format('YYYY-MM-DD')
          const v = byDay.get(key)
          const outside = !d.isSame(month, 'month')
          return (
            <div
              key={key}
              className={`tcal-cell scal-cell ${outside ? 'outside' : ''} ${d.isSame(dayjs(), 'day') ? 'today' : ''} ${
                v ? 'has' : ''
              } ${key === day ? 'open' : ''}`}
              style={v ? ({ '--sess': 'var(--h-green)' } as CSSProperties) : undefined}
              onClick={() => onPick(key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPick(key)
                }
              }}
            >
              <span className="tcal-day">{d.date()}</span>
              {v ? <span className="tcal-km">{v.toLocaleString()}</span> : <span className="tcal-none">—</span>}
            </div>
          )
        })}
      </div>
      <p className="muted small">날짜를 누르면 그날 기록을 봅니다.</p>
    </CollapsibleCard>
  )
}
// ── 내 음식 목록 ────────────────────────────────────────
function FoodList({
  foods,
  onEdit,
  onChanged,
}: {
  foods: Food[]
  onEdit: (f: Food) => void
  onChanged: () => void
}) {
  const [showArchived, setShowArchived] = useState(false)
  const visible = foods.filter((f) => showArchived || !f.archived)
  const archivedCount = foods.filter((f) => f.archived).length
  return (
    <CollapsibleCard
      id="ex-food-list"
      title="내 음식"
      actions={
        archivedCount > 0 ? (
          <button className="link-btn small" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '감춘 것 숨기기' : `감춘 것 ${archivedCount}개`}
          </button>
        ) : undefined
      }
    >
      {visible.length === 0 ? (
        <p className="muted small">아직 등록한 음식이 없습니다.</p>
      ) : (
        <div className="fd-list">
          {visible.map((f) => (
            <div key={f.id} className={`fd-list-row ${f.archived ? 'archived' : ''}`}>
              <span className="fd-list-name">
                {f.brand && <span className="muted">{f.brand} </span>}
                {f.name}
              </span>
              <span className="muted small">
                {f.base_amount}
                {f.base_unit}
                {f.base_grams && f.base_unit !== 'g' ? ` (${f.base_grams}g)` : ''} ·{' '}
                {f.kcal != null ? `${Math.round(f.kcal)}kcal` : '—'}
                {f.source !== 'manual' && ' · AI'}
              </span>
              <button className="link-btn small" onClick={() => onEdit(f)}>
                수정
              </button>
              <button className="link-btn small" onClick={() => void archiveFood(f.id, !f.archived).then(onChanged)}>
                {f.archived ? '되살리기' : '감추기'}
              </button>
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  )
}
