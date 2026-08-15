import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import {
  CATEGORY_COLOR,
  fmtDur,
  sessionSummary,
  timeline,
  type StrengthExercise,
  type StrengthSession,
} from '../../lib/strength'

// 근력 전용 월간 캘린더. 러닝 캘린더(TrainingCalendar)와 격자·스타일을 공유하되,
// 칸에 담는 건 거리가 아니라 그날의 세트 수와 볼륨이다.
//
// 날짜를 누르면 그 아래에 그날 세션이 펼쳐진다 — 휴식은 저장돼 있지 않고 세트 간격으로 계산한다.

const MONTH_KEY = 'pp:scal:month'

function readMonth(): dayjs.Dayjs {
  try {
    const saved = sessionStorage.getItem(MONTH_KEY)
    if (saved && /^\d{4}-\d{2}$/.test(saved)) {
      const d = dayjs(`${saved}-01`)
      if (d.isValid()) return d.startOf('month')
    }
  } catch {
    /* 저장소를 못 쓰면 이번 달로 */
  }
  return dayjs().startOf('month')
}

export function StrengthCalendar({
  sessions,
  exercises,
  onDelete,
}: {
  sessions: StrengthSession[]
  exercises: StrengthExercise[]
  onDelete: (id: string) => void
}) {
  const [month, setMonth] = useState(readMonth)
  const [openDay, setOpenDay] = useState<string | null>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(MONTH_KEY, month.format('YYYY-MM'))
    } catch {
      /* 이번 세션에서만 못 기억할 뿐 */
    }
  }, [month])

  const catOf = useMemo(() => {
    const m = new Map(exercises.map((e) => [e.name, e.category ?? 'other']))
    return (name: string) => m.get(name) ?? 'other'
  }, [exercises])

  const byDay = useMemo(() => {
    const m = new Map<string, StrengthSession[]>()
    for (const s of sessions) {
      const day = dayjs(s.started_at).format('YYYY-MM-DD')
      const list = m.get(day) ?? []
      list.push(s)
      m.set(day, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.started_at.localeCompare(b.started_at))
    return m
  }, [sessions])

  const weeks = useMemo(() => {
    const start = month.startOf('month').startOf('week')
    const cells = Array.from({ length: 42 }, (_, i) => start.add(i, 'day'))
    const out: dayjs.Dayjs[][] = []
    for (let i = 0; i < 42; i += 7) out.push(cells.slice(i, i + 7))
    // 마지막 주가 통째로 다음 달이면 빼고 그린다 (빈 줄 방지)
    return out.filter((w) => w.some((d) => d.isSame(month, 'month')))
  }, [month])

  const monthStat = useMemo(() => {
    let vol = 0
    let sets = 0
    let days = 0
    for (const [day, list] of byDay) {
      if (!dayjs(day).isSame(month, 'month')) continue
      days += 1
      for (const s of list) {
        const sum = sessionSummary(s)
        vol += sum.volumeKg
        sets += sum.setCount
      }
    }
    return { vol, sets, days }
  }, [byDay, month])

  const isThisMonth = month.isSame(dayjs(), 'month')
  const openList = openDay ? (byDay.get(openDay) ?? []) : []

  return (
    <CollapsibleCard
      id="ex-scal"
      title={
        <>
          <span className="sec-dot" /> 근력 캘린더
        </>
      }
      actions={
        <div className="tcal-nav">
          {!isThisMonth && (
            <button className="link-btn tcal-today" onClick={() => setMonth(dayjs().startOf('month'))} title="이번 달로">
              오늘
            </button>
          )}
          <button className="ghost-btn tcal-arrow" onClick={() => setMonth((m) => m.subtract(1, 'month'))} title="이전 달">
            ←
          </button>
          <span className="tcal-month">{month.format('YYYY년 M월')}</span>
          <button
            className="ghost-btn tcal-arrow"
            onClick={() => setMonth((m) => m.add(1, 'month'))}
            disabled={isThisMonth}
            title={isThisMonth ? '다음 달은 아직' : '다음 달'}
          >
            →
          </button>
        </div>
      }
    >
      <div className="tcal-total">
        <b>{monthStat.vol.toLocaleString()}</b> <span className="muted">kg · 이달 볼륨</span>
        <span className="muted scal-total-sub">
          {monthStat.days}일 · {monthStat.sets}세트
        </span>
      </div>

      <div className="tcal-grid" role="grid">
        {['일', '월', '화', '수', '목', '금', '토'].map((d) => (
          <div key={d} className="tcal-dow">
            {d}
          </div>
        ))}
        {weeks.flat().map((d) => {
          const key = d.format('YYYY-MM-DD')
          const list = byDay.get(key) ?? []
          const outside = !d.isSame(month, 'month')
          const today = d.isSame(dayjs(), 'day')
          const sums = list.map(sessionSummary)
          const vol = sums.reduce((s, x) => s + x.volumeKg, 0)
          const sets = sums.reduce((s, x) => s + x.setCount, 0)
          // 그날 가장 많이 한 부위 색으로 칠한다
          const topCat = list.length ? dominantCategory(list, catOf) : null
          return (
            <div
              key={key}
              className={`tcal-cell scal-cell ${outside ? 'outside' : ''} ${today ? 'today' : ''} ${
                list.length ? 'has' : ''
              } ${openDay === key ? 'open' : ''}`}
              // 색은 변수로만 넘긴다 — 칠하는 방식은 index.css 가 정한다
              style={topCat ? ({ '--sess': CATEGORY_COLOR[topCat] } as CSSProperties) : undefined}
              onClick={() => list.length && setOpenDay(openDay === key ? null : key)}
              role={list.length ? 'button' : undefined}
              tabIndex={list.length ? 0 : undefined}
              onKeyDown={(e) => {
                if (list.length && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  setOpenDay(openDay === key ? null : key)
                }
              }}
            >
              <span className="tcal-day">{d.date()}</span>
              {list.length === 0 ? (
                <span className="tcal-none">—</span>
              ) : (
                <>
                  <span className="tcal-km">{sets}세트</span>
                  <span className="scal-vol">{vol.toLocaleString()}kg</span>
                </>
              )}
            </div>
          )
        })}
      </div>

      {openDay && openList.length > 0 && (
        <div className="scal-detail">
          <div className="scal-detail-head">
            <b>{dayjs(openDay).format('M월 D일 (ddd)')}</b>
            <button className="link-btn small" onClick={() => setOpenDay(null)}>
              닫기
            </button>
          </div>
          {openList.map((s) => (
            <SessionDetail key={s.id} session={s} onDelete={onDelete} />
          ))}
        </div>
      )}

      <div className="tcal-legend">
        {Object.entries(CATEGORY_COLOR).map(([k, c]) => (
          <span key={k} className="tcal-lg">
            <i style={{ background: c }} />
            {catLabel(k)}
          </span>
        ))}
        <span className="muted small tcal-note">칸 색은 그날 세트가 가장 많았던 부위입니다</span>
      </div>
    </CollapsibleCard>
  )
}

function catLabel(k: string): string {
  return (
    { chest: '가슴', back: '등', shoulder: '어깨', leg: '하체', arm: '팔', core: '코어', other: '기타' } as Record<
      string,
      string
    >
  )[k] ?? k
}

function dominantCategory(sessions: StrengthSession[], catOf: (n: string) => string): string {
  const count = new Map<string, number>()
  for (const s of sessions) {
    for (const x of s.strength_sets) {
      const c = catOf(x.exercise_name)
      count.set(c, (count.get(c) ?? 0) + 1)
    }
  }
  let best = 'other'
  let n = -1
  for (const [c, v] of count) {
    if (v > n) {
      best = c
      n = v
    }
  }
  return best
}

function SessionDetail({ session, onDelete }: { session: StrengthSession; onDelete: (id: string) => void }) {
  const sum = sessionSummary(session)
  const items = timeline(session.strength_sets)
  return (
    <div className="scal-session">
      <div className="scal-session-head">
        <span className="scal-time">
          {dayjs(session.started_at).format('HH:mm')}
          {session.ended_at && ` – ${dayjs(session.ended_at).format('HH:mm')}`}
        </span>
        <span className="muted small">
          {sum.setCount}세트 · {sum.volumeKg.toLocaleString()}kg · 운동 {fmtDur(sum.workS)} · 휴식 {fmtDur(sum.restS)}
        </span>
        <button
          className="link-btn small scal-del"
          onClick={() => {
            if (window.confirm('이 운동 기록을 지웁니다. 되돌릴 수 없습니다.')) onDelete(session.id)
          }}
        >
          삭제
        </button>
      </div>
      <ol className="st-list">
        {items.map((it, i) => (
          <li key={i}>
            {it.kind === 'rest' ? (
              <div className="st-row rest">
                <span className="chip lap-rest">휴식</span>
                <span className="muted small">{fmtDur(it.durationS)}</span>
              </div>
            ) : (
              <div className="st-row">
                <span className="chip lap-work">{it.seq}</span>
                <span className="st-row-name">{it.exerciseName}</span>
                <span className="st-row-load">
                  {it.weightKg != null ? `${it.weightKg}kg` : '맨몸'}
                  {it.reps != null && ` × ${it.reps}`}
                </span>
                <span className="muted small">{fmtDur(it.durationS)}</span>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
