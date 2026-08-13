import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { indexAtTime } from '../../lib/playback'
import { isLightTheme } from '../../lib/theme'
import type { Route } from '../../lib/activityDetail'

// 활동 경로 지도 — intervals.icu 의 latlng 스트림을 그대로 선으로 그린다.
//
// 마커는 L.marker 가 아니라 circleMarker 다 — L.marker 는 아이콘 PNG 를 따로 요구해서
// 번들러마다 경로가 깨진다. 원 마커는 SVG 라 그런 문제가 없다.
//
// 시간(초)으로 들어오는 표시가 셋 있고, 각각 다른 레이어를 쓴다:
//   cursor   재생 위치 — 지나온 구간에 색이 차고 현재 위치에 점
//   hoverT   그래프에 올린 마우스 위치 — 작은 고리 하나
//   lapRange 고른 랩 구간 — 그 구간만 굵게

/** 지도 종류. 기본은 '자세히' — 길·건물·지명이 다 보여야 어디를 뛰었는지 읽힌다. */
type MapStyle = 'detail' | 'plain'
const STYLE_KEY = 'pp:map:style'

const OSM = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: { maxZoom: 19, attribution: '© OpenStreetMap 기여자' },
}
const CARTO = (variant: 'dark_all' | 'light_all') => ({
  url: `https://{s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}{r}.png`,
  options: { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap · © CARTO' },
})

const TRACK = 'var(--accent)'
/** 재생 중 아직 안 지난 구간 — 있는 건 보이되 눈에 덜 띄게 */
const AHEAD = 'var(--muted)'

export function RouteMap({
  route,
  routeT,
  cursor,
  hoverT,
  lapRange,
  children,
}: {
  route: Route
  routeT: number[]
  /** 재생 커서(경과 초). null 이면 재생 아님 */
  cursor: number | null
  /** 그래프에 마우스를 올린 지점(경과 초) */
  hoverT?: number | null
  /** 고른 랩의 [시작, 끝] 경과 초 */
  lapRange?: [number, number] | null
  /** 지도 아래에 붙일 재생 조작줄 */
  children?: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const lineRef = useRef<L.Polyline | null>(null)
  const doneRef = useRef<L.Polyline | null>(null)
  const lapRef = useRef<L.Polyline | null>(null)
  const headRef = useRef<L.CircleMarker | null>(null)
  const hoverRef = useRef<L.CircleMarker | null>(null)
  /** 휠 확대는 기본으로 꺼 둔다 — 페이지를 스크롤하다 지도 위를 지나면 화면이 멋대로 확대된다 */
  const [wheel, setWheel] = useState(false)
  const [style, setStyle] = useState<MapStyle>(() => {
    try {
      return localStorage.getItem(STYLE_KEY) === 'plain' ? 'plain' : 'detail'
    } catch {
      return 'detail'
    }
  })

  /** 경과 초 → 경로 인덱스 */
  const times = useMemo(() => (routeT.length === route.length ? routeT : route.map((_, i) => i)), [routeT, route])
  const at = (t: number) => Math.min(route.length - 1, Math.max(0, indexAtTime(times, t)))

  useEffect(() => {
    const box = boxRef.current
    if (!box || route.length < 2) return

    const map = L.map(box, { zoomControl: true, scrollWheelZoom: false, attributionControl: true })
    mapRef.current = map

    // 밑에 어두운 선을 깔아 밝은 길 위에서도 경로가 보이게 한다
    L.polyline(route, { color: 'var(--bg)', weight: 7, opacity: 0.45, lineJoin: 'round' }).addTo(map)
    const line = L.polyline(route, { color: TRACK, weight: 4, opacity: 0.95, lineJoin: 'round' }).addTo(map)
    lineRef.current = line
    // 지나온 구간 — 재생 중에만 좌표가 채워진다
    doneRef.current = L.polyline([], { color: TRACK, weight: 5, opacity: 1, lineJoin: 'round' }).addTo(map)
    // 고른 랩 구간
    lapRef.current = L.polyline([], { color: 'var(--h-yellow)', weight: 7, opacity: 1, lineJoin: 'round' }).addTo(map)

    L.circleMarker(route[0], { radius: 6, color: 'var(--bg)', weight: 2, fillColor: 'var(--h-green)', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip('출발')
    L.circleMarker(route[route.length - 1], {
      radius: 6,
      color: 'var(--bg)',
      weight: 2,
      fillColor: 'var(--h-red)',
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip('도착')

    // 현재 위치(재생) / 그래프에서 짚은 위치 — 필요할 때만 지도에 올린다
    headRef.current = L.circleMarker(route[0], {
      radius: 7,
      color: 'var(--bg-card)',
      weight: 2.5,
      fillColor: TRACK,
      fillOpacity: 1,
      pane: 'markerPane',
    })
    hoverRef.current = L.circleMarker(route[0], {
      radius: 6,
      color: 'var(--text)',
      weight: 2,
      fillColor: 'var(--bg-card)',
      fillOpacity: 1,
      pane: 'markerPane',
    })

    map.fitBounds(line.getBounds(), { padding: [24, 24] })

    // 카드 폭이 바뀌면(창 크기·사이드바) 지도가 회색으로 잘린 채 남는다
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(box)

    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
      lineRef.current = null
      doneRef.current = null
      lapRef.current = null
      headRef.current = null
      hoverRef.current = null
    }
  }, [route])

  // 타일은 따로 관리한다 — 종류를 바꿔도 경로·확대 상태를 잃지 않게
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const light = isLightTheme()
    const base = style === 'detail' ? OSM : CARTO(light ? 'light_all' : 'dark_all')
    const layer = L.tileLayer(base.url, base.options).addTo(map)
    layer.getContainer()?.classList.add('rm-base')
    // 자세한 지도는 밝은 타일뿐이라, 어두운 테마에서는 살짝 눌러 글자만 남긴다
    if (style === 'detail' && !light) layer.getContainer()?.classList.add('rm-soft')
    return () => {
      map.removeLayer(layer)
    }
  }, [style])

  // 커서/호버/랩이 바뀔 때마다 해당 레이어만 갱신한다 (지도를 다시 만들지 않는다)
  useEffect(() => {
    const map = mapRef.current
    const line = lineRef.current
    const done = doneRef.current
    const head = headRef.current
    if (!map || !line || !done || !head) return

    if (cursor == null) {
      line.setStyle({ color: TRACK, opacity: 0.95 })
      done.setLatLngs([])
      if (map.hasLayer(head)) map.removeLayer(head)
      return
    }
    const i = at(cursor)
    line.setStyle({ color: AHEAD, opacity: 0.75 })
    done.setLatLngs(route.slice(0, i + 1))
    head.setLatLng(route[i])
    if (!map.hasLayer(head)) head.addTo(map)
  }, [cursor, route, times])

  useEffect(() => {
    const map = mapRef.current
    const hover = hoverRef.current
    if (!map || !hover) return
    if (hoverT == null) {
      if (map.hasLayer(hover)) map.removeLayer(hover)
      return
    }
    hover.setLatLng(route[at(hoverT)])
    if (!map.hasLayer(hover)) hover.addTo(map)
  }, [hoverT, route, times])

  useEffect(() => {
    const lap = lapRef.current
    if (!lap) return
    if (!lapRange) {
      lap.setLatLngs([])
      return
    }
    const [a, b] = lapRange
    // 랩이 1초짜리여도 점 하나는 보이게 최소 두 점을 남긴다
    const i = at(a)
    const j = Math.max(i + 1, at(b))
    lap.setLatLngs(route.slice(i, j + 1))
  }, [lapRange, route, times])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (wheel) map.scrollWheelZoom.enable()
    else map.scrollWheelZoom.disable()
  }, [wheel])

  if (route.length < 2) return null

  const fit = () => {
    const map = mapRef.current
    const line = lineRef.current
    if (map && line) map.fitBounds(line.getBounds(), { padding: [24, 24] })
  }
  const pickStyle = (s: MapStyle) => {
    setStyle(s)
    try {
      localStorage.setItem(STYLE_KEY, s)
    } catch {
      /* 저장 실패는 무시 */
    }
  }

  return (
    <div className="card ad-map">
      <div className="ad-map-head">
        <h3 className="card-title">경로</h3>
        <div className="ad-map-actions">
          <button
            type="button"
            className={`tf-btn ${style === 'detail' ? 'active' : ''}`}
            onClick={() => pickStyle('detail')}
            title="길·건물·지명까지 보이는 지도"
          >
            자세히
          </button>
          <button
            type="button"
            className={`tf-btn ${style === 'plain' ? 'active' : ''}`}
            onClick={() => pickStyle('plain')}
            title="경로만 보이는 단순한 지도"
          >
            단순
          </button>
          <button type="button" className="link-btn small" onClick={fit}>
            전체 보기
          </button>
          <button
            type="button"
            className={`tf-btn ${wheel ? 'active' : ''}`}
            onClick={() => setWheel((v) => !v)}
            title="켜면 마우스 휠로 지도를 확대/축소합니다 (끄면 페이지가 스크롤됩니다)"
          >
            휠 확대 {wheel ? '켬' : '끔'}
          </button>
        </div>
      </div>
      <div className="ad-map-box" ref={boxRef} />
      {children}
      <p className="muted small">GPS 기록 {route.length}점 · 지도 데이터 © OpenStreetMap 기여자</p>
    </div>
  )
}
