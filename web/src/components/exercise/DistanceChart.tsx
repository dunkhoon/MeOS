import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts'
import {
  GRAN_META,
  HR_ZONES,
  ZONE_COLORS,
  distanceSeriesByType,
  typeColor,
  zoneSeries,
  type Activity,
  type Gran,
} from '../../lib/exercise'
import { CollapsibleCard } from '../CollapsibleCard'

const GRAN_TABS: { key: Gran; label: string }[] = [
  { key: 'week', label: '주간' },
  { key: 'month', label: '월간' },
  { key: 'year', label: '연간' },
]

type Mode = 'distance' | 'zones'
const MODE_TABS: { key: Mode; label: string }[] = [
  { key: 'distance', label: '거리' },
  { key: 'zones', label: '심박존' },
]

// 거리 모드 커스텀 툴팁: 종류별 + 맨 아래 All 합계
function DistanceTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const rows = payload.filter((p) => (p.value as number) > 0)
  const total = payload.reduce((s, p) => s + ((p.value as number) || 0), 0)
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{label}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey)} className="chart-tip-row">
          <span className="chart-tip-dot" style={{ background: p.color }} />
          <span className="chart-tip-name">{String(p.name)}</span>
          <span className="chart-tip-val">{p.value as number} km</span>
        </div>
      ))}
      <div className="chart-tip-row chart-tip-total">
        <span className="chart-tip-dot" style={{ background: 'transparent' }} />
        <span className="chart-tip-name">All</span>
        <span className="chart-tip-val">{Math.round(total * 10) / 10} km</span>
      </div>
    </div>
  )
}

export function DistanceChart({ activities, types }: { activities: Activity[]; types: string[] }) {
  const [gran, setGran] = useState<Gran>('week')
  const [mode, setMode] = useState<Mode>('distance')

  const distData = distanceSeriesByType(activities, gran, types)
  const zoneData = zoneSeries(activities, gran)
  const hasDist = distData.some((d) => types.some((t) => (d[t] as number) > 0))
  const hasZone = zoneData.some((d) => HR_ZONES.some((z) => d[z] > 0))

  const controls = (
    <div className="chart-controls">
      <div className="seg">
        {MODE_TABS.map((t) => (
          <button key={t.key} className={`seg-btn ${t.key === mode ? 'active' : ''}`} onClick={() => setMode(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="seg">
        {GRAN_TABS.map((t) => (
          <button key={t.key} className={`seg-btn ${t.key === gran ? 'active' : ''}`} onClick={() => setGran(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )

  const tooltipStyle = { background: '#1b1e27', border: '1px solid #262a35', borderRadius: 8, color: '#e6e8ee' }

  return (
    <CollapsibleCard
      id="ex-distance"
      title={
        <>
          {mode === 'distance' ? '거리' : '심박 존'} <span className="muted small">({GRAN_META[gran].title})</span>
        </>
      }
      actions={controls}
    >
      {mode === 'distance' ? (
        hasDist ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={distData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="#262a35" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#8b90a0', fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis tick={{ fill: '#8b90a0', fontSize: 11 }} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DistanceTooltip />} />
              {types.map((t) => (
                <Bar key={t} dataKey={t} stackId="dist" fill={typeColor(t)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="muted small">데이터 없음</p>
        )
      ) : hasZone ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={zoneData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="#262a35" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#8b90a0', fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={{ fill: '#8b90a0', fontSize: 11 }} domain={[0, 100]} unit="%" />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={tooltipStyle} formatter={(v: number, name: string) => [`${v}%`, name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {HR_ZONES.map((z) => (
              <Bar key={z} dataKey={z} stackId="zone" fill={ZONE_COLORS[z]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="muted small">심박존 데이터 없음</p>
      )}
    </CollapsibleCard>
  )
}
