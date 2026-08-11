import { useEffect, useState } from 'react'

// 커스텀 타이틀바 (Electron 전용). 파비콘+앱이름 + 창 컨트롤(최소화/최대화/완전종료/트레이).
export function TitleBar() {
  const d = window.desktop
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    d?.win.onMaximizeChange((v) => setMaximized(v))
  }, [d])

  if (!d?.isDesktop) return null
  const win = d.win

  return (
    <div className="titlebar">
      <div className="tb-left">
        <span className="tb-logo" />
        <span className="tb-title">MeOS</span>
      </div>
      <div className="tb-controls">
        <button className="tb-btn" title="최소화" onClick={() => win.minimize()}>
          <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <line x1="4" y1="12" x2="20" y2="12" />
          </svg>
        </button>
        <button className="tb-btn" title={maximized ? '이전 크기로' : '최대화'} onClick={() => win.toggleMaximize()}>
          {maximized ? '❐' : '▢'}
        </button>
        <button className="tb-btn tb-power" title="완전 종료" onClick={() => win.quit()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="12" y1="3" x2="12" y2="12" />
            <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
          </svg>
        </button>
        <button className="tb-btn tb-close" title="트레이로 최소화" onClick={() => win.closeToTray()}>
          <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        </button>
      </div>
    </div>
  )
}
