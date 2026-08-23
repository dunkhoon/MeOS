import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  fetchTrashedRoutines,
  fetchTrashedWorkItems,
  purgeRoutine,
  purgeWorkItem,
  restoreRoutine,
  restoreWorkItem,
} from '../lib/work'
import { loadShortcutTrash, purgeShortcut, restoreShortcut } from '../lib/shortcuts'
import { isDesktop } from '../lib/desktop'

// 삭제한 항목 모아보기 — 할 일 · 진행 중인 업무 · 루틴(클라우드) + 바로가기 · 스니펫(PC 로컬).
// 어느 쪽이든 복원하거나 완전히 지울 수 있다.

type Kind = '진행 중인 업무' | '할 일' | '루틴' | '바로가기' | '스니펫'

interface Entry {
  key: string
  kind: Kind
  label: string
  sub: string | null
  deletedAt: string | null
  restore: () => Promise<void>
  purge: () => Promise<void>
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function Trash() {
  const desktop = isDesktop()
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Kind | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const out: Entry[] = []
    try {
      const [work, routines] = await Promise.all([fetchTrashedWorkItems(), fetchTrashedRoutines()])

      for (const w of work) {
        out.push({
          key: `work:${w.id}`,
          kind: w.list === 'todo' ? '할 일' : '진행 중인 업무',
          label: w.title,
          sub: w.origin === 'bts' && w.btsIssueId ? `${w.btsSystem === 'jira' ? 'JIRA' : 'Redmine'} ${w.btsIssueId}` : null,
          deletedAt: w.deletedAt,
          restore: () => restoreWorkItem(w.id),
          purge: () => purgeWorkItem(w.id),
        })
      }
      for (const r of routines) {
        out.push({
          key: `routine:${r.id}`,
          kind: '루틴',
          label: r.title,
          sub: null,
          deletedAt: r.deletedAt,
          restore: () => restoreRoutine(r.id),
          purge: () => purgeRoutine(r.id),
        })
      }
      setErr(null)
    } catch (e) {
      setErr(errMsg(e))
    }

    // PC 로컬 항목 (모바일/브라우저에는 존재하지 않음)
    if (desktop) {
      for (const s of loadShortcutTrash()) {
        out.push({
          key: `shortcut:${s.id}`,
          kind: '바로가기',
          label: s.name,
          sub: s.target,
          deletedAt: s.deletedAt ?? null,
          restore: async () => restoreShortcut(s.id),
          purge: async () => purgeShortcut(s.id),
        })
      }
      try {
        for (const s of await (window.desktop?.snippets.trashList() ?? Promise.resolve([]))) {
          out.push({
            key: `snippet:${s.id}`,
            kind: '스니펫',
            label: s.title,
            sub: null,
            deletedAt: s.deletedAt,
            restore: async () => {
              await window.desktop?.snippets.restore(s.id)
            },
            purge: async () => {
              await window.desktop?.snippets.purge(s.id)
            },
          })
        }
      } catch {
        /* 스니펫 휴지통을 못 읽어도 나머지는 보여준다 */
      }
    }

    out.sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')))
    setEntries(out)
    setLoading(false)
  }, [desktop])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => {
    const m = new Map<Kind, number>()
    for (const e of entries) m.set(e.kind, (m.get(e.kind) ?? 0) + 1)
    return m
  }, [entries])

  const shown = filter ? entries.filter((e) => e.kind === filter) : entries

  const act = async (e: Entry, fn: () => Promise<void>) => {
    try {
      await fn()
      setEntries((prev) => prev.filter((x) => x.key !== e.key))
      setConfirmKey(null)
    } catch (e2) {
      setErr(errMsg(e2))
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>휴지통</h2>
        <p className="muted">삭제한 할 일 · 진행 중인 업무 · 루틴 · 바로가기 · 스니펫을 되돌릴 수 있어요.</p>
      </header>

      {err && <div className="sync-msg err">{err}</div>}

      <div className="card">
        <div className="trash-filters">
          <button type="button" className={`vf-btn ${filter === null ? 'active' : ''}`} onClick={() => setFilter(null)}>
            전체 <span className="muted">{entries.length}</span>
          </button>
          {([...counts.keys()] as Kind[]).map((k) => (
            <button key={k} type="button" className={`vf-btn ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>
              {k} <span className="muted">{counts.get(k)}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <p className="muted small">불러오는 중…</p>
        ) : shown.length === 0 ? (
          <p className="muted small">휴지통이 비어 있어요.</p>
        ) : (
          <div className="trash-list">
            {shown.map((e) => (
              <div key={e.key} className="trash-row">
                <span className="chip kind">{e.kind}</span>
                <span className="trash-label">
                  {e.label}
                  {e.sub && <span className="muted small trash-sub">{e.sub}</span>}
                </span>
                <span className="muted small trash-date">
                  {e.deletedAt ? dayjs(e.deletedAt).format('YYYY-MM-DD HH:mm') : ''}
                </span>
                <button type="button" className="ghost-btn small-btn" onClick={() => void act(e, e.restore)}>
                  복원
                </button>
                {confirmKey === e.key ? (
                  <>
                    <button type="button" className="link-btn danger" onClick={() => void act(e, e.purge)}>
                      완전 삭제
                    </button>
                    <button type="button" className="link-btn" onClick={() => setConfirmKey(null)}>
                      취소
                    </button>
                  </>
                ) : (
                  <button type="button" className="link-btn danger" onClick={() => setConfirmKey(e.key)}>
                    영구 삭제
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
