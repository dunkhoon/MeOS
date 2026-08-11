// 로컬 동기화 서버 (개발용).
// 웹의 새로고침 버튼이 POST /api/sync/intervals 를 호출 → intervals.icu 동기화 실행.
// Vite dev 서버가 /api → 이 서버로 프록시한다. (배포/모바일용은 이후 Edge Function으로 이식)

import http from 'node:http'
import { runSync } from '../scripts/sync-core.mjs'

const PORT = Number(process.env.SYNC_PORT || 9797)
let running = false

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === 'POST' && req.url === '/api/sync/intervals') {
    if (running) {
      res.writeHead(409)
      res.end(JSON.stringify({ ok: false, error: '이미 동기화가 진행 중입니다.' }))
      return
    }
    running = true
    const started = Date.now()
    console.log('[sync] 시작')
    try {
      const result = await runSync((m) => console.log('[sync]', m))
      console.log('[sync] 완료', result, `${Date.now() - started}ms`)
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (e) {
      console.error('[sync] 실패:', e.message)
      res.writeHead(500)
      res.end(JSON.stringify({ ok: false, error: e.message }))
    } finally {
      running = false
    }
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sync-server] listening on http://127.0.0.1:${PORT}`)
})
