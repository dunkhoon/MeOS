import { useEffect, useMemo, useState } from 'react'
import { alpha } from '../lib/color'
import dayjs from 'dayjs'
import { fetchEvents, type CalEvent } from '../lib/calendar'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function fmtTime(e: CalEvent): string {
  return e.all_day ? '종일' : dayjs(e.start_at).format('HH:mm')
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .trim()
}

export default function Calendar() {
  const [month, setMonth] = useState(() => dayjs().startOf('month'))
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CalEvent | null>(null)
  const [dayModal, setDayModal] = useState<string | null>(null)

  useEffect(() => {
    const from = month.startOf('month').startOf('week').toISOString()
    const to = month.endOf('month').endOf('week').add(1, 'day').toISOString()
    setLoading(true)
    setError(null)
    fetchEvents(from, to)
      // 근무 위치 이벤트는 표시하지 않음
      .then((rows) => setEvents(rows.filter((e) => e.raw?.eventType !== 'workingLocation')))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : JSON.stringify(e)))
      .finally(() => setLoading(false))
  }, [month])

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const e of events) {
      const key = dayjs(e.start_at).format('YYYY-MM-DD')
      const arr = m.get(key) ?? []
      arr.push(e)
      m.set(key, arr)
    }
    return m
  }, [events])

  const today = dayjs()
  const gridStart = month.startOf('month').startOf('week')
  const days = Array.from({ length: 42 }, (_, i) => gridStart.add(i, 'day'))

  const agenda = useMemo(() => {
    const start = today.startOf('day')
    return events.filter((e) => !dayjs(e.start_at).isBefore(start)).slice(0, 40)
  }, [events, today])

  return (
    <div className="page">
      <header className="page-head cal-head">
        <div>
          <h2>캘린더</h2>
          <p className="muted">Google Calendar · 모든 캘린더 (조회)</p>
        </div>
        <div className="cal-nav">
          <button className="ghost-btn" onClick={() => setMonth((m) => m.subtract(1, 'month'))}>
            ‹
          </button>
          <span className="cal-month">{month.format('YYYY.MM')}</span>
          <button className="ghost-btn" onClick={() => setMonth((m) => m.add(1, 'month'))}>
            ›
          </button>
          <button className="ghost-btn" onClick={() => setMonth(dayjs().startOf('month'))}>
            오늘
          </button>
        </div>
      </header>

      {error && <div className="sync-msg err">불러오기 실패: {error}</div>}
      {loading && <p className="muted small">불러오는 중…</p>}

      <div className="cal-grid card">
        <div className="cal-weekdays">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`cal-wd ${i === 0 ? 'sun' : ''} ${i === 6 ? 'sat' : ''}`}>
              {w}
            </div>
          ))}
        </div>
        <div className="cal-days">
          {days.map((d) => {
            const key = d.format('YYYY-MM-DD')
            const dayEvents = byDay.get(key) ?? []
            const inMonth = d.month() === month.month()
            const isToday = d.isSame(today, 'day')
            const dow = d.day()
            return (
              <div key={key} className={`cal-cell ${inMonth ? '' : 'dim'} ${isToday ? 'today' : ''}`}>
                <div
                  className={`cal-daynum ${dow === 0 ? 'sun' : ''} ${dow === 6 ? 'sat' : ''}`}
                  onClick={() => setDayModal(key)}
                >
                  {d.date()}
                </div>
                <div className="cal-evs">
                  {dayEvents.slice(0, 3).map((e) => (
                    <div
                      key={e.id}
                      className="cal-ev"
                      style={{ background: alpha(e.color ?? 'var(--accent)', 20), color: e.color ?? 'var(--accent)' }}
                      title={`${fmtTime(e)} ${e.title}`}
                      onClick={() => setSelected(e)}
                    >
                      {!e.all_day && <span className="cal-ev-t">{dayjs(e.start_at).format('HH:mm')}</span>} {e.title}
                    </div>
                  ))}
                  {dayEvents.length > 3 && (
                    <div className="cal-more" onClick={() => setDayModal(key)}>
                      +{dayEvents.length - 3}개 더
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card cal-agenda">
        <h3 className="card-title">다가오는 일정</h3>
        {agenda.length === 0 ? (
          <p className="muted small">표시할 일정이 없어요.</p>
        ) : (
          agenda.map((e) => (
            <div key={e.id} className="agenda-row" onClick={() => setSelected(e)}>
              <span className="agenda-dot" style={{ background: e.color ?? 'var(--accent)' }} />
              <span className="agenda-date">{dayjs(e.start_at).format('M/D (ddd)')}</span>
              <span className="agenda-time">{fmtTime(e)}</span>
              <span className="agenda-title">{e.title}</span>
              {e.location && <span className="agenda-loc">{e.location}</span>}
            </div>
          ))
        )}
      </div>

      {dayModal && (
        <DayModal
          day={dayModal}
          events={byDay.get(dayModal) ?? []}
          onPick={(e) => {
            setDayModal(null)
            setSelected(e)
          }}
          onClose={() => setDayModal(null)}
        />
      )}

      {selected && <EventModal event={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function DayModal({
  day,
  events,
  onPick,
  onClose,
}: {
  day: string
  events: CalEvent[]
  onPick: (e: CalEvent) => void
  onClose: () => void
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{dayjs(day).format('YYYY.MM.DD (ddd)')}</h3>
        <div className="day-ev-list">
          {events.length === 0 && <p className="muted small">일정 없음</p>}
          {events.map((e) => (
            <button key={e.id} className="day-ev" onClick={() => onPick(e)}>
              <span className="agenda-dot" style={{ background: e.color ?? 'var(--accent)' }} />
              <span className="agenda-time">{fmtTime(e)}</span>
              <span className="agenda-title">{e.title}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}

function EventModal({ event, onClose }: { event: CalEvent; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const start = dayjs(event.start_at)
  const rawEnd = event.end_at ? dayjs(event.end_at) : null
  let when: string
  if (event.all_day) {
    const endEx = rawEnd ? rawEnd.subtract(1, 'day') : start
    when = endEx.isAfter(start, 'day')
      ? `${start.format('YYYY.MM.DD (ddd)')} ~ ${endEx.format('YYYY.MM.DD (ddd)')} · 종일`
      : `${start.format('YYYY.MM.DD (ddd)')} · 종일`
  } else if (rawEnd) {
    when = rawEnd.isSame(start, 'day')
      ? `${start.format('YYYY.MM.DD (ddd) HH:mm')} ~ ${rawEnd.format('HH:mm')}`
      : `${start.format('YYYY.MM.DD HH:mm')} ~ ${rawEnd.format('YYYY.MM.DD HH:mm')}`
  } else {
    when = start.format('YYYY.MM.DD (ddd) HH:mm')
  }

  const desc = event.raw?.description ? stripHtml(event.raw.description) : ''
  const link = event.raw?.htmlLink

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="ev-modal-head">
          <span className="ev-modal-dot" style={{ background: event.color ?? 'var(--accent)' }} />
          <h3>{event.title}</h3>
        </div>
        <div className="ev-modal-when">{when}</div>
        {event.location && (
          <div className="ev-modal-row">
            <b>위치</b> {event.location}
          </div>
        )}
        {desc && <div className="ev-modal-desc">{desc}</div>}
        <div className="modal-actions">
          {link && (
            <a className="ext-link" href={link} target="_blank" rel="noreferrer" style={{ marginRight: 'auto' }}>
              구글 캘린더에서 열기 ↗
            </a>
          )}
          <button onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}
