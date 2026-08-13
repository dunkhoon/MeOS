import { useEffect, useRef, useState, type ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { indexAtTime } from '../../lib/playback'
import { isLightTheme } from '../../lib/theme'
import type { Route } from '../../lib/activityDetail'

// 활동 경로 지도 — intervals.icu 의 latlng 스트림을 그대로 선으로 그린다.
//
// 타일은 CARTO 다크(OpenStreetMap 데이터)를 쓴다. 앱이 어두운 화면이라
// 기본 OSM 타일은 혼자 하얗게 튄다. CARTO 가 막히면 기본 OSM 으로 되돌린다.
//
// 마커는 L.marker 가 아니라 circleMarker 다 — L.marker 는 아이콘 PNG 를 따로 요구해서
// 번들러마다 경로가 깨진다. 원 마커는 SVG 라 그런 문제가 없다.
//
// `cursor`(경과 시간, 초)가 들어오면 재생 모드가 된다: 지나온 구간만 색이 살고
// 현재 위치에 점이 붙는다. null 이면 평소처럼 전체 경로.

const CARTO = (variant: 'dark_all' | 'light_all') => ({
  url: `https://{s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}{r}.png`,
  options: { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap · © CARTO' },
})
const PLAIN = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: { maxZoom: 19, attribution: '© OpenStreetMap' },
}

const TRACK = 'var(--accent)'
/** 재생 중 아직 안 지난 구간 — 있는 건 보이되 눈에 덜 띄게 */
const AHEAD = 'var(--muted)'

export function RouteMap({
  route,
  routeT,
  cursor,
  children,
}: {
  route: Route
  routeT: number[]
  /** 재생 커서(경과 초). null 이면 재생 아님 */
  cursor: number | null
  /** 지도 아래에 붙일 재생 조작줄 */
  children?: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const lineRef = useRef<L.Polyline | null>(null)
  const doneRef = useRef<L.Polyline | null>(null)
  const headRef = useRef<L.CircleMarker | null>(null)
  /** 휠 확대는 기본으로 꺼 둔다 — 페이지를 스크롤하다 지도 위를 지나면 화면이 멋대로 확대된다 */
  const [wheel, setWheel] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    if (!box || route.length < 2) return

    const map = L.map(box, { zoomControl: true, scrollWheelZoom: false, attributionControl: true })
    mapRef.current = map

    // 밝은 테마에서 지도만 캄캄하면 거기만 구멍처럼 보인다 — 타일도 테마를 따라간다
    const light = isLightTheme()
    const base = CARTO(light ? 'light_all' : 'dark_all')
    let tileOk = false
    let tileFails = 0
    const tiles = L.tileLayer(base.url, base.options).addTo(map)
    tiles.on('tileload', () => {
      tileOk = true
    })
    tiles.on('tileerror', () => {
      // 한 장도 못 받았는데 계속 실패하면 타일 서버 쪽 문제로 보고 기본 OSM 으로 갈아탄다
      if (tileOk || ++tileFails < 4) return
      tileFails = -999
      map.removeLayer(tiles)
      const fallback = L.tileLayer(PLAIN.url, PLAIN.options).addTo(map)
      // 기본 OSM 은 밝은 타일이라 어두운 테마에서만 눌러 준다
      if (!light) fallback.getContainer()?.classList.add('rm-dim')
    })

    // 밑에 어두운 선을 깔아 밝은 길 위에서도 경로가 보이게 한다
    L.polyline(route, { color: 'var(--bg)', weight: 7, opacity: 0.5, lineJoin: 'round' }).addTo(map)
    const line = L.polyline(route, { color: TRACK, weight: 4, opacity: 0.95, lineJoin: 'round' }).addTo(map)
    lineRef.current = line
    // 지나온 구간 — 재생 중에만 좌표가 채워진다
    doneRef.current = L.polyline([], { color: TRACK, weight: 5, opacity: 1, lineJoin: 'round' }).addTo(map)

    L.circleMarker(route[0], { radius: 6, color: 'var(--bg)', weight: 2, fillColor: 'var(--ok)', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip('출발')
    L.circleMarker(route[route.length - 1], {
      radius: 6,
      color: 'var(--bg)',
      weight: 2,
      fillColor: 'var(--danger)',
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip('도착')

    // 현재 위치 — 재생 중에만 보인다
    headRef.current = L.circleMarker(route[0], {
      radius: 7,
      color: 'var(--bg-card)',
      weight: 2.5,
      fillColor: TRACK,
      fillOpacity: 1,
      // 지나온 선 위에 오도록
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
      headRef.current = null
    }
  }, [route])

  // 커서가 움직일 때마다 지나온 구간·현재 위치만 갱신한다 (지도를 다시 만들지 않는다)
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
    const i = Math.max(0, indexAtTime(routeT.length ? routeT : route.map((_, n) => n), cursor))
    line.setStyle({ color: AHEAD, opacity: 0.75 })
    done.setLatLngs(route.slice(0, i + 1))
    head.setLatLng(route[i])
    if (!map.hasLayer(head)) head.addTo(map)
  }, [cursor, route, routeT])

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

  return (
    <div className="card ad-map">
      <div className="ad-map-head">
        <h3 className="card-title">경로</h3>
        <div className="ad-map-actions">
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
