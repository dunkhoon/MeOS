import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { Shortcuts } from './Shortcuts'
import { QuickSearch } from './QuickSearch'
import { NAV } from '../lib/nav'
import { isDesktop } from '../lib/desktop'

export function AppShell({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const desktop = isDesktop()

  return (
    <div className="shell">
      <Shortcuts />
      <aside className="sidebar">
        <div className="logo">
          MeOS <span className="muted small">Personal OS</span>
        </div>
        <nav>
          {/* PC 전용 화면은 브라우저·모바일에서 목록에 올리지 않는다 (App.tsx 가 경로도 안 만든다) */}
          {NAV.filter((n) => !n.desktopOnly || desktop).map((n) => (
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
