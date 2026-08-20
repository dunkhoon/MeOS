import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { CollapsibleCard } from '../CollapsibleCard'
import { SetTracker } from './SetTracker'
import { StrengthCalendar } from './StrengthCalendar'
import { ExerciseManager } from './ExerciseManager'
import { AskButton } from '../AskButton'
import { errMsg } from '../../lib/exercise'
import { LatestValues, chartMargin, deltaText, lastTwo, pinnedTooltipProps, useCoarsePointer } from '../../lib/chart'
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  byExercise,
  deleteSession,
  exerciseProgress,
  fetchExercises,
  fetchSessions,
  readLive,
  seedPresetExercises,
  sessionSummary,
  weeklyVolume,
  type StrengthExercise,
  type StrengthSession,
} from '../../lib/strength'

const tooltipStyle = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
}

export function StrengthTab() {
  const [exercises, setExercises] = useState<StrengthExercise[]>([])
  const [sessions, setSessions] = useState<StrengthSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)
  // 운동 중엔 타이머만 보여 준다 — 헬스장에서 스크롤 하며 찾을 여유가 없다
  const [live, setLive] = useState(() => {
    const l = readLive()
    return !!l && l.endedAt == null
  })

  const load = useCallback(async () => {
    setError(null)
    try {
      const since = dayjs().subtract(1, 'year').format('YYYY-MM-DD')
      const [ex, ss] = await Promise.all([fetchExercises(), fetchSessions(since)])
      setExercises(ex)
      setSessions(ss)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 세트 준비 시트에서 종목을 만들면 목록만 다시 읽는다 — 운동 중엔 세션까지 받아 올 이유가 없다
  const refreshExercises = useCallback(async () => {
    try {
      setExercises(await fetchExercises())
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const catOf = useMemo(() => {
    const m = new Map(exercises.map((e) => [e.name, e.category]))
    return (name: string) => m.get(name) ?? null
  }, [exercises])

  async function handleDelete(id: string) {
    try {
      await deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function handleSeed() {
    setSeeding(true)
    try {
      await seedPresetExercises()
      await load()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSeeding(false)
    }
  }

  if (loading) return <p className="muted">근력 기록 불러오는 중…</p>

  const now = dayjs()
  const weekStart = now.startOf('isoWeek')
  const weekSessions = sessions.filter((s) => dayjs(s.started_at).isSame(weekStart, 'week'))
  const monthSessions = sessions.filter((s) => dayjs(s.started_at).isSame(now, 'month'))
  const weekSum = weekSessions.map(sessionSummary)
  const monthVol = monthSessions.map(sessionSummary).reduce((s, x) => s + x.volumeKg, 0)

  return (
    <>
      {error && <p className="error">{error}</p>}

      <SetTracker
        exercises={exercises}
        onSaved={() => void load()}
        onLiveChange={setLive}
        onExercisesChanged={() => void refreshExercises()}
      />

      {!live && sessions.length > 0 && (
        <div className="ask-row">
          <AskButton
            label="근력 물어보기"
            question={
              '근력 질문이야 (러닝 훈련 분석 아님). meos_strength 로 최근 세션의 종목·중량·횟수를 보고, ' +
              '볼륨 추세와 부위 균형이 어떤지, 다음 주엔 뭘 바꾸면 좋을지 알려줘.'
            }
            context={{
              이번주: {
                횟수: weekSessions.length,
                세트: weekSum.reduce((s, x) => s + x.setCount, 0),
                볼륨kg: weekSum.reduce((s, x) => s + x.volumeKg, 0),
              },
              이번달볼륨kg: monthVol,
              종목별: byExercise(sessions, catOf).slice(0, 10),
            }}
          />
        </div>
      )}

      {!live && (
        <>
          {exercises.length === 0 && (
            <div className="card notice-card">
              아직 종목이 없습니다.{' '}
              <button className="ghost-btn" disabled={seeding} onClick={() => void handleSeed()}>
                {seeding ? '추가 중…' : '기본 종목 22개 넣기'}
              </button>{' '}
              <span className="muted small">이름을 고치거나 지울 수 있고, 직접 추가해도 됩니다.</span>
            </div>
          )}

          <div className="kpi-row">
            <div className="kpi">
              <div className="kpi-val">{weekSessions.length}</div>
              <div className="kpi-label">이번 주 운동 횟수</div>
            </div>
            <div className="kpi">
              <div className="kpi-val">{weekSum.reduce((s, x) => s + x.setCount, 0)}</div>
              <div className="kpi-label">이번 주 세트</div>
            </div>
            <div className="kpi">
              <div className="kpi-val">
                {weekSum.reduce((s, x) => s + x.volumeKg, 0).toLocaleString()}
                <span>kg</span>
              </div>
              <div className="kpi-label">이번 주 볼륨</div>
            </div>
            <div className="kpi">
              <div className="kpi-val">
                {monthVol.toLocaleString()}
                <span>kg</span>
              </div>
              <div className="kpi-label">이번 달 볼륨 · {monthSessions.length}회</div>
            </div>
          </div>

          <div className="ex-stack">
            <StrengthCalendar sessions={sessions} exercises={exercises} onDelete={(id) => void handleDelete(id)} />

            <div className="ex-grid">
              <VolumeChart sessions={sessions} />
              <ExerciseProgressCard sessions={sessions} />
              <CollapsibleCard id="ex-strength-list" title="종목별">
                <ExerciseBreakdown sessions={sessions} catOf={catOf} />
              </CollapsibleCard>
            </div>

            <ExerciseManager exercises={exercises} onChanged={() => void load()} />
          </div>
        </>
      )}
    </>
  )
}

function VolumeChart({ sessions }: { sessions: StrengthSession[] }) {
  const coarse = useCoarsePointer()
  const data = weeklyVolume(sessions, 12)
  const has = data.some((d) => d.volume > 0 || d.sets > 0)
  return (
    <CollapsibleCard
      id="ex-strength-vol"
      title={
        <>
          주간 볼륨 <span className="muted small">(최근 12주 · 월~일)</span>
        </>
      }
    >
      {has ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={chartMargin(coarse)}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              contentStyle={tooltipStyle}
              formatter={(v: number, name: string) => [name === '볼륨' ? `${v.toLocaleString()} kg` : `${v} 세트`, name]}
              {...pinnedTooltipProps(coarse)}
            />
            <Bar dataKey="volume" name="볼륨" fill="var(--h-purple)" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="muted small">데이터 없음</p>
      )}
    </CollapsibleCard>
  )
}

function ExerciseProgressCard({ sessions }: { sessions: StrengthSession[] }) {
  const coarse = useCoarsePointer()
  const names = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) for (const x of s.strength_sets) set.add(x.exercise_name)
    return [...set].sort()
  }, [sessions])
  const [picked, setPicked] = useState<string>('')
  const name = picked || names[0] || ''
  const data = name ? exerciseProgress(sessions, name) : []
  const has = data.some((d) => d.weight != null || d.est1rm != null)
  // 값이 있는 마지막 두 지점 — 중간에 그 종목을 안 한 날이 있어도 건너뛴다
  const topWeight = lastTwo(data, (d) => d.weight)
  const top1rm = lastTwo(data, (d) => d.est1rm)

  return (
    <CollapsibleCard
      id="ex-strength-prog"
      title="종목 진척"
      actions={
        names.length > 0 ? (
          <select className="st-select" value={name} onChange={(e) => setPicked(e.target.value)}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      {has ? (
        <>
        {/* 오른쪽 끝(=최근 기록)이 제일 궁금한 값이다. 이 카드에만 있는 값이라 글로도 띄운다. */}
        <LatestValues
          at={data[data.length - 1]?.day}
          items={[
            {
              label: '최고 중량',
              color: 'var(--h-blue)',
              value: topWeight.cur != null ? `${topWeight.cur}kg` : '-',
              delta: deltaText(topWeight.cur, topWeight.prev, 'kg'),
              good: (topWeight.cur ?? 0) >= (topWeight.prev ?? 0),
            },
            {
              label: '추정 1RM',
              color: 'var(--h-orange)',
              value: top1rm.cur != null ? `${top1rm.cur}kg` : '-',
              delta: deltaText(top1rm.cur, top1rm.prev, 'kg'),
              good: (top1rm.cur ?? 0) >= (top1rm.prev ?? 0),
            },
          ]}
        />
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={chartMargin(coarse)}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} unit="kg" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${v} kg`, n]} {...pinnedTooltipProps(coarse)} />
            <Line type="monotone" dataKey="weight" name="최고 중량" stroke="var(--h-blue)" dot={false} connectNulls />
            <Line type="monotone" dataKey="est1rm" name="추정 1RM" stroke="var(--h-orange)" dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
        </>
      ) : (
        <p className="muted small">기록이 쌓이면 추이가 보입니다</p>
      )}
      {has && <p className="muted small">추정 1RM 은 Epley 공식(중량 × (1 + 횟수/30))입니다.</p>}
    </CollapsibleCard>
  )
}

function ExerciseBreakdown({
  sessions,
  catOf,
}: {
  sessions: StrengthSession[]
  catOf: (name: string) => string | null
}) {
  const stats = byExercise(sessions, catOf)
  if (!stats.length) return <p className="muted small">데이터 없음</p>
  const max = Math.max(...stats.map((s) => s.volumeKg), 1)
  return (
    <div className="type-list">
      {stats.slice(0, 10).map((s) => {
        const color = CATEGORY_COLOR[s.category ?? 'other'] ?? CATEGORY_COLOR.other
        return (
          <div key={s.name} className="type-row">
            <span className="type-name" title={`${s.name} · ${CATEGORY_LABEL[s.category ?? 'other'] ?? '기타'}`}>
              <span className="tf-dot" style={{ background: color }} />
              <span className="type-name-text">{s.name}</span>
            </span>
            <div className="type-bar">
              <div className="type-bar-fill" style={{ width: `${(s.volumeKg / max) * 100}%`, background: color }} />
            </div>
            <span className="type-meta">
              {s.sets}세트 · {s.volumeKg.toLocaleString()}kg
              {s.best1RM != null && ` · 1RM ${s.best1RM}kg`}
            </span>
          </div>
        )
      })}
    </div>
  )
}
