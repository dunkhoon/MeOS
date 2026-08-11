// BTS(Redmine / JIRA) 조회 — 읽기 전용.
// Electron API 를 쓰지 않는 순수 Node 모듈이라 단독으로 테스트할 수 있다.
// 결과는 main 이 렌더러로 그대로 넘기며, DB/파일에 저장하지 않는다.

const http = require('node:http')
const https = require('node:https')

/**
 * JSON GET. 사내 Redmine 이 사설 인증서를 쓰는 경우가 있어 insecure 옵션을 둔다(사용자가 켤 때만).
 */
function httpJson(rawUrl, { headers = {}, insecure = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(rawUrl)
    } catch {
      reject(new Error('주소 형식이 올바르지 않습니다.'))
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const opts = {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'MeOS', ...headers },
    }
    if (u.protocol === 'https:' && insecure) opts.rejectUnauthorized = false

    const req = mod.request(u, opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const code = res.statusCode || 0
        if (code < 200 || code >= 300) {
          reject(new Error(`HTTP ${code}${body ? ` — ${body.slice(0, 180)}` : ''}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error('응답을 JSON 으로 읽지 못했습니다 (로그인 페이지가 왔을 수 있어요).'))
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('응답 시간 초과')))
    req.on('error', (e) => reject(e))
    req.end()
  })
}

/** 내 담당 · 열린 이슈 (Redmine). */
async function fetchRedmine(cfg) {
  const base = cfg.url.replace(/\/+$/, '')
  const url = `${base}/issues.json?assigned_to_id=me&status_id=open&limit=100&sort=updated_on:desc`
  const json = await httpJson(url, { headers: { 'X-Redmine-API-Key': cfg.apiKey }, insecure: cfg.insecure })
  return (json.issues || []).map((i) => ({
    key: `redmine:${i.id}`,
    system: 'redmine',
    issueId: String(i.id),
    title: i.subject || '(제목 없음)',
    tracker: (i.tracker && i.tracker.name) || '기타',
    status: (i.status && i.status.name) || '',
    version: (i.fixed_version && i.fixed_version.name) || null,
    project: (i.project && i.project.name) || null,
    url: `${base}/issues/${i.id}`,
    updatedAt: i.updated_on || null,
  }))
}

/** 내 담당 · 미완료 이슈 (JIRA Cloud). */
async function fetchJira(cfg) {
  const base = cfg.url.replace(/\/+$/, '')
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  const fields = 'summary,issuetype,status,fixVersions,updated,project'
  const qs = `jql=${encodeURIComponent(jql)}&maxResults=100&fields=${encodeURIComponent(fields)}`
  const headers = { Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}` }

  let json
  try {
    // 신 엔드포인트. 구 /rest/api/3/search 는 폐기되었으나 서버판/구버전 호환으로 폴백한다.
    json = await httpJson(`${base}/rest/api/3/search/jql?${qs}`, { headers })
  } catch {
    json = await httpJson(`${base}/rest/api/3/search?${qs}`, { headers })
  }

  return (json.issues || []).map((i) => {
    const f = i.fields || {}
    return {
      key: `jira:${i.key}`,
      system: 'jira',
      issueId: i.key,
      title: f.summary || '(제목 없음)',
      tracker: (f.issuetype && f.issuetype.name) || '기타',
      status: (f.status && f.status.name) || '',
      version: (f.fixVersions && f.fixVersions[0] && f.fixVersions[0].name) || null,
      project: (f.project && f.project.name) || null,
      url: `${base}/browse/${i.key}`,
      updatedAt: f.updated || null,
    }
  })
}

/** 설정된 소스만 조회해 합친다. 한쪽이 실패해도 다른 쪽 결과는 살린다. */
async function fetchAll(cfg) {
  const out = { issues: [], sources: {} }

  const run = async (name, ready, fn) => {
    if (!ready) {
      out.sources[name] = { configured: false, count: 0, error: null }
      return
    }
    try {
      const list = await fn()
      out.issues.push(...list)
      out.sources[name] = { configured: true, count: list.length, error: null }
    } catch (e) {
      out.sources[name] = { configured: true, count: 0, error: e instanceof Error ? e.message : String(e) }
    }
  }

  await Promise.all([
    run('redmine', !!(cfg.redmine.url && cfg.redmine.apiKey), () => fetchRedmine(cfg.redmine)),
    run('jira', !!(cfg.jira.url && cfg.jira.email && cfg.jira.token), () => fetchJira(cfg.jira)),
  ])

  out.issues.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  out.fetchedAt = new Date().toISOString()
  return out
}

module.exports = { httpJson, fetchRedmine, fetchJira, fetchAll }
