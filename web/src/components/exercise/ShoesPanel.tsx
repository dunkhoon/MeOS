import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { fetchShoeActivities, fetchShoes, isRetired, shoeLabel, type Shoe } from '../../lib/shoes'
import { km, paceStr, typeColor, type Activity } from '../../lib/exercise'
import { alpha } from '../../lib/color'

// 러닝화 — Garmin 장비 정보 (reference/shoes.png 참고).
// 목록에서 누르면 그 신발로 뛴 활동을 보여준다.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 신발 아이콘 — Garmin 에 사진이 없어서(전부 null) 자리표시로 쓴다. */
const ShoeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 16h20a1 1 0 0 0 1-1v-1.2a2 2 0 0 0-1.3-1.9l-5.4-2a3 3 0 0 1-1.2-.8l-2.3-2.5a1 1 0 0 0-1.5 0L9 9" />
    <path d="M2 16v2a1 1 0 0 0 1 1h18" />
    <path d="M6 12.5 8 15M9 11l2 2.5" />
  </svg>
)

// 비활성(은퇴) 신발을 볼지. 대개는 안 보고 싶어 하므로 기본은 숨김이고, 선택은 기억한다.
const SHOW_RETIRED_KEY = 'pp:shoes:retired'

export function ShoesPanel() {
  const [shoes, setShoes] = useState<Shoe[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Shoe | null>(null)
  const [showRetired, setShowRetired] = useState(() => {
    try {
      return localStorage.getItem(SHOW_RETIRED_KEY) === '1'
    } catch {
      return false
    }
  })

  const toggleRetired = () =>
    setShowRetired((v) => {
      const next = !v
      try {
        localStorage.setItem(SHOW_RETIRED_KEY, next ? '1' : '0')
      } catch {
        /* 저장 실패는 무시 */
      }
      return next
    })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setShoes(await fetchShoes())
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const retiredCount = shoes.filter(isRetired).length
  const visible = showRetired ? shoes : shoes.filter((s) => !isRetired(s))
  // 막대 기준은 보이는 것들 중 최대 — 숨긴 신발 때문에 막대가 짜부라지지 않게
  const max = Math.max(...visible.map((s) => s.totalDistanceM), 1)

  return (
    <CollapsibleCard
      id="ex-shoes"
      title={
        <>
          <span className="sec-dot" /> 러닝화
        </>
      }
      actions={
        <>
          {retiredCount > 0 && (
            <button className="link-btn small" onClick={toggleRetired}>
              {showRetired ? '비활성 숨기기' : `비활성 ${retiredCount} 보기`}
            </button>
          )}
          <span className="muted small">{visible.length ? `${visible.length}켤레` : ''}</span>
        </>
      }
    >
      {loading && <p className="muted small">불러오는 중…</p>}
      {err && <p className="error small">{err}</p>}
      {!loading && !err && !shoes.length && (
        <div className="muted small gear-empty">
          러닝화 정보가 없습니다.
          <br />
          Garmin Connect 에 장비를 등록한 뒤 <b>새로고침</b>을 누르세요.
        </div>
      )}
      {!loading && !err && shoes.length > 0 && visible.length === 0 && (
        <p className="muted small">쓰는 러닝화가 없습니다 (전부 비활성).</p>
      )}
      {visible.length > 0 && (<><div className="shoe-list">
        {visible.map((s) => {
          const retired = isRetired(s)
          // 막대는 교체 목표가 있으면 그 대비, 없으면 가장 많이 뛴 신발 대비
          const denom = s.maxMeters ?? max
          const pct = Math.min(100, (s.totalDistanceM / denom) * 100)
          const worn = s.maxMeters ? s.totalDistanceM / s.maxMeters : 0
          return (
            <button key={s.uuid} type="button" className={`shoe-row ${retired ? 'retired' : ''}`} onClick={() => setOpen(s)}>
              <span className="shoe-thumb">
                <ShoeIcon />
              </span>
              <span className="shoe-main">
                <span className="shoe-name">
                  {shoeLabel(s)}
                  {s.name && s.model && <span className="muted shoe-model">{s.model}</span>}
                  {retired && <span className="chip">은퇴</span>}
                </span>
                <span className="shoe-bar">
                  <i
                    style={{
                      width: `${pct}%`,
                      // 교체 시점이 가까우면 색으로 알린다
                      background: worn >= 1 ? 'var(--danger)' : worn >= 0.8 ? 'var(--warn)' : 'var(--accent)',
                    }}
                  />
                </span>
              </span>
              <span className="shoe-km">
                <b>{km(s.totalDistanceM).toFixed(1)}</b> km
                <span className="muted small">{s.totalActivities}회</span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="muted small shoe-note">
        Garmin Connect 장비 정보 · 누적 거리는 Garmin 기준입니다
        {!showRetired && retiredCount > 0 && ` · 비활성 ${retiredCount}켤레 숨김`}
      </p></>)}

      {open && <ShoeModal shoe={open} onClose={() => setOpen(null)} />}
    </CollapsibleCard>
  )
}

// ── 상세 (shoes.png) ────────────────────────────────────────
function ShoeModal({ shoe, onClose }: { shoe: Shoe; onClose: () => void }) {
  const navigate = useNavigate()
  const [acts, setActs] = useState<Activity[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetchShoeActivities(shoe.uuid)
      .then(setActs)
      .catch((e) => setErr(errMsg(e)))
  }, [shoe.uuid])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const days = shoe.dateBegin ? dayjs().diff(dayjs(shoe.dateBegin), 'day') : null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal shoe-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shoe-modal-head">
          <h3>러닝화 — {shoeLabel(shoe)}</h3>
          <button type="button" className="row-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>

        <div className="shoe-hero">
          <span className="shoe-thumb big">
            <ShoeIcon />
          </span>
          <div>
            <div className="shoe-hero-name">{shoeLabel(shoe)}</div>
            {shoe.model && shoe.model !== shoeLabel(shoe) && <div className="muted small">{shoe.model}</div>}
            <div className="shoe-hero-km">
              <b>{km(shoe.totalDistanceM).toFixed(1)}</b> <span className="muted">km 누적 · {shoe.totalActivities}회</span>
            </div>
            <div className="muted small">
              {shoe.dateBegin ? `사용 시작 ${shoe.dateBegin}` : '사용 시작일 없음'}
              {days != null && ` · ${days}일째`}
              {shoe.maxMeters && ` · 교체 목표 ${km(shoe.maxMeters).toFixed(0)}km`}
            </div>
          </div>
        </div>

        <div className="shoe-acts-head">
          이 러닝화로 뛴 활동 {acts ? acts.length : ''}
          {acts && acts.length < shoe.totalActivities && (
            <span className="muted small"> · Garmin 기준 {shoe.totalActivities}회 (MeOS 동기화 범위 밖은 제외)</span>
          )}
        </div>

        {err && <p className="error small">{err}</p>}
        {!acts && !err && <p className="muted small">불러오는 중…</p>}
        {acts && acts.length === 0 && <p className="muted small">MeOS 에 동기화된 활동 중에는 없습니다.</p>}

        {acts && acts.length > 0 && (
          <div className="shoe-acts">
            {acts.map((a) => (
              <button
                key={a.id}
                type="button"
                className="shoe-act"
                onClick={() => {
                  onClose()
                  navigate(`/activity/${a.external_id}`)
                }}
                title="훈련 상세 보기"
              >
                <span className="shoe-act-date">{dayjs(a.start_date_local ?? undefined).format('YYYY-MM-DD')}</span>
                <span className="pill" style={{ background: alpha(typeColor(a.type), 20), color: typeColor(a.type) }}>
                  {a.type ?? '-'}
                </span>
                <span className="shoe-act-name">{a.name || '(제목 없음)'}</span>
                <span className="muted small shoe-act-pace">{paceStr(a.distance_m, a.moving_time_s)}</span>
                <span className="shoe-act-km">{km(a.distance_m).toFixed(1)} km</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
