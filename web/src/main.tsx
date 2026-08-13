import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthProvider'
import { applyTheme, getTheme } from './lib/theme'
import './index.css'

// index.html 이 화면 번쩍임을 막으려고 이미 한 번 입혔다. 여기서는 목록을 아는 상태로
// 다시 한 번 — color-scheme·주소창 색까지 정확히 맞춘다.
applyTheme(getTheme())

// 서비스워커는 **모바일 홈 화면 설치용**이다. 데스크톱 앱에서는 등록하지 않는다 —
// 셸이 배포된 주소를 불러오는 구조라 오프라인 캐시는 이득이 없고, 재배포해도 낡은 화면을
// 계속 붙잡는 부작용만 생긴다 (재시작해도 서비스워커는 살아남는다).
if (!window.desktop?.isDesktop) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }))
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>,
)
