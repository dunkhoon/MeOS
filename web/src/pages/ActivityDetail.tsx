import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
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
  fetchActivityNotes,
  lapLabel,
  setSessionKind,
  paceFromSpeed,
  pct,
  type ActivityDetail as Detail,
  type ActivityNote,
  type Lap,
  type StreamKey,
  type Streams,
} from '../lib/activityDetail'
import { METRICS, PLOTTABLE, metric as metricSpec } from '../lib/metrics'
import { fetchActivities, km, paceStr, type Activity } from '../lib/exercise'

import { PlaybackBar, type Speed } from '../components/exercise/PlaybackBar'
import { advance, lapAtTime, sampleAt } from '../lib/playback'

// 지도(leaflet)는 150KB 가 넘는데 GPS 있는 활동에서만 쓴다 — 필요할 때만 받아 온다
const RouteMap = lazy(() => import('../components/exercise/RouteMap').then((m) => ({ default: m.RouteMap })))

/** 1배속에서 활동 전체를 재생하는 데 걸리는 시간(초). 1시간 러닝도 30초면 다 본다. */
const PLAY_SECONDS = 30
/** 커서 갱신 주기. 60fps 로 돌리면 Recharts 가 매 프레임 다시 그려 버벅인다. */
const TICK_MS = 60
import { SESSION_COLOR, SESSION_KINDS, SESSION_LABEL, isManualKind, sessionKind, type SessionKind } from '../lib/session'
import { analyzeSession, type Finding } from '../lib/nsm'
import { alpha } from '../lib/color'

// 훈련 상세 — 캘린더/최근활동에서 넘어온다. 요약 + 랩 분석 + 데이터 추이.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 그래프에 그릴 수 있는 항목. 표시 규칙은 lib/metrics.ts 한 곳에 모아 뒀다. */
type MetricKey = StreamKey

export default function ActivityDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [act, setAct] = useState<Activity | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [metric, setMetric] = useState<MetricKey>('heartrate')
  const [notes, setNotes] = useState<ActivityNote[]>([])
  /** 비교용 최근 활동 목록. 세션 종류를 바꾸면 비교 대상도 달라지므로 목록째 들고 있는다. */
  const [recent, setRecent] = useState<Activity[]>([])
  const [savingKind, setSavingKind] = useState(false)
  const [kindErr, setKindErr] = useState<string | null>(null)
  /** 재생 커서 (경과 초). null = 재생 전 — 지도·그래프·랩이 모두 이 값을 본다 */
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  /** 그래프에 마우스를 올린 지점 — 지도에도 같이 찍는다 */
  const [hoverT, setHoverT] = useState<number | null>(null)
  /** 지도에서 강조할 랩 (0-based). 랩 표에서 고른다 */
  const [selLap, setSelLap] = useState<number | null>(null)

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
      void fetchActivityNotes(id).then(setNotes)
      void loadRecent(a).then(setRecent)
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
  const manual = act ? isManualKind(act) : false
  const laps = detail?.laps ?? []

  // ── 재생 ────────────────────────────────────────────────
  /** 스트림의 경과 시간축. 값이 비면 인덱스를 초로 대신 쓴다. */
  const timeAxis = useMemo(
    () => (detail?.streams?.time ?? []).map((v, i) => (typeof v === 'number' ? v : i)),
    [detail],
  )
  // 셋의 끝이 조금씩 다르다 — 추이는 다운샘플돼 마지막 점이 잘리고, 경로·랩은 원본 기준이다.
  // 가장 늦은 끝을 쓰지 않으면 마지막 몇 초가 재생되지 않는다.
  const total = useMemo(() => {
    const end = Math.max(
      timeAxis.length ? timeAxis[timeAxis.length - 1] : 0,
      detail?.routeT?.length ? detail.routeT[detail.routeT.length - 1] : 0,
      laps.length ? laps[laps.length - 1].endT : 0,
    )
    return end > 0 ? end : (act?.moving_time_s ?? 0)
  }, [timeAxis, detail, laps, act])

  // rAF 안에서 최신 커서를 읽어야 하는데 state 는 클로저에 갇힌다
  const cursorRef = useRef(0)
  useEffect(() => {
    cursorRef.current = cursor ?? 0
  }, [cursor])

  // 활동이 바뀌면 재생·선택을 처음으로
  useEffect(() => {
    setCursor(null)
    setPlaying(false)
    setHoverT(null)
    setSelLap(null)
    cursorRef.current = 0
  }, [id])

  useEffect(() => {
    if (!playing || total <= 0) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const step = (now: number) => {
      acc += now - last
      last = now
      if (acc >= TICK_MS) {
        const next = advance(cursorRef.current, acc, total, speed, PLAY_SECONDS)
        acc = 0
        cursorRef.current = next
        setCursor(next)
        if (next >= total) setPlaying(false)
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, total, speed])

  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    // 끝까지 본 뒤 다시 누르면 처음부터
    if (cursor == null || cursor >= total) {
      cursorRef.current = 0
      setCursor(0)
    }
    setPlaying(true)
  }
  const stopPlay = () => {
    setPlaying(false)
    cursorRef.current = 0
    setCursor(null)
  }
  const seek = (t: number) => {
    cursorRef.current = t
    setCursor(t)
  }

  /** 재생 중 지금 값 — 조작줄에 띄운다 */
  const readout = useMemo(() => {
    if (cursor == null) return null
    const s = detail?.streams
    const v = sampleAt(timeAxis, s?.velocity_smooth, cursor)
    return {
      distanceM: sampleAt(timeAxis, s?.distance, cursor),
      totalM: act?.distance_m ?? null,
      // 멈춰 있던 구간은 페이스가 무한대로 튄다
      pace: paceFromSpeed(v != null && v >= 0.5 ? v : null),
      hr: sampleAt(timeAxis, s?.heartrate, cursor),
      cadence: sampleAt(timeAxis, s?.cadence, cursor),
      lapNow: laps.length ? lapAtTime(laps, cursor) + 1 : 0,
      lapTotal: laps.length,
    }
  }, [cursor, detail, timeAxis, act, laps])

  /** 재생 커서가 지금 어느 랩에 있는지 (0-based, -1 이면 재생 아님) */
  const curLap = cursor == null || !laps.length ? -1 : lapAtTime(laps, cursor)

  /** 지도에 강조할 구간 — 고른 랩이 우선, 없으면 재생 중인 랩 */
  const lapRange = useMemo<[number, number] | null>(() => {
    const i = selLap ?? -1
    const l = laps[i]
    return l ? [l.startT, l.endT] : null
  }, [selLap, laps])

  /** 세션 종류 수동 지정. null 이면 지정을 지우고 이름 추정으로 되돌린다. */
  const saveKind = async (next: SessionKind | null) => {
    if (!act) return
    setSavingKind(true)
    setKindErr(null)
    const before = act
    // 화면에 먼저 반영 — 분석·색이 바로 따라 바뀐다
    setAct({ ...act, session_kind: next })
    try {
      await setSessionKind(act.external_id, next)
    } catch (e) {
      setAct(before)
      setKindErr(errMsg(e))
    } finally {
      setSavingKind(false)
    }
  }

  /** 같은 종류 최근 세션의 **활동 평균** 심박 (이번 활동 제외). kind 가 바뀌면 다시 계산된다. */
  const recentAvgHr = useMemo(() => {
    if (!act) return null
    const peers = recent
      .filter((x) => x.external_id !== act.external_id && x.average_hr && sessionKind(x) === kind)
      .slice(0, 8)
    return peers.length ? peers.reduce((s, x) => s + (x.average_hr as number), 0) / peers.length : null
  }, [recent, act, kind])

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

  const meta = metricSpec(metric)

  /** 재생 중 "지나온 부분"만 색이 살아 있는 겹선. 아직 안 온 구간은 null 이라 안 그려진다. */
  const playedData = useMemo(
    () => (cursor == null ? null : chartData.map((d) => ({ t: d.t, v: d.t <= cursor ? d.v : null }))),
    [chartData, cursor],
  )
  /** 커서 위치의 값 — 그래프 위에 점을 찍는다 */
  const cursorValue = useMemo(() => {
    if (cursor == null) return null
    let v = sampleAt(timeAxis, detail?.streams?.[metric], cursor)
    if (metric === 'velocity_smooth' && v != null && v < 0.5) v = null
    return v
  }, [cursor, detail, metric, timeAxis])

  // 규칙 기반 분석 — LLM 이 아니라 랩·심박 산술이라 바로 계산된다
  const analysis = useMemo(
    () =>
      laps.length
        ? analyzeSession({
            kind,
            lthr: detail?.lthr ?? null,
            laps,
            streams: detail?.streams ?? {},
            activityAvgHr: act?.average_hr ?? null,
            recentAvgHr,
          })
        : null,
    [kind, detail, laps, recentAvgHr, act],
  )

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
            <div className="card ad-kind" style={{ borderColor: alpha(SESSION_COLOR[kind], 50) }}>
              <div className="ad-kind-name" style={{ color: SESSION_COLOR[kind] }}>
                {SESSION_LABEL[kind] || act.type || '활동'}
              </div>
              <div className="muted small">세션 종류 {manual ? '(직접 지정)' : '(이름에서 추정)'}</div>
            </div>

            <div className="card ad-kpis">
              <Kpi label="총 시간" value={clock(act.moving_time_s)} />
              <Kpi label="거리" value={`${km(act.distance_m).toFixed(1)} km`} />
              <Kpi label="평균 페이스" value={paceStr(act.distance_m, act.moving_time_s)} />
              <Kpi label="평균 HR" value={act.average_hr ? `${act.average_hr} bpm` : '-'} tone="var(--ok)" />
              <Kpi label="최고 HR" value={act.max_hr ? `${act.max_hr} bpm` : '-'} tone="var(--danger)" />
              <Kpi label="훈련부하" value={act.training_load != null ? String(act.training_load) : '-'} tone="var(--warn)" />
              <Kpi label="칼로리" value={act.calories ? `${act.calories} kcal` : '-'} />
              {detail?.lthr && <Kpi label="LTHR" value={`${detail.lthr} bpm`} tone="var(--danger)" />}
            </div>
          </div>

          {/* ── 세션 타입 수동 지정 (6.png) ── */}
          <div className="card ad-kindpick">
            <div className="ad-kp-head">
              <h3 className="card-title">세션 타입</h3>
              <p className="muted small">
                바꾸면 캘린더 색과 <b>규칙 기반 분석의 목표 심박대</b>가 함께 바뀝니다.
              </p>
            </div>
            <div className="ad-kp-btns">
              {SESSION_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`tf-btn ${kind === k ? 'active' : ''}`}
                  style={kind === k ? { borderColor: SESSION_COLOR[k], color: SESSION_COLOR[k] } : undefined}
                  disabled={savingKind}
                  onClick={() => void saveKind(k)}
                >
                  {SESSION_LABEL[k] || 'OTHER'}
                </button>
              ))}
              <button
                type="button"
                className="link-btn ad-kp-auto"
                disabled={savingKind || !manual}
                title={manual ? '지정을 지우고 활동 이름에서 다시 추정합니다' : '지금도 자동 추정 중입니다'}
                onClick={() => void saveKind(null)}
              >
                자동으로 되돌리기
              </button>
            </div>
            {kindErr && <p className="error small">{kindErr}</p>}
          </div>

          {/* ── NSM 규칙 기반 분석 (5.png) — 계산이라 LLM 없이 즉시 나온다 ── */}
          {analysis && analysis.findings.length > 0 && (
            <div className="card ad-analysis">
              <div className="ad-an-head">
                <span className={`ad-verdict v-${analysis.verdict}`}>{analysis.verdict}</span>
                <div>
                  <h3 className="card-title">NSM 규칙 기반 분석</h3>
                  <p className="muted small">{analysis.headline}</p>
                </div>
              </div>
              <div className="ad-findings">
                {analysis.findings.map((f, i) => (
                  <FindingRow key={i} f={f} />
                ))}
              </div>
              <p className="muted small ad-an-note">
                ※ 랩·심박 데이터에서 계산한 값입니다 (AI 아님). 컨디션·날씨 같은 변수는 반영되지 않습니다.
              </p>
            </div>
          )}

          {/* ── 외부 AI 코멘트 (OpenClaw → Edge Function `note`) ── */}
          {notes.map((n) => (
            <div className="card ad-note" key={n.source}>
              <div className="ad-note-head">
                <h3 className="card-title">🤖 AI 코멘트</h3>
                <span className="muted small">
                  {n.source}
                  {n.model ? ` · ${n.model}` : ''} · {dayjs(n.updatedAt).format('M/D HH:mm')}
                </span>
              </div>
              <div className="ad-note-body">{n.content}</div>
            </div>
          ))}

          {detailErr && (
            <div className="sync-msg err">
              랩·추이를 불러오지 못했습니다: {detailErr}
              <button className="link-btn" style={{ marginLeft: 10 }} onClick={() => void load()}>
                다시 시도
              </button>
            </div>
          )}

          {/* ── 경로 지도 — GPS 가 있는 활동만 (실내·수동 입력은 빈 배열) ── */}
          {(detail?.route?.length ?? 0) >= 2 && (
            <Suspense fallback={<div className="card ad-map muted small">지도 불러오는 중…</div>}>
              <RouteMap
                route={detail!.route}
                routeT={detail!.routeT}
                cursor={cursor}
                hoverT={hoverT}
                lapRange={lapRange}
              >
                <PlaybackBar
                  playing={playing}
                  cursor={cursor}
                  total={total}
                  speed={speed}
                  readout={readout}
                  onToggle={togglePlay}
                  onStop={stopPlay}
                  onSeek={seek}
                  onSpeed={setSpeed}
                />
              </RouteMap>
            </Suspense>
          )}

          {/* ── 데이터 추이 (6.png) ── */}
          {chartData.length > 0 && (
            <div className="card ad-chart">
              <div className="ad-chart-head">
                <h3 className="card-title">데이터 추이</h3>
                <div className="ad-metrics">
                  {PLOTTABLE.map((m) => {
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
                <AreaChart
                  data={chartData}
                  margin={{ top: 6, right: 12, left: 0, bottom: 0 }}
                  // 그래프에 올린 지점을 지도에도 찍어 준다
                  onMouseMove={(s: { activeLabel?: string | number; isTooltipActive?: boolean }) => {
                    const t = Number(s?.activeLabel)
                    setHoverT(s?.isTooltipActive && Number.isFinite(t) ? t : null)
                  }}
                  onMouseLeave={() => setHoverT(null)}
                >
                  <defs>
                    <linearGradient id="adFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={meta.color} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={meta.color} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  {/* 숫자 축이라야 재생 커서(ReferenceLine/Dot)를 임의 위치에 놓을 수 있다.
                      category 축이면 x 가 데이터 값과 정확히 일치해야만 그려진다. */}
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[0, Math.max(1, total)]}
                    tickFormatter={(t: number) => clock(t)}
                    stroke="var(--muted)"
                    fontSize={11}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="var(--muted)"
                    fontSize={11}
                    width={52}
                    domain={domain}
                    tickFormatter={(v: number) => (meta.tick ?? String)(v)}
                  />
                  {/* 심박수에는 LTHR 기준선을 얹는다 — 어디를 넘었는지가 한눈에 보인다 */}
                  {metric === 'heartrate' && detail?.lthr && (
                    <ReferenceLine
                      y={detail.lthr}
                      stroke="var(--danger)"
                      strokeDasharray="4 4"
                      // position:'right' 은 차트 밖으로 나가 잘린다 — 안쪽에 붙인다
                      label={{ value: `LTHR ${detail.lthr}`, position: 'insideTopRight', fill: 'var(--danger)', fontSize: 11 }}
                    />
                  )}
                  {/* 그래프는 한 항목만 그리지만, 툴팁에는 그 시점의 값을 전부 보여준다 */}
                  <Tooltip
                    cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
                    isAnimationActive={false}
                    content={<AllMetricsTooltip times={timeAxis} streams={detail?.streams ?? {}} activeKey={metric} />}
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    // 재생 중에는 전체 선을 죽이고, 지나온 부분만 아래 겹선으로 살린다
                    stroke={cursor == null ? meta.color : 'var(--border)'}
                    strokeWidth={1.6}
                    fill={cursor == null ? 'url(#adFill)' : 'none'}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                  {playedData && (
                    <Area
                      type="monotone"
                      data={playedData}
                      dataKey="v"
                      stroke={meta.color}
                      strokeWidth={1.8}
                      fill="url(#adFill)"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  )}
                  {cursor != null && <ReferenceLine x={cursor} stroke="var(--text)" strokeOpacity={0.55} />}
                  {cursor != null && cursorValue != null && (
                    <ReferenceDot x={cursor} y={cursorValue} r={4.5} fill={meta.color} stroke="var(--bg)" strokeWidth={2} />
                  )}
                </AreaChart>
              </ResponsiveContainer>
              <p className="muted small">
                {meta.label} — 가로축은 경과 시간. 그래프에 마우스를 올리면 그 시점의 모든 값과 지도 위치가 함께 표시됩니다.
                {cursor != null && cursorValue != null && (
                  <>
                    {' · 지금 '}
                    <b style={{ color: meta.color }}>{meta.fmt(cursorValue)}</b>
                  </>
                )}
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
                {curLap >= 0 && (
                  <span className="lap-play-badge">
                    재생 중 · {curLap + 1}/{laps.length}번째 구간
                  </span>
                )}
                {selLap != null ? (
                  <>
                    {' · '}
                    <b>{selLap + 1}번 구간</b>을 지도에 표시 중
                    <button className="link-btn small" style={{ marginLeft: 8 }} onClick={() => setSelLap(null)}>
                      선택 해제
                    </button>
                  </>
                ) : (
                  ' · 행을 누르면 그 구간이 지도에 표시됩니다'
                )}
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
                      <LapRow
                        key={l.index}
                        lap={l}
                        lthr={detail?.lthr ?? null}
                        // 재생 중이면 지금 구간을 강조하고, 아직 안 온 구간은 흐리게
                        play={cursor == null ? null : l.index - 1 === curLap ? 'now' : l.startT > cursor ? 'future' : 'past'}
                        selected={selLap === l.index - 1}
                        onSelect={() => setSelLap((p) => (p === l.index - 1 ? null : l.index - 1))}
                      />
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

/** 비교용 최근 활동 (최근 90일). 종류별 평균은 화면에서 그때그때 고른다. */
async function loadRecent(a: Activity): Promise<Activity[]> {
  try {
    const since = dayjs(a.start_date_local ?? undefined)
      .subtract(90, 'day')
      .format('YYYY-MM-DD')
    return await fetchActivities(since)
  } catch {
    return []
  }
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <div className={`ad-finding lv-${f.level}`}>
      <span className="ad-f-icon">{f.icon}</span>
      <span>{f.text}</span>
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

/** 그 시점의 모든 값을 한 번에 보여주는 툴팁. 그래프는 하나만 그려도 몸은 전부 기록되어 있다. */
function AllMetricsTooltip({
  times,
  streams,
  activeKey,
  label,
  payload,
}: {
  times: number[]
  streams: Streams
  /** 지금 그래프에 그리는 항목. ⚠️ `active` 라고 이름 붙이면 안 된다 —
   *  Recharts 가 content 를 복제하며 자기 `active`(boolean)로 덮어써 버린다. */
  activeKey: StreamKey
  // Recharts 가 넣어 주는 값들 (직접 넘기지 않는다)
  label?: number
  payload?: unknown[]
}) {
  if (!payload?.length || label == null) return null
  const t = Number(label)
  const rows = METRICS.map((m) => {
    let v = sampleAt(times, streams[m.key], t)
    // 멈춰 있던 구간의 페이스는 무한대로 튄다 — 값 없음으로 둔다
    if (m.key === 'velocity_smooth' && v != null && v < 0.5) v = null
    return { m, v }
  }).filter((r) => r.v != null)
  if (!rows.length) return null

  return (
    <div className="ad-tip">
      <div className="ad-tip-head">경과 {clock(t)}</div>
      <div className="ad-tip-grid">
        {rows.map(({ m, v }) => (
          <div key={m.key} className={`ad-tip-row ${m.key === activeKey ? 'on' : ''}`}>
            <span className="ad-tip-k">
              <i style={{ background: m.color ?? 'var(--muted)' }} />
              {m.label}
            </span>
            <span className="ad-tip-v">{m.fmt(v as number)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LapRow({
  lap,
  lthr,
  play,
  selected,
  onSelect,
}: {
  lap: Lap
  lthr: number | null
  play: 'now' | 'past' | 'future' | null
  selected: boolean
  onSelect: () => void
}) {
  const isWork = /work/i.test(lap.type)
  return (
    <tr
      className={`${isWork ? 'work' : 'rest'}${play ? ` lap-${play}` : ''}${selected ? ' lap-sel' : ''}`}
      onClick={onSelect}
      title="지도에서 이 구간을 표시합니다"
    >
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
