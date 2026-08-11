import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { conditionSeries, conditionSummary, type Wellness } from '../../lib/exercise'
import { CollapsibleCard } from '../CollapsibleCard'

type MetricKey = 'restingHr' | 'hrv' | 'sleep' | 'weight'

const METRICS: Record<MetricKey, { label: string; unit: string; color: string }> = {
  restingHr: { label: '안정시심박', unit: 'bpm', color: '#ff6b35' },
  hrv: { label: 'HRV', unit: 'ms', color: '#3fb0ff' },
  sleep: { label: '수면', unit: '시간', color: '#a78bfa' },
  weight: { label: '체중', unit: 'kg', color: '#3fb950' },
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
            <CartesianGrid stroke="#262a35" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: '#8b90a0', fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={{ fill: '#8b90a0', fontSize: 11 }} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: '#1b1e27', border: '1px solid #262a35', borderRadius: 8, color: '#e6e8ee' }}
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
