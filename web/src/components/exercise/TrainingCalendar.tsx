import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { km, type Activity } from '../../lib/exercise'
import { alpha } from '../../lib/color'
import { SESSION_COLOR, SESSION_LABEL, sessionKind, type SessionKind } from '../../lib/session'

// 월간 훈련 캘린더 — 한 셀에 그날 훈련(거리 + 세션 종류)을 보여주고, 누르면 상세로 간다.
// 지금은 "한 훈련"만 다룬다 (앞으로의 계획 표시는 별도 결정).

interface DayEntry {
  activity: Activity
  kind: SessionKind
}

// 보던 달을 기억한다. 상세를 보고 뒤로 오면 컴포넌트가 다시 마운트되는데,
// 그때마다 이번 달로 튀면 지난달을 훑어보기가 어렵다.
// sessionStorage 라 앱을 새로 켜면 이번 달에서 시작한다 (localStorage 면 몇 달 전이 떠서 더 헷갈린다).
const MONTH_KEY = 'pp:tcal:month'

function readMonth(): dayjs.Dayjs {
  try {
    const saved = sessionStorage.getItem(MONTH_KEY)
    // customParseFormat 플러그인을 쓰지 않으므로 형식 인자 대신 완전한 날짜로 만들어 넘긴다
    if (saved && /^\d{4}-\d{2}$/.test(saved)) {
      const d = dayjs(`${saved}-01`)
      if (d.isValid()) return d.startOf('month')
    }
  } catch {
    /* 저장소를 못 쓰면 이번 달로 */
  }
  return dayjs().startOf('month')
}

export function TrainingCalendar({ activities }: { activities: Activity[] }) {
  const navigate = useNavigate()
  const [month, setMonth] = useState(readMonth)

  useEffect(() => {
    try {
      sessionStorage.setItem(MONTH_KEY, month.format('YYYY-MM'))
    } catch {
      /* 저장 실패는 무시 — 이번 세션에서만 못 기억할 뿐 */
    }
  }, [month])

  const byDay = useMemo(() => {
    const m = new Map<string, DayEntry[]>()
    for (const a of activities) {
      if (!a.start_date_local) continue
      const day = a.start_date_local.slice(0, 10)
      const list = m.get(day) ?? []
      list.push({ activity: a, kind: sessionKind(a) })
      m.set(day, list)
    }
    // 하루에 여러 개면 긴 것부터 — 위쪽이 그날의 주 훈련이 되도록
    for (const list of m.values()) list.sort((x, y) => (y.activity.distance_m ?? 0) - (x.activity.distance_m ?? 0))
    return m
  }, [activities])

  // 달력 격자: 그 달 1일이 속한 주의 일요일부터 6주(42칸)
  const cells = useMemo(() => {
    const start = month.startOf('month').startOf('week')
    return Array.from({ length: 42 }, (_, i) => start.add(i, 'day'))
  }, [month])

  const monthTotal = useMemo(() => {
    let m = 0
    for (const [day, list] of byDay) {
      if (dayjs(day).isSame(month, 'month')) m += list.reduce((s, e) => s + (e.activity.distance_m ?? 0), 0)
    }
    return m
  }, [byDay, month])

  // 마지막 주가 통째로 다음 달이면 빼고 그린다 (빈 줄 방지)
  const weeks = useMemo(() => {
    const out: dayjs.Dayjs[][] = []
    for (let i = 0; i < 42; i += 7) out.push(cells.slice(i, i + 7))
    return out.filter((w) => w.some((d) => d.isSame(month, 'month')))
  }, [cells, month])

  const isThisMonth = month.isSame(dayjs(), 'month')

  return (
    <CollapsibleCard
      id="ex-tcal"
      title={
        <>
          <span className="sec-dot" /> 월간 훈련 캘린더
        </>
      }
      actions={
        <div className="tcal-nav">
          {!isThisMonth && (
            <button
              className="link-btn tcal-today"
              onClick={() => setMonth(dayjs().startOf('month'))}
              title="이번 달로"
            >
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
        <b>{km(monthTotal).toFixed(1)}</b> <span className="muted">km · 이달 누적</span>
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
          const total = list.reduce((s, e) => s + (e.activity.distance_m ?? 0), 0)
          return (
            <div
              key={key}
              className={`tcal-cell ${outside ? 'outside' : ''} ${today ? 'today' : ''} ${list.length ? 'has' : ''}`}
              style={list.length ? { borderColor: alpha(SESSION_COLOR[list[0].kind], 40) } : undefined}
            >
              <span className="tcal-day">{d.date()}</span>
              {list.length === 0 ? (
                <span className="tcal-none">—</span>
              ) : (
                <>
                  <span className="tcal-km" style={{ color: SESSION_COLOR[list[0].kind] }}>
                    {km(total).toFixed(1)}
                  </span>
                  <div className="tcal-acts">
                    {list.map((e) => (
                      <button
                        key={e.activity.id}
                        type="button"
                        className="tcal-act"
                        style={{ color: SESSION_COLOR[e.kind] }}
                        title={`${e.activity.name ?? ''} · ${km(e.activity.distance_m ?? 0).toFixed(2)}km — 눌러서 상세 보기`}
                        onClick={() => navigate(`/activity/${e.activity.external_id}`)}
                      >
                        {SESSION_LABEL[e.kind] || e.activity.type || '활동'}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      <div className="tcal-legend">
        {(['easy', 'long', 'tempo', 'interval', 'recovery', 'race'] as SessionKind[]).map((k) => (
          <span key={k} className="tcal-lg">
            <i style={{ background: SESSION_COLOR[k] }} />
            {SESSION_LABEL[k]}
          </span>
        ))}
        <span className="muted small tcal-note">세션 종류는 활동 이름에서 추정합니다</span>
      </div>
    </CollapsibleCard>
  )
}
