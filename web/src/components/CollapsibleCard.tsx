import { useState, type ReactNode } from 'react'

// 타이틀을 누르면 접히는 카드. 접힘 상태는 localStorage에 id별로 기억한다.
export function CollapsibleCard({
  id,
  title,
  actions,
  children,
}: {
  id: string
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const key = `pp:collapse:${id}`
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        /* localStorage 불가 시 무시 */
      }
      return next
    })
  }

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-head">
        <button type="button" className="card-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <span className={`caret ${collapsed ? 'collapsed' : ''}`}>▾</span>
          <span className="card-title">{title}</span>
        </button>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      {!collapsed && <div className="card-body">{children}</div>}
    </div>
  )
}
