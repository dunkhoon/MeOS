import { clock } from '../../lib/activityDetail'

// 훈련 재생 조작줄 — 지도 카드 안, 지도 바로 아래에 붙는다 (reference/1786515837.gif).
// 상태는 훈련 상세(ActivityDetail)가 들고 있다. 지도·그래프·랩이 같은 커서를 보기 때문.

const SPEEDS = [1, 2, 4] as const
export type Speed = (typeof SPEEDS)[number]

export interface Readout {
  /** 지금까지 달린 거리(m). 스트림이 없으면 null */
  distanceM: number | null
  totalM: number | null
  pace: string
  hr: number | null
  cadence: number | null
  lapNow: number
  lapTotal: number
}

export function PlaybackBar({
  playing,
  cursor,
  total,
  speed,
  readout,
  onToggle,
  onStop,
  onSeek,
  onSpeed,
}: {
  playing: boolean
  /** 경과 초. null 이면 재생 전 */
  cursor: number | null
  total: number
  speed: Speed
  readout: Readout | null
  onToggle: () => void
  onStop: () => void
  onSeek: (t: number) => void
  onSpeed: (s: Speed) => void
}) {
  const t = cursor ?? 0
  const active = cursor != null
  const km = (m: number | null) => (m == null ? null : (m / 1000).toFixed(2))

  return (
    <div className="pb">
      <div className="pb-row">
        <button type="button" className={`pb-play ${playing ? 'on' : ''}`} onClick={onToggle}>
          {playing ? '❚❚ 일시중지' : '▶ 재생'}
        </button>
        <button type="button" className="link-btn small" onClick={onStop} disabled={!active}>
          ■ 정지
        </button>

        <input
          className="pb-seek"
          type="range"
          min={0}
          max={Math.max(1, Math.round(total))}
          step={1}
          value={Math.round(t)}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="재생 위치"
        />

        <span className="pb-time">
          {clock(t)} <span className="muted">/ {clock(total)}</span>
        </span>

        <span className="pb-speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`tf-btn ${speed === s ? 'active' : ''}`}
              onClick={() => onSpeed(s)}
              title={`전체를 약 ${Math.round(30 / s)}초에 재생`}
            >
              {s}×
            </button>
          ))}
        </span>
      </div>

      {active && readout && (
        <div className="pb-readout">
          <b>{km(readout.distanceM) ?? '-'}</b>
          <span className="muted"> / {km(readout.totalM) ?? '-'} km</span>
          <Sep />
          {readout.pace} <span className="muted">/km</span>
          {readout.hr != null && (
            <>
              <Sep />
              <span style={{ color: '#3b82f6' }}>{Math.round(readout.hr)}</span> <span className="muted">bpm</span>
            </>
          )}
          {readout.cadence != null && (
            <>
              <Sep />
              {Math.round(readout.cadence * 2)} <span className="muted">spm</span>
            </>
          )}
          {readout.lapTotal > 0 && (
            <>
              <Sep />
              <span className="muted">랩</span> {readout.lapNow}/{readout.lapTotal}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const Sep = () => <span className="pb-sep">·</span>
