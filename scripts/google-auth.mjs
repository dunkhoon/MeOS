// 구글 캘린더 OAuth 1회 인증 → refresh token 을 .env.local 에 저장.
// 사전: .env.local 에 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (Desktop app OAuth 클라이언트)
// 실행: node scripts/google-auth.mjs   (브라우저가 열리면 구글 계정으로 동의)

import http from 'node:http'
import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { exec } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = path.join(ROOT, '.env.local')

function loadEnv() {
  const env = {}
  try {
    for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].trim()
    }
  } catch {
    /* ignore */
  }
  return env
}

const env = loadEnv()
const CLIENT_ID = env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[오류] .env.local 에 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 가 필요합니다.')
  process.exit(1)
}
if (env.GOOGLE_REFRESH_TOKEN) {
  console.log('[알림] 이미 GOOGLE_REFRESH_TOKEN 이 있습니다. 다시 받으려면 .env.local 에서 해당 줄을 지우고 실행하세요.')
}

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

let port
let redirect

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect)
  const code = u.searchParams.get('code')
  if (!code) {
    res.writeHead(400)
    res.end('no code')
    return
  }
  try {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      }),
    })
    const tok = await tokRes.json()
    if (!tok.refresh_token) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h2>refresh_token 을 받지 못했습니다. 앱 권한을 해제(myaccount.google.com/permissions) 후 다시 시도하세요.</h2>')
      console.error('[오류] refresh_token 없음:', tok)
      server.close()
      process.exit(1)
    }
    appendFileSync(ENV_PATH, `\nGOOGLE_REFRESH_TOKEN=${tok.refresh_token}\n`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h2>인증 완료! 이 창을 닫고 앱으로 돌아가세요.</h2>')
    console.log('[완료] GOOGLE_REFRESH_TOKEN 을 .env.local 에 저장했습니다.')
    server.close()
    setTimeout(() => process.exit(0), 300)
  } catch (e) {
    res.writeHead(500)
    res.end('error')
    console.error(e)
    process.exit(1)
  }
})

server.listen(0, '127.0.0.1', () => {
  port = server.address().port
  redirect = `http://127.0.0.1:${port}`
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
    }).toString()
  console.log('\n브라우저에서 아래 URL을 열어 구글 계정으로 동의하세요 (자동으로 열리지 않으면 복사해서 여세요):\n')
  console.log(authUrl + '\n')
  exec(`start "" "${authUrl}"`, () => {})
})
