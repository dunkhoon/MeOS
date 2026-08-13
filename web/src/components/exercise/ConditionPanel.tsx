import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { conditionSeries, conditionSummary, type Wellness } from '../../lib/exercise'
import { CollapsibleCard } from '../CollapsibleCard'

type MetricKey = 'restingHr' | 'hrv' | 'sleep' | 'sleepScore' | 'weight'

const METRICS: Record<MetricKey, { label: string; unit: string; color: string; domain?: [number, number] }> = {
  restingHr: { label: '안정시심박', unit: 'bpm', color: 'var(--accent)' },
  hrv: { label: 'HRV', unit: 'ms', color: 'var(--info)' },
  sleep: { label: '수면', unit: '시간', color: 'var(--h-purple)' },
  // 점수는 0~100 고정 축이라야 "80점이 높은 편"인지 한눈에 보인다 (auto 면 매번 축이 달라진다)
  sleepScore: { label: '수면 점수', unit: '점', color: 'var(--warn)', domain: [0, 100] },
  weight: { label: '체중', unit: 'kg', color: 'var(--ok)' },
}

export function ConditionPanel({ wellness }: { wellness: Wellness[] }) {
  const [metric, setMetric] = useState<MetricKey>('hrv')
  const s = conditionSummary(wellness)
  const series = conditionSeries(wellness)
  const active = METRICS[metric]
  const hasData = series.some((d) => d[metric] != null)

  const tiles: { key: MetricKey; val: number | null }[] = [
    { key: 'restingHr', val: s.restingHr },
    { key: 'hrv', val: s.hrv },
    { key: 'sleep', val: s.sleepHours },
    { key: 'sleepScore', val: s.sleepScore },
    { key: 'weight', val: s.weight },
  ]

  return (
    <CollapsibleCard id="ex-condition" title="컨디션 / 웰니스">
      <div className="cond-tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`cond-tile ${t.key === metric ? 'active' : ''}`}
            onClick={() => setMetric(t.key)}
          >
            <div className="cond-val">{t.val ?? '-'}</div>
            <div className="cond-label">
              {METRICS[t.key].label} ({METRICS[t.key].unit})
            </div>
          </button>
        ))}
      </div>

      {hasData ? (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} domain={active.domain ?? ['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }}
              formatter={(v: number) => [`${v} ${active.unit}`, active.label]}
            />
            <Line type="monotone" dataKey={metric} name={active.label} stroke={active.color} dot={false} strokeWidth={2} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="muted small">{active.label} 데이터 없음</p>
      )}
    </CollapsibleCard>
  )
}
