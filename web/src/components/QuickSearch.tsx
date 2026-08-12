import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { runIntervalsSync } from '../lib/sync'
import { NAV, rankMatch } from '../lib/nav'

// Quick Search 오버레이 — 전역 단축키/트레이로 열림. 페이지·명령·바로가기·스니펫 검색.
interface Item {
  id: string
  label: string
  icon: string
  hint: string
  /** 라벨과 표기가 다른 검색어 (Perforce ↔ 퍼포스 등) */
  keywords?: string[]
  run: () => void | string | Promise<void | string>
}

export function QuickSearch() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [snips, setSnips] = useState<{ id: string; title: string }[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.desktop?.onOpenQuickSearch(() => {
      setQ('')
      setSel(0)
      setToast(null)
      setOpen(true)
      window.desktop?.snippets.list().then(setSnips).catch(() => setSnips([]))
    })
  }, [])

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 20)
  }, [open])

  const items = useMemo<Item[]>(() => {
    // 사이드바와 같은 목록에서 만든다 — 화면을 추가하면 검색에도 자동으로 나온다
    const pages: Item[] = NAV.filter((n) => !n.desktopOnly || !!window.desktop?.isDesktop).map((n) => ({
      id: 'p-' + n.to,
      label: n.label,
      icon: n.icon,
      hint: '페이지',
      keywords: n.keywords,
      run: () => navigate(n.to),
    }))
    const cmds: Item[] = [
      {
        id: 'c-sync',
        label: '운동 동기화 (intervals.icu)',
        icon: '↻',
        hint: '명령',
        keywords: ['sync', '동기화', '새로고침'],
        run: async () => {
          setToast('동기화 중…')
          try {
            const r = await runIntervalsSync()
            return `동기화 완료 · 활동 ${r.activities}`
          } catch (e) {
            return e instanceof Error ? e.message : '동기화 실패'
          }
        },
      },
      {
        id: 'c-logout',
        label: '로그아웃',
        icon: '⏻',
        hint: '명령',
        keywords: ['logout', 'signout', '나가기'],
        run: () => void supabase.auth.signOut(),
      },
    ]
    let shortcuts: Item[] = []
    try {
      const list = JSON.parse(localStorage.getItem('pp:shortcuts') || '[]') as {
        id: string
        name: string
        target: string
        emoji: string | null
      }[]
      shortcuts = list.map((s) => ({
        id: 's-' + s.id,
        label: s.name,
        icon: s.emoji || '🔗',
        hint: '바로가기',
        run: () => void window.desktop?.openShortcut(s.target),
      }))
    } catch {
      /* ignore */
    }
    const snippets: Item[] = snips.map((s) => ({
      id: 'n-' + s.id,
      label: s.title,
      icon: '📋',
      hint: '스니펫 복사',
      run: async () => {
        const r = await window.desktop?.snippets.copy(s.id)
        return r?.ok ? `복사됨: ${s.title}` : '복사 실패'
      },
    }))
    return [...pages, ...cmds, ...shortcuts, ...snippets]
  }, [snips, navigate])

  const filtered = useMemo(() => {
    const query = q.trim()
    if (!query) return items
    return items
      .map((it) => ({ it, r: rankMatch(query, it.label, it.keywords) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.it)
  }, [q, items])

  useEffect(() => {
    setSel(0)
  }, [q])

  if (!open) return null

  const close = () => setOpen(false)
  const exec = async (it?: Item) => {
    const target = it ?? filtered[sel]
    if (!target) return
    const res = await target.run()
    if (typeof res === 'string') {
      setToast(res)
      window.setTimeout(close, 1100)
    } else {
      close()
    }
  }

  return (
    <div className="qs-overlay" onClick={close}>
      <div className="qs" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qs-input"
          placeholder="검색 — 페이지 · 명령 · 바로가기 · 스니펫"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void exec()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <div className="qs-list">
          {filtered.length === 0 && <div className="qs-empty">결과 없음</div>}
          {filtered.map((it, i) => (
            <button
              key={it.id}
              className={`qs-item ${i === sel ? 'active' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={() => void exec(it)}
            >
              <span className="qs-icon">{it.icon}</span>
              <span className="qs-label">{it.label}</span>
              <span className="qs-hint">{it.hint}</span>
            </button>
          ))}
        </div>
        {toast && <div className="qs-toast">{toast}</div>}
      </div>
    </div>
  )
}
