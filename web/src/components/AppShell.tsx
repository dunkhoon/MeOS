import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { Shortcuts } from './Shortcuts'
import { QuickSearch } from './QuickSearch'
import { NAV } from '../lib/nav'

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
