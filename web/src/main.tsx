import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthProvider'
import './index.css'

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
