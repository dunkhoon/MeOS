import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { Shortcuts } from './Shortcuts'
import { QuickSearch } from './QuickSearch'

interface NavEntry {
  to: string
  label: string
  icon: string
  end?: boolean
  desktopOnly?: boolean
}

const NAV: NavEntry[] = [
  { to: '/', label: '대시보드', icon: '▦', end: true },
  { to: '/calendar', label: '캘린더', icon: '▤' },
  { to: '/tasks', label: '업무', icon: '✔' }, // BTS 목록만 PC 전용 — 나머지는 모바일에서도 보인다
  { to: '/perforce', label: 'Perforce', icon: '⑂', desktopOnly: true },
  { to: '/exercise', label: '운동', icon: '◠' },
  { to: '/report', label: '리포트', icon: '▧' },
  { to: '/trash', label: '휴지통', icon: '🗑' },
  { to: '/settings', label: '설정', icon: '⚙' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { session } = useAuth()

  return (
    <div className="shell">
      <Shortcuts />
      <aside className="sidebar">
        <div className="logo">
          MeOS <span className="muted small">Personal OS</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="nav-item">
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
              {n.desktopOnly && <span className="tag">PC</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="muted small">{session?.user.email}</div>
          <button className="link-btn" onClick={() => void supabase.auth.signOut()}>
            로그아웃
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
      <QuickSearch />
    </div>
  )
}
