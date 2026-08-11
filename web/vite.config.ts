import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

// .env.local은 저장소 루트에 있음 (web / electron / edge function 공용)
export default defineConfig({
  plugins: [
    react(),
    // Android 홈 화면 설치용 PWA. Electron 은 이 파일들을 무시하므로 데스크톱에 영향 없음.
    VitePWA({
      registerType: 'autoUpdate', // 새로 배포하면 다음 실행 때 자동 반영
      // 등록 스크립트를 자동 주입하지 않는다 — 데스크톱 앱에서는 등록하지 않으려고
      // main.tsx 에서 직접 부른다 (서비스워커가 낡은 화면을 붙잡는 문제, 아래 참고).
      injectRegister: null,
      includeAssets: ['apple-touch-icon.png', 'favicon-32.png'],
      manifest: {
        name: 'MeOS',
        short_name: 'MeOS',
        description: '개인 통합 대시보드 — 업무 · 캘린더 · 운동 · 리포트',
        lang: 'ko',
        start_url: '/',
        scope: '/',
        display: 'standalone', // 주소창 없는 앱처럼 실행
        orientation: 'portrait',
        background_color: '#0e0f13',
        theme_color: '#0e0f13',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // maskable: 안드로이드가 아이콘을 원형/사각으로 잘라낼 때 쓰는 여백 포함 버전
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Supabase API 응답은 캐시하지 않는다 — 오래된 데이터를 보여주면 안 되고,
        // 인증 토큰이 캐시에 남는 것도 피해야 한다.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
      devOptions: {
        enabled: false, // 개발 중에는 서비스워커 끔 (캐시 때문에 헷갈리는 것 방지)
      },
    }),
  ],
  envDir: path.resolve(import.meta.dirname, '..'),
  server: {
    port: 5173,
    // 동기화는 Supabase Edge Function 이 맡는다 — 로컬 프록시(/api) 불필요.
  },
})
