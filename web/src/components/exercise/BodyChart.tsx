import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CollapsibleCard } from '../CollapsibleCard'
import { bodySeries, type BodyMeasurement } from '../../lib/body'
import { chartMargin, pinnedTooltipProps, useCoarsePointer } from '../../lib/chart'

// 체성분 추이. 체중과 체지방률은 단위가 달라 한 축에 겹치면 둘 다 안 읽힌다 —
// 왼쪽은 kg, 오른쪽은 % 로 축을 나눈다.

type Mode = 'composition' | 'segments'

export function BodyChart({ measurements }: { measurements: BodyMeasurement[] }) {
  const [mode, setMode] = useState<Mode>('composition')
  const coarse = useCoarsePointer()
  const data = bodySeries(measurements)
  const has = data.length >= 2

  // 부위별은 주는 기기에서만 있다 (270S 는 안 준다) — 값이 하나도 없으면 탭 자체를 숨긴다
  const last = measurements.length ? measurements[measurements.length - 1] : null
  const hasSegments =
    !!last &&
    [last.arm_l_muscle_kg, last.arm_r_muscle_kg, last.trunk_muscle_kg, last.leg_l_muscle_kg, last.leg_r_muscle_kg].some(
      (v) => v != null,
    )

  const tooltipStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text)',
  }

  return (
    <CollapsibleCard
      id="ex-body-chart"
      title="체성분 추이"
      actions={
        hasSegments ? (
          <div className="seg">
            <button className={`seg-btn ${mode === 'composition' ? 'active' : ''}`} onClick={() => setMode('composition')}>
              추이
            </button>
            <button className={`seg-btn ${mode === 'segments' ? 'active' : ''}`} onClick={() => setMode('segments')}>
              부위별
            </button>
          </div>
        ) : undefined
      }
    >
      {mode === 'segments' && hasSegments && last ? (
        <Segments m={last} />
      ) : has ? (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={chartMargin(coarse)}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis yAxisId="kg" tick={{ fill: 'var(--muted)', fontSize: 11 }} domain={['dataMin - 2', 'dataMax + 2']} />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              domain={['dataMin - 2', 'dataMax + 2']}
              unit="%"
            />
            <Tooltip contentStyle={tooltipStyle} {...pinnedTooltipProps(coarse)} />
            <Line yAxisId="kg" type="monotone" dataKey="weight_kg" name="체중" stroke="var(--h-blue)" dot={false} connectNulls />
            <Line
              yAxisId="kg"
              type="monotone"
              dataKey="skeletal_muscle_kg"
              name="골격근량"
              stroke="var(--h-purple)"
              dot={false}
              connectNulls
            />
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="body_fat_pct"
              name="체지방률"
              stroke="var(--h-orange)"
              dot={false}
              connectNulls
              strokeDasharray="4 3"
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="muted small">측정이 2회 이상 쌓이면 추이가 보입니다.</p>
      )}
      {mode === 'composition' && has && (
        <p className="muted small">왼쪽 축 kg (체중·골격근량) · 오른쪽 축 % (체지방률, 점선)</p>
      )}
    </CollapsibleCard>
  )
}

/** 부위별 근육·지방. 좌우 차이가 크면 그게 곧 교정할 거리다. */
function Segments({ m }: { m: BodyMeasurement }) {
  const rows: { label: string; muscle: number | null; fat: number | null }[] = [
    { label: '왼팔', muscle: m.arm_l_muscle_kg, fat: m.arm_l_fat_kg },
    { label: '오른팔', muscle: m.arm_r_muscle_kg, fat: m.arm_r_fat_kg },
    { label: '몸통', muscle: m.trunk_muscle_kg, fat: m.trunk_fat_kg },
    { label: '왼다리', muscle: m.leg_l_muscle_kg, fat: m.leg_l_fat_kg },
    { label: '오른다리', muscle: m.leg_r_muscle_kg, fat: m.leg_r_fat_kg },
  ]
  const maxM = Math.max(...rows.map((r) => r.muscle ?? 0), 1)

  const armGap = gap(m.arm_l_muscle_kg, m.arm_r_muscle_kg)
  const legGap = gap(m.leg_l_muscle_kg, m.leg_r_muscle_kg)

  return (
    <>
      <div className="type-list">
        {rows.map((r) => (
          <div key={r.label} className="type-row">
            <span className="type-name">
              <span className="type-name-text">{r.label}</span>
            </span>
            <div className="type-bar">
              <div
                className="type-bar-fill"
                style={{ width: `${((r.muscle ?? 0) / maxM) * 100}%`, background: 'var(--h-purple)' }}
              />
            </div>
            <span className="type-meta">
              근육 {r.muscle ?? '-'}kg{r.fat != null && ` · 지방 ${r.fat}kg`}
            </span>
          </div>
        ))}
      </div>
      {(armGap != null || legGap != null) && (
        <p className="muted small">
          좌우 차이 — {armGap != null && `팔 ${armGap}%`}
          {armGap != null && legGap != null && ' · '}
          {legGap != null && `다리 ${legGap}%`}. 10% 를 넘으면 한쪽만 쓰고 있을 수 있습니다.
        </p>
      )}
    </>
  )
}

function gap(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a === 0 || b === 0) return null
  return Math.round((Math.abs(a - b) / Math.max(a, b)) * 1000) / 10
}
