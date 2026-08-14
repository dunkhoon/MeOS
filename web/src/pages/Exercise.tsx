import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { runIntervalsSync } from '../lib/sync'
import { TrainingCalendar } from '../components/exercise/TrainingCalendar'
import { ShoesPanel } from '../components/exercise/ShoesPanel'
import {
  ZONE_COLORS,
  activityTypes,
  activityZones,
  byType,
  dday,
  fetchActivities,
  fetchRaces,
  fetchWellness,
  hms,
  km,
  paceStr,
  typeColor,
  upcomingRaces,
  type Activity,
  type Race,
  type Wellness,
} from '../lib/exercise'
import { DistanceChart } from '../components/exercise/DistanceChart'
import { FitnessPanel } from '../components/exercise/FitnessPanel'
import { ConditionPanel } from '../components/exercise/ConditionPanel'
import { CollapsibleCard } from '../components/CollapsibleCard'
import { alpha, ink } from '../lib/color'

const TYPES_STORAGE_KEY = 'pp:ex:types'

// Supabase 에러는 Error 인스턴스가 아닐 수 있어 message를 안전하게 추출
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message
    if (typeof m === 'string' && m) return m
    try {
      return JSON.stringify(e)
    } catch {
      return String(e)
    }
  }
  return String(e)
}

export default function Exercise() {
  const [activities, setActivities] = useState<Activity[]>([])
  const [wellness, setWellness] = useState<Wellness[]>([])
  const [races, setRaces] = useState<Race[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const inited = useRef(false)

  const load = useCallback(async () => {
    const actSince = dayjs().subtract(5, 'year').format('YYYY-MM-DD')
    const wellSince = dayjs().subtract(120, 'day').format('YYYY-MM-DD')
    const [a, w, r] = await Promise.all([fetchActivities(actSince), fetchWellness(wellSince), fetchRaces()])
    setActivities(a)
    setWellness(w)
    setRaces(r)
  }, [])

  const runLoad = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await load()
    } catch {
      // 일시적 오류(토큰 갱신/네트워크) 대비 한 번 재시도
      try {
        await new Promise((r) => window.setTimeout(r, 600))
        await load()
      } catch (e2) {
        setError(errMsg(e2))
      }
    } finally {
      setLoading(false)
    }
  }, [load])

  useEffect(() => {
    void runLoad()
  }, [runLoad])

  // 평소엔 최근 60일치만 당긴다 (자주 눌러도 가볍게). full 은 과거 전체를 다시 채울 때.
  async function handleSync(full = false) {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const r = await runIntervalsSync({ full })
      await load()
      setSyncMsg(
        `동기화 완료${full ? ' (전체 기간)' : ''} · 활동 ${r.activities} · 웰니스 ${r.wellness} · 대회 ${r.races}` +
          (r.events ? ` · 일정 ${r.events}` : '') +
          (r.shoes ? ` · 러닝화 ${r.shoes}` : '') +
          // 러닝화만 실패해도 나머지는 반영됐다 — 조용히 넘기지 않고 알린다
          (r.shoesError ? ` (러닝화: ${r.shoesError})` : ''),
      )
    } catch (e) {
      setSyncMsg('동기화 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(false)
    }
  }

  // 활동 로드 후 종류 필터 초기화 (localStorage 복원, 없으면 전체 선택)
  useEffect(() => {
    if (inited.current || activities.length === 0) return
    inited.current = true
    const all = activityTypes(activities)
    let init = all
    try {
      const stored = localStorage.getItem(TYPES_STORAGE_KEY)
      if (stored) {
        const arr = JSON.parse(stored) as string[]
        const filteredStored = all.filter((t) => arr.includes(t))
        if (filteredStored.length) init = filteredStored
      }
    } catch {
      /* ignore */
    }
    setSelected(new Set(init))
  }, [activities])

  if (loading) {
    return (
      <div className="page">
        <p className="muted">운동 데이터 불러오는 중…</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="page">
        <p className="error">불러오기 실패: {error}</p>
        <button className="ghost-btn" onClick={() => void runLoad()}>
          다시 시도
        </button>
      </div>
    )
  }

  const allTypes = activityTypes(activities)
  const selectedTypes = allTypes.filter((t) => selected.has(t))

  const persist = (next: Set<string>) => {
    try {
      localStorage.setItem(TYPES_STORAGE_KEY, JSON.stringify([...next]))
    } catch {
      /* ignore */
    }
  }
  const toggleType = (t: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      persist(next)
      return next
    })
  const toggleAll = () =>
    setSelected((prev) => {
      const next = prev.size === allTypes.length ? new Set<string>() : new Set(allTypes)
      persist(next)
      return next
    })

  const filtered = activities.filter((a) => selected.has(a.type || 'Other'))

  const now = dayjs()
  const weekStart = now.startOf('isoWeek')
  const monthActs = filtered.filter((a) => a.start_date_local && dayjs(a.start_date_local).isSame(now, 'month'))
  const weekActs = filtered.filter(
    (a) => a.start_date_local && dayjs(a.start_date_local).startOf('isoWeek').isSame(weekStart),
  )
  const monthKm = km(monthActs.reduce((s, a) => s + (a.distance_m ?? 0), 0))
  const weekKm = km(weekActs.reduce((s, a) => s + (a.distance_m ?? 0), 0))
  const weekTime = weekActs.reduce((s, a) => s + (a.moving_time_s ?? 0), 0)

  const prevWeekStart = weekStart.subtract(1, 'week')
  const prevWeekActs = filtered.filter(
    (a) => a.start_date_local && dayjs(a.start_date_local).startOf('isoWeek').isSame(prevWeekStart),
  )
  const prevWeekKm = km(prevWeekActs.reduce((s, a) => s + (a.distance_m ?? 0), 0))
  const deltaKm = Math.round((weekKm - prevWeekKm) * 10) / 10

  const empty = activities.length === 0 && wellness.length === 0

  return (
    <div className="page">
      <header className="page-head ex-head">
        <div>
          <h2>운동</h2>
          <p className="muted">intervals.icu · 훈련부하 · 활동 · 컨디션</p>
        </div>
        <div className="sync-actions">
          <button className="sync-btn" onClick={() => void handleSync(false)} disabled={syncing}>
            {syncing ? (
              <>
                <span className="spinner" />
                동기화 중…
              </>
            ) : (
              <>↻ 새로고침</>
            )}
          </button>
          {/* 최근분만 받는 게 기본이라, 과거를 처음 채울 때 쓸 길을 열어 둔다 */}
          <button
            className="link-btn small"
            onClick={() => void handleSync(true)}
            disabled={syncing}
            title="과거 활동·웰니스를 전부 다시 가져옵니다 (오래 걸릴 수 있음)"
          >
            전체 기간
          </button>
        </div>
      </header>

      {syncMsg && <div className={`sync-msg ${syncMsg.startsWith('동기화 실패') ? 'err' : ''}`}>{syncMsg}</div>}

      {empty && (
        <div className="card notice-card">
          아직 동기화된 운동 데이터가 없어요. 터미널에서 <code>node scripts/sync-intervals.mjs</code> 를 실행해 intervals.icu 데이터를 가져오세요.
        </div>
      )}

      <UpcomingRaces races={races} />

      <TypeFilter types={allTypes} selected={selected} onToggle={toggleType} onToggleAll={toggleAll} />

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-val">
            {monthKm}
            <span>km</span>
          </div>
          <div className="kpi-label">이번 달 거리 · {monthActs.length}회</div>
        </div>
        <div className="kpi">
          <div className="kpi-val">
            {weekKm}
            <span>km</span>
          </div>
          <div className="kpi-label">
            이번 주 거리{' '}
            <span className={deltaKm >= 0 ? 'delta-up' : 'delta-down'}>
              · 지난주 {deltaKm >= 0 ? '+' : ''}
              {deltaKm}km
            </span>
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-val">{weekActs.length}</div>
          <div className="kpi-label">이번 주 운동 횟수</div>
        </div>
        <div className="kpi">
          <div className="kpi-val">{hms(weekTime)}</div>
          <div className="kpi-label">이번 주 시간</div>
        </div>
      </div>

      {/* 세로로 쌓이는 블록들 — 카드 자체엔 바깥 여백이 없어서 여기서 한 번에 준다 */}
      <div className="ex-stack">
        <TrainingCalendar activities={filtered} />

        <div className="ex-grid">
          <DistanceChart activities={filtered} types={selectedTypes} />
          <CollapsibleCard id="ex-type" title="종류별">
            <TypeBreakdown activities={filtered} />
          </CollapsibleCard>
          <CollapsibleCard id="ex-recent" title="최근 활동">
            <RecentActivities activities={filtered} />
          </CollapsibleCard>
          <FitnessPanel wellness={wellness} />
          <ConditionPanel wellness={wellness} />
        </div>

        {/* 자주 보는 정보는 아니라 맨 아래 */}
        <ShoesPanel />
      </div>
    </div>
  )
}

function TypeFilter({
  types,
  selected,
  onToggle,
  onToggleAll,
}: {
  types: string[]
  selected: Set<string>
  onToggle: (t: string) => void
  onToggleAll: () => void
}) {
  if (!types.length) return null
  const allOn = selected.size === types.length
  return (
    <div className="type-filter">
      <button type="button" className={`tf-btn tf-all ${allOn ? 'active' : ''}`} onClick={onToggleAll}>
        All
      </button>
      {types.map((t) => {
        const on = selected.has(t)
        const color = typeColor(t)
        return (
          <button
            type="button"
            key={t}
            className={`tf-btn ${on ? 'active' : ''}`}
            onClick={() => onToggle(t)}
            style={on ? { borderColor: color } : undefined}
          >
            <span className="tf-dot" style={{ background: color }} />
            {t}
          </button>
        )
      })}
    </div>
  )
}

function UpcomingRaces({ races }: { races: Race[] }) {
  const upcoming = upcomingRaces(races)
  if (!upcoming.length) return null
  return (
    <div className="ex-races-wrap">
      <CollapsibleCard id="ex-races" title="다가오는 대회">
        <div className="races-list">
          {upcoming.slice(0, 6).map((r) => {
            const d = dday(r.race_date)
            const grade = (r.category ?? '').slice(-1).toLowerCase()
            return (
              <div key={r.id} className="race-card">
                <div className={`race-dday grade-${grade}`}>{d === 0 ? 'D-DAY' : `D-${d}`}</div>
                <div className="race-info">
                  <div className="race-name" title={r.name}>
                    {r.name}
                  </div>
                  <div className="race-meta">
                    {dayjs(r.race_date).format('YYYY.MM.DD')} · {(r.category ?? '').replace('RACE_', '')}급
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CollapsibleCard>
    </div>
  )
}

function TypeBreakdown({ activities }: { activities: Activity[] }) {
  const stats = byType(activities)
  if (!stats.length) return <p className="muted small">데이터 없음</p>
  const max = Math.max(...stats.map((s) => s.count))
  return (
    <div className="type-list">
      {stats.slice(0, 8).map((s) => (
        <div key={s.type} className="type-row">
          <span className="type-name" title={s.type}>
            <span className="tf-dot" style={{ background: typeColor(s.type) }} />
            <span className="type-name-text">{s.type}</span>
          </span>
          <div className="type-bar">
            <div className="type-bar-fill" style={{ width: `${(s.count / max) * 100}%`, background: typeColor(s.type) }} />
          </div>
          <span className="type-meta">
            {s.count}회 · {s.km}km
          </span>
        </div>
      ))}
    </div>
  )
}

function RecentActivities({ activities }: { activities: Activity[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const navigate = useNavigate()
  if (!activities.length) return <p className="muted small">데이터 없음</p>
  return (
    <table className="act-table">
      <thead>
        <tr>
          <th aria-label="펼치기"></th>
          <th>날짜</th>
          <th>종류</th>
          <th>거리</th>
          <th>시간</th>
        </tr>
      </thead>
      <tbody>
        {activities.slice(0, 8).map((a) => {
          const open = openId === a.id
          return (
            <Fragment key={a.id}>
              <tr className="act-row" onClick={() => setOpenId(open ? null : a.id)}>
                <td className="act-caret">{open ? '▾' : '▸'}</td>
                <td>{a.start_date_local ? dayjs(a.start_date_local).format('MM-DD') : '-'}</td>
                <td>
                  <span className="pill" style={{ background: alpha(typeColor(a.type), 12), color: ink(typeColor(a.type)) }}>
                    {a.type ?? '-'}
                  </span>
                </td>
                <td>{a.distance_m ? `${km(a.distance_m)} km` : '-'}</td>
                <td>{hms(a.moving_time_s)}</td>
              </tr>
              {open && (
                <tr className="act-detail">
                  <td colSpan={5}>
                    {a.name && <div className="act-detail-name">{a.name}</div>}
                    <div className="act-stats">
                      <span>
                        <b>페이스</b> {paceStr(a.distance_m, a.moving_time_s)}
                      </span>
                      <span>
                        <b>평균 심박</b> {a.average_hr ? `${a.average_hr} bpm` : '-'}
                      </span>
                      <span>
                        <b>최대 심박</b> {a.max_hr ? `${a.max_hr} bpm` : '-'}
                      </span>
                      <span>
                        <b>칼로리</b> {a.calories ? `${a.calories} kcal` : '-'}
                      </span>
                      <span>
                        <b>훈련부하</b> {a.training_load ?? '-'}
                      </span>
                    </div>
                    {activityZones(a).length > 0 && (
                      <div className="zone-dist">
                        <div className="zone-bar">
                          {activityZones(a).map(
                            (zd) =>
                              zd.pct > 0 && (
                                <div
                                  key={zd.z}
                                  className="zone-seg"
                                  style={{ width: `${zd.pct}%`, background: ZONE_COLORS[zd.z] }}
                                  title={`${zd.z} ${zd.pct}%`}
                                />
                              ),
                          )}
                        </div>
                        <div className="zone-legend">
                          {activityZones(a).map((zd) => (
                            <span key={zd.z}>
                              <i style={{ background: ZONE_COLORS[zd.z] }} />
                              {zd.z} {zd.pct}%
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="act-links">
                      <button className="ghost-btn" onClick={() => navigate(`/activity/${a.external_id}`)}>
                        훈련 상세 보기 →
                      </button>
                      <a
                        className="ext-link"
                        href={`https://intervals.icu/activities/${a.external_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        intervals.icu ↗
                      </a>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}
