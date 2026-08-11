// 동기화 수동 실행 (CLI) — 실행: node scripts/sync-intervals.mjs [--full]
//
// 로직은 여기 없다. Supabase Edge Function(`supabase/functions/sync`)이 유일한 구현이고
// 이 스크립트는 그걸 호출만 한다 — 예전처럼 Node 판/Deno 판 두 벌을 들고 있으면 반드시 어긋난다.
//
// service_role 키로 호출하므로 사용자 JWT 없이도 동작한다 (함수가 '가입된 첫 사용자'로 처리).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadEnv() {
  const env = {}
  try {
    for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].trim()
    }
  } catch {
    /* .env.local 없으면 process.env 만 */
  }
  return { ...env, ...process.env }
}

const env = loadEnv()
const url = env.VITE_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('[실패] .env.local 에 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.')
  process.exit(1)
}

const full = process.argv.includes('--full')
console.log(`[동기화] Edge Function 호출${full ? ' (전체 기간)' : ''}…`)

const res = await fetch(`${url.replace(/\/$/, '')}/functions/v1/sync`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ full }),
})

const text = await res.text()
let body
try {
  body = JSON.parse(text)
} catch {
  console.error(`[실패] HTTP ${res.status} — 함수가 배포되지 않았을 수 있습니다.`)
  console.error(text.slice(0, 400))
  process.exit(1)
}

if (!res.ok || !body.ok) {
  console.error('[실패]', body.error || `HTTP ${res.status}`)
  process.exit(1)
}
console.log(`[완료] 활동 ${body.activities} · 웰니스 ${body.wellness} · 대회 ${body.races} · 일정 ${body.events}`)
