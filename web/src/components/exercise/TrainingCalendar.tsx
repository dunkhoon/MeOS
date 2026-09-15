import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { ZONE_COLORS, hms, km, pendingWorkouts, workoutTargets, type Activity, type HrZone, type Workout } from '../../lib/exercise'
import { SESSION_COLOR, SESSION_LABEL, sessionKind, type SessionKind } from '../../lib/session'
import { BodyCheckIcon, BodyCheckReview } from '../BodyCheckReview'
import { byDayMap, type BodyCheck } from '../../lib/bodyCheck'

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

export function TrainingCalendar({
  activities,
  workouts = [],
  checks = [],
}: {
  activities: Activity[]
  workouts?: Workout[]
  /** 몸상태 판단 — 그날 칸에 아이콘으로 찍힌다 */
  checks?: BodyCheck[]
}) {
  const navigate = useNavigate()
  const [month, setMonth] = useState(readMonth)
  /** 눌러서 펼친 계획 */
  const [openPlan, setOpenPlan] = useState<Workout | null>(null)
  /** 눌러서 펼친 몸상태 리뷰 */
  const [openCheck, setOpenCheck] = useState<BodyCheck | null>(null)

  const checkByDay = useMemo(() => byDayMap(checks), [checks])

  // 아직 소화 안 한 계획만 날짜별로. 기준은 paired_activity_id 다 —
  // 계획과 다른 걸 뛴 날에는 계획이 그대로 남아 있어야 한다.
  const planByDay = useMemo(() => {
    const m = new Map<string, Workout[]>()
    for (const w of pendingWorkouts(workouts)) {
      const list = m.get(w.start_date) ?? []
      list.push(w)
      m.set(w.start_date, list)
    }
    return m
  }, [workouts])

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
              // 세션 색은 변수로만 넘긴다 — 칠하는 방식은 index.css 가 정한다.
              // ⚠️ 색을 글자색으로 쓰면 밝은 테마에서 안 읽힌다(실측 2.0:1). 배경 틴트·테두리·점으로 쓴다.
              style={list.length ? ({ '--sess': SESSION_COLOR[list[0].kind] } as CSSProperties) : undefined}
            >
              <span className="tcal-day">{d.date()}</span>
              {checkByDay.has(key) && (
                <BodyCheckIcon check={checkByDay.get(key)!} onClick={() => setOpenCheck(checkByDay.get(key)!)} />
              )}
              {/* 계획은 실제 기록과 달라 보여야 한다 — 점선 테두리 */}
              {(planByDay.get(key) ?? []).map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="tcal-plan"
                  title={`계획: ${w.name ?? ''}${workoutTargets(w) ? ` — ${workoutTargets(w)}` : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenPlan(w)
                  }}
                >
                  {planLabel(w)}
                </button>
              ))}
              {list.length === 0 && !planByDay.has(key) ? (
                <span className="tcal-none">—</span>
              ) : list.length === 0 ? null : (
                <>
                  <span className="tcal-km">{km(total).toFixed(1)}</span>
                  <div className="tcal-acts">
                    {list.map((e) => (
                      <button
                        key={e.activity.id}
                        type="button"
                        className="tcal-act"
                        style={{ '--sess': SESSION_COLOR[e.kind] } as CSSProperties}
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
        <span className="tcal-lg">
          <i className="tcal-lg-plan" />
          계획 (아직 안 함)
        </span>
        <span className="tcal-lg">🙂 😐 😣 몸상태 (눌러서 리뷰)</span>
        <span className="muted small tcal-note">세션 종류는 활동 이름에서 추정합니다</span>
      </div>

      {openPlan && <PlanSheet w={openPlan} onClose={() => setOpenPlan(null)} />}
      {openCheck && <BodyCheckReview check={openCheck} onClose={() => setOpenCheck(null)} />}
    </CollapsibleCard>
  )
}

/**
 * 칸에 들어갈 짧은 이름.
 * 계획 이름은 "NSM D+106 SubT 1km x6 Controlled" 처럼 길어서 그대로는 칸을 넘긴다.
 * 앞의 코드(NSM D+106)를 떼면 남는 게 곧 그날의 핵심이다.
 */
function planLabel(w: Workout): string {
  const raw = (w.name ?? '계획').trim()
  const stripped = raw.replace(/^NSM\s+D[+-]?\d+\s*/i, '').trim()
  return stripped || raw
}

/** 계획 상세 — 목표치와 본문, 구간이 있으면 구간까지 */
function PlanSheet({ w, onClose }: { w: Workout; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const targets = workoutTargets(w)
  const steps = w.workout_doc?.steps ?? []
  const zones = (w.workout_doc?.zoneTimes ?? []).filter((z) => z.secs > 0)

  return (
    <div className="st-sheet-back" onClick={onClose}>
      <div className="st-sheet fd-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="훈련 계획">
        <div className="st-sheet-head">
          <span>훈련 계획 · {dayjs(w.start_date).format('M월 D일 (ddd)')}</span>
          <button className="link-btn small" onClick={onClose}>
            닫기
          </button>
        </div>

        <h3 className="plan-name">{w.name ?? '(이름 없음)'}</h3>
        {targets && <p className="plan-targets">{targets}</p>}

        {/* 본문은 여러 줄 평문이라 줄바꿈을 살려야 읽힌다 */}
        {w.description && <pre className="plan-desc">{w.description}</pre>}

        {zones.length > 0 && (
          <div className="plan-zones">
            {zones.map((z) => (
              <span key={z.id} className="plan-zone">
                <i style={{ background: ZONE_COLORS[z.id as HrZone] ?? 'var(--muted)' }} />
                {z.id} {hms(z.secs)}
              </span>
            ))}
          </div>
        )}

        {steps.length > 0 && (
          <ol className="plan-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <span className="plan-step-dur">{s.duration ? hms(s.duration) : s.distance ? `${km(s.distance)}km` : '-'}</span>
                <span className="muted">
                  {s.hr?.value != null ? `HR ${s.hr.units === 'hr_zone' ? `Z${s.hr.value}` : s.hr.value}` : ''}
                  {s.power?.value != null ? ` · 파워 ${s.power.value}` : ''}
                  {s.text ? ` · ${s.text}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}

        <p className="muted small">
          intervals.icu 에서 계획한 내용입니다. 이 계획에 활동이 연결되면 캘린더에서 사라집니다.
        </p>
      </div>
    </div>
  )
}
