import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  clock,
  fetchActivity,
  fetchActivityDetail,
  lapLabel,
  paceFromSpeed,
  pct,
  type ActivityDetail as Detail,
  type Lap,
} from '../lib/activityDetail'
import { km, paceStr, type Activity } from '../lib/exercise'
import { SESSION_COLOR, SESSION_LABEL, sessionKind } from '../lib/session'

// 훈련 상세 — 캘린더/최근활동에서 넘어온다. 요약 + 랩 분석 + 데이터 추이.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 6.png 의 토글. intervals.icu 스트림 이름과 표시 방식을 묶어 둔다. */
type MetricKey = 'heartrate' | 'velocity_smooth' | 'cadence' | 'watts' | 'vertical_ratio'
interface Metric {
  key: MetricKey
  label: string
  unit: string
  color: string
  digits: number
  /** m/s 를 페이스(분:초/km)로 뒤집어 보여줘야 하는 항목 */
  pace?: boolean
}
const METRICS: Metric[] = [
  { key: 'heartrate', label: '심박수', unit: 'bpm', color: '#3b82f6', digits: 0 },
  { key: 'velocity_smooth', label: '페이스', unit: '/km', color: '#3fb950', digits: 0, pace: true },
  { key: 'cadence', label: '케이던스', unit: 'spm', color: '#a371f7', digits: 0 },
  { key: 'watts', label: '파워', unit: 'W', color: '#d29922', digits: 0 },
  { key: 'vertical_ratio', label: '수직비율', unit: '%', color: '#22d3ee', digits: 1 },
]

export default function ActivityDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [act, setAct] = useState<Activity | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [metric, setMetric] = useState<MetricKey>('heartrate')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    setDetailErr(null)
    try {
      const a = await fetchActivity(id)
      setAct(a)
      if (!a) {
        setErr('이 활동을 찾을 수 없습니다. 동기화가 안 됐을 수 있어요.')
        return
      }
      // 요약은 떴는데 랩/추이만 실패할 수 있다 — 그 경우 요약이라도 보여준다
      try {
        setDetail(await fetchActivityDetail(id))
      } catch (e) {
        setDetailErr(errMsg(e))
      }
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const kind = act ? sessionKind(act) : 'other'
  const laps = detail?.laps ?? []

  // 워밍업/휴식을 뺀 "실제 훈련 구간" — 랩 표에서 강조한다
  const workLaps = useMemo(() => laps.filter((l) => /work/i.test(l.type)), [laps])

  const chartData = useMemo(() => {
    const s = detail?.streams
    if (!s?.time) return []
    const series = s[metric]
    if (!series) return []
    return s.time.map((t, i) => {
      let v = series[i] ?? null
      // 페이스는 m/s 로 온다. 멈춰 있던 구간(≈0)은 페이스가 무한대로 튀어 축을 망가뜨린다
      if (metric === 'velocity_smooth' && v != null && v < 0.5) v = null
      return { t: t ?? 0, v }
    })
  }, [detail, metric])

  /**
   * Y축 범위를 데이터에서 직접 잡는다.
   * 'dataMin - 5' 같은 고정 여백은 단위마다 의미가 달라서 (bpm 은 120~180, m/s 는 0~4)
   * 속도 그래프가 -5 부터 그려지며 납작해졌다.
   */
  const domain = useMemo<[number, number]>(() => {
    const vals = chartData.map((d) => d.v).filter((v): v is number => v != null)
    if (!vals.length) return [0, 1]
    // 최소·최대 대신 2~98 백분위로 잡는다. 신호 한 점이 튀면(정지 직전 페이스 등)
    // 그것 때문에 나머지 그래프가 납작해지기 때문.
    const sorted = [...vals].sort((a, b) => a - b)
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))]
    const lo = at(0.02)
    const hi = at(0.98)
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08
    return [lo - pad, hi + pad]
  }, [chartData])

  const meta = METRICS.find((m) => m.key === metric)!

  if (loading) {
    return (
      <div className="page">
        <p className="muted">불러오는 중…</p>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-head ad-head">
        <div>
          <button className="link-btn ad-back" onClick={() => navigate(-1)}>
            ← 뒤로
          </button>
          <h2>{act?.name || '활동'}</h2>
          <p className="muted">
            {act?.start_date_local ? dayjs(act.start_date_local).format('YYYY년 M월 D일 (ddd) HH:mm') : ''}
            {act?.type ? ` · ${act.type}` : ''}
            {act?.device_name ? ` · ${act.device_name}` : ''}
          </p>
        </div>
      </header>

      {err && <div className="sync-msg err">{err}</div>}

      {act && (
        <>
          <div className="ad-top">
            <div className="card ad-kind" style={{ borderColor: SESSION_COLOR[kind] + '80' }}>
              <div className="ad-kind-name" style={{ color: SESSION_COLOR[kind] }}>
                {SESSION_LABEL[kind] || act.type || '활동'}
              </div>
              <div className="muted small">세션 종류 (이름에서 추정)</div>
            </div>

            <div className="card ad-kpis">
              <Kpi label="총 시간" value={clock(act.moving_time_s)} />
              <Kpi label="거리" value={`${km(act.distance_m).toFixed(1)} km`} />
              <Kpi label="평균 페이스" value={paceStr(act.distance_m, act.moving_time_s)} />
              <Kpi label="평균 HR" value={act.average_hr ? `${act.average_hr} bpm` : '-'} tone="#3fb950" />
              <Kpi label="최고 HR" value={act.max_hr ? `${act.max_hr} bpm` : '-'} tone="#f85149" />
              <Kpi label="훈련부하" value={act.training_load != null ? String(act.training_load) : '-'} tone="#d29922" />
              <Kpi label="칼로리" value={act.calories ? `${act.calories} kcal` : '-'} />
              {detail?.lthr && <Kpi label="LTHR" value={`${detail.lthr} bpm`} tone="#f85149" />}
            </div>
          </div>

          {detailErr && (
            <div className="sync-msg err">
              랩·추이를 불러오지 못했습니다: {detailErr}
              <button className="link-btn" style={{ marginLeft: 10 }} onClick={() => void load()}>
                다시 시도
              </button>
            </div>
          )}

          {/* ── 데이터 추이 (6.png) ── */}
          {chartData.length > 0 && (
            <div className="card ad-chart">
              <div className="ad-chart-head">
                <h3 className="card-title">데이터 추이</h3>
                <div className="ad-metrics">
                  {METRICS.map((m) => {
                    const has = (detail?.streams?.[m.key] ?? []).some((v) => v != null)
                    return (
                      <button
                        key={m.key}
                        type="button"
                        className={`tf-btn ${metric === m.key ? 'active' : ''}`}
                        disabled={!has}
                        title={has ? undefined : '이 활동에는 데이터가 없어요'}
                        onClick={() => setMetric(m.key)}
                      >
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={chartData} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="adFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={meta.color} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={meta.color} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#232733" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(t: number) => clock(t)}
                    stroke="#6f7688"
                    fontSize={11}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#6f7688"
                    fontSize={11}
                    width={52}
                    domain={domain}
                    tickFormatter={(v: number) => (meta.pace ? paceFromSpeed(v) : v.toFixed(meta.digits))}
                  />
                  {/* 심박수에는 LTHR 기준선을 얹는다 — 어디를 넘었는지가 한눈에 보인다 */}
                  {metric === 'heartrate' && detail?.lthr && (
                    <ReferenceLine
                      y={detail.lthr}
                      stroke="#f85149"
                      strokeDasharray="4 4"
                      // position:'right' 은 차트 밖으로 나가 잘린다 — 안쪽에 붙인다
                      label={{ value: `LTHR ${detail.lthr}`, position: 'insideTopRight', fill: '#f85149', fontSize: 11 }}
                    />
                  )}
                  <Tooltip
                    contentStyle={{ background: '#14161d', border: '1px solid #232733', borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(t) => `경과 ${clock(Number(t))}`}
                    formatter={(v: number) => [
                      meta.pace ? `${paceFromSpeed(v)} /km` : `${v.toFixed(meta.digits)} ${meta.unit}`,
                      meta.label,
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={meta.color}
                    strokeWidth={1.6}
                    fill="url(#adFill)"
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <p className="muted small">
                {meta.label} — 가로축은 경과 시간. 점이 많아 구간 평균으로 줄여 그립니다.
              </p>
            </div>
          )}

          {/* ── 랩 분석 (7.png) ── */}
          {laps.length > 0 && (
            <div className="card ad-laps">
              <h3 className="card-title">랩 분석</h3>
              <p className="muted small">
                총 {laps.length}개 구간 · 그중 훈련 구간 {workLaps.length}개
                {detail?.lthr ? ` · LTHR ${detail.lthr}bpm 기준` : ''}
              </p>
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>구분</th>
                      <th className="num">시간</th>
                      <th className="num">거리</th>
                      <th className="num">페이스</th>
                      <th className="num">평균 HR</th>
                      <th className="num">최고 HR</th>
                      {detail?.lthr ? <th className="num">LTHR%</th> : null}
                      <th className="num">케이던스</th>
                      <th className="num">파워</th>
                    </tr>
                  </thead>
                  <tbody>
                    {laps.map((l) => (
                      <LapRow key={l.index} lap={l} lthr={detail?.lthr ?? null} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}>종합 ({laps.length}개)</td>
                      <td className="num">{clock(act.moving_time_s)}</td>
                      <td className="num">{km(act.distance_m).toFixed(1)} km</td>
                      <td className="num">{paceStr(act.distance_m, act.moving_time_s)}</td>
                      <td className="num">{act.average_hr ?? '-'}</td>
                      <td className="num">{act.max_hr ?? '-'}</td>
                      {detail?.lthr ? <td className="num">{pct(act.average_hr, detail.lthr)}</td> : null}
                      <td className="num">-</td>
                      <td className="num">-</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {!detailErr && laps.length === 0 && chartData.length === 0 && (
            <div className="card muted">이 활동에는 랩·추이 데이터가 없습니다.</div>
          )}
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="ad-kpi">
      <div className="ad-kpi-label">{label}</div>
      <div className="ad-kpi-val" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  )
}

function LapRow({ lap, lthr }: { lap: Lap; lthr: number | null }) {
  const isWork = /work/i.test(lap.type)
  return (
    <tr className={isWork ? 'work' : 'rest'}>
      <td className="muted">{lap.index}</td>
      <td>
        <span className={`chip lap-${isWork ? 'work' : 'rest'}`}>{lapLabel(lap)}</span>
      </td>
      <td className="num">{clock(lap.movingTime)}</td>
      <td className="num">{(lap.distance / 1000).toFixed(2)} km</td>
      <td className="num">{paceFromSpeed(lap.speed)} /km</td>
      <td className="num strong">{lap.avgHr ?? '-'}</td>
      <td className="num">{lap.maxHr ?? '-'}</td>
      {lthr ? <td className="num">{pct(lap.avgHr, lthr)}</td> : null}
      <td className="num">{lap.cadence ? `${Math.round(lap.cadence * 2)}spm` : '-'}</td>
      <td className="num">{lap.watts ? `${Math.round(lap.watts)}W` : '-'}</td>
    </tr>
  )
}
