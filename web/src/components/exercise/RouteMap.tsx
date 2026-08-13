import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Route } from '../../lib/activityDetail'

// 활동 경로 지도 — intervals.icu 의 latlng 스트림을 그대로 선으로 그린다.
//
// 타일은 CARTO 다크(OpenStreetMap 데이터)를 쓴다. 앱이 어두운 화면이라
// 기본 OSM 타일은 혼자 하얗게 튄다. CARTO 가 막히면 기본 OSM 으로 되돌린다.
//
// 마커는 L.marker 가 아니라 circleMarker 다 — L.marker 는 아이콘 PNG 를 따로 요구해서
// 번들러마다 경로가 깨진다. 원 마커는 SVG 라 그런 문제가 없다.

const DARK = {
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  options: { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap · © CARTO' },
}
const PLAIN = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: { maxZoom: 19, attribution: '© OpenStreetMap' },
}

export function RouteMap({ route }: { route: Route }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const lineRef = useRef<L.Polyline | null>(null)
  /** 휠 확대는 기본으로 꺼 둔다 — 페이지를 스크롤하다 지도 위를 지나면 화면이 멋대로 확대된다 */
  const [wheel, setWheel] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    if (!box || route.length < 2) return

    const map = L.map(box, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true,
    })
    mapRef.current = map

    let tileOk = false
    let tileFails = 0
    const tiles = L.tileLayer(DARK.url, DARK.options).addTo(map)
    tiles.on('tileload', () => {
      tileOk = true
    })
    tiles.on('tileerror', () => {
      // 한 장도 못 받았는데 계속 실패하면 타일 서버 쪽 문제로 보고 기본 OSM 으로 갈아탄다
      if (tileOk || ++tileFails < 4) return
      tileFails = -999
      map.removeLayer(tiles)
      L.tileLayer(PLAIN.url, PLAIN.options).addTo(map).getContainer()?.classList.add('rm-dim')
    })

    // 밑에 어두운 선을 깔아 밝은 길 위에서도 경로가 보이게 한다
    L.polyline(route, { color: '#0b0d12', weight: 7, opacity: 0.5, lineJoin: 'round' }).addTo(map)
    const line = L.polyline(route, { color: '#ff6b35', weight: 4, opacity: 0.95, lineJoin: 'round' }).addTo(map)
    lineRef.current = line

    L.circleMarker(route[0], { radius: 6, color: '#0b0d12', weight: 2, fillColor: '#3fb950', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip('출발')
    L.circleMarker(route[route.length - 1], {
      radius: 6,
      color: '#0b0d12',
      weight: 2,
      fillColor: '#f85149',
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip('도착')

    map.fitBounds(line.getBounds(), { padding: [24, 24] })

    // 카드 폭이 바뀌면(창 크기·사이드바) 지도가 회색으로 잘린 채 남는다
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(box)

    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
      lineRef.current = null
    }
  }, [route])

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
      <p className="muted small">GPS 기록 {route.length}점 · 지도 데이터 © OpenStreetMap 기여자</p>
    </div>
  )
}
