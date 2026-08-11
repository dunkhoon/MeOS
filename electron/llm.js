// 사내 로컬 LLM 게이트웨이 클라이언트 (OpenAI 호환 API).
//
// 사내망 안에서만 도는 서버라 diff(소스코드)를 그대로 보내도 외부로 나가지 않는다.
// 이것이 Anthropic API 대신 이 경로를 쓰는 이유다 — 회사 코드가 사외로 전송되지 않는다.
//
// Electron API 를 쓰지 않는 순수 Node 모듈이라 단독으로 테스트할 수 있다.

const http = require('node:http')
const https = require('node:https')

/** 연결 자체가 안 된 경우 (이 PC 는 임시 포트가 자주 고갈된다 — p4.js 주석 참고). */
function isConnectFailure(e) {
  const code = (e && e.code) || ''
  return /EADDRINUSE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(`${code} ${e && e.message}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** JSON 요청/응답. 연결 단계 실패는 잠깐 쉬었다 재시도한다. */
async function request(url, opts = {}) {
  const tries = opts.retries ?? 3
  const backoff = [400, 1200, 2600]
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await requestOnce(url, opts)
    } catch (e) {
      last = e
      if (!isConnectFailure(e) || i === tries - 1) break
      await sleep(backoff[Math.min(i, backoff.length - 1)])
    }
  }
  if (isConnectFailure(last)) {
    throw new Error(
      `사내 LLM 서버에 연결하지 못했습니다 (${(last && last.code) || last.message}).\n` +
        '이 PC의 임시 포트가 일시적으로 고갈된 상태일 수 있습니다. 잠시 후 다시 시도해 보세요.',
    )
  }
  throw last
}

/** OpenAI 호환 에러 바디({error:{message}})를 읽어 메시지를 만든다. */
function requestOnce(rawUrl, { method = 'GET', headers = {}, body, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(rawUrl)
    } catch {
      reject(new Error('LLM 주소 형식이 올바르지 않습니다.'))
      return
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const mod = u.protocol === 'https:' ? https : http

    const req = mod.request(
      u,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* 아래에서 처리 */
          }
          const code = res.statusCode || 0
          if (code < 200 || code >= 300) {
            const msg = (json && json.error && (json.error.message || json.error.type)) || text.slice(0, 200)
            reject(new Error(`HTTP ${code} — ${msg}`))
            return
          }
          if (!json) {
            reject(new Error('응답을 JSON 으로 읽지 못했습니다.'))
            return
          }
          resolve(json)
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('LLM 응답 시간 초과')))
    req.on('error', (e) => reject(e))
    if (payload) req.write(payload)
    req.end()
  })
}

function auth(cfg) {
  return { Authorization: `Bearer ${cfg.apiKey}` }
}
function base(cfg) {
  return String(cfg.baseUrl || '').replace(/\/+$/, '')
}

/** 게이트웨이가 제공하는 모델 목록. 설정 화면 드롭다운을 이걸로 채운다. */
async function listModels(cfg) {
  const json = await request(`${base(cfg)}/models`, { headers: auth(cfg), timeoutMs: 20000 })
  return (json.data || []).map((m) => m.id).filter(Boolean).sort()
}

/** 채팅 1회. jsonMode 를 켜면 JSON 만 나오도록 강제한다. */
async function chat(cfg, { model, messages, maxTokens = 1200, jsonMode = false, timeoutMs }) {
  const json = await request(`${base(cfg)}/chat/completions`, {
    method: 'POST',
    headers: auth(cfg),
    timeoutMs,
    body: {
      model,
      messages,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
  })
  const choice = (json.choices || [])[0]
  if (!choice) throw new Error('LLM 응답에 결과가 없습니다.')
  return {
    content: (choice.message && choice.message.content) || '',
    finishReason: choice.finish_reason || null,
    usage: json.usage || null,
    model: json.model || model,
  }
}

const SYSTEM_PROMPT = `너는 게임 클라이언트 개발팀의 Perforce 서밋 로그를 작성한다.
반드시 아래 형태의 JSON 만 출력한다:
{"content": "컨텐츠명", "issue": "작업번호", "items": ["항목", "항목"]}

각 필드:
- content: 이 작업이 속한 컨텐츠명 (예: 토너먼트, 인벤토리, 상점). 대괄호는 넣지 마라.
  [최근 내 작업 이력] 에 컨텐츠명이 있으면 그대로 쓴다. 이력이 없으면 파일 경로에서 유추하고,
  그것도 애매하면 빈 문자열("")로 둔다.
- issue: 작업번호 숫자만 (예: "29580"). # 는 넣지 마라.
  [최근 내 작업 이력] 에서 이번 변경과 이어지는 번호가 확인될 때만 쓴다.
  확실하지 않으면 반드시 빈 문자열("")로 둔다. 번호를 지어내는 것은 절대 금지다.
- items: 변경 내용을 담은 문자열 배열. 각 항목은 "짧은 제목 : 구체적인 설명" 형태로 쓴다.

items 작성 규칙:
- "짧은 제목 : 설명" 에서 제목은 무엇을 고쳤는지, 설명은 왜/어떻게 고쳤는지를 담는다.
  좋은 예: "메뉴 탭 숨김 처리 수정 : WBP 에서 탭이 오버레이로 한 번 더 감싸여 있어 탭 자신만 숨기면 감싼 오버레이가 자리를 그대로 차지하던 문제. 탭이 아니라 감싼 부모를 접도록 변경"
- 바이너리 파일(.uasset/.umap 등 [바이너리 파일] 목록)은 diff 를 볼 수 없다.
  장황하게 쓰지 말고 "WBP : 토너먼트 메인 UI 구성 수정" 처럼 파일 종류와 한 줄 요약만 적는다.
  여러 개면 묶어서 한 항목으로 적는다. 내부에서 무엇이 바뀌었는지 추측해 쓰지 마라.
- diff 에서 확인되지 않는 내용은 절대 지어내지 마라. 근거가 없으면 쓰지 않는다.
- 파일 경로를 그대로 나열하지 마라. 변경의 의미를 쓴다.
- 한국어로 쓴다.`

/** JSON 결과를 사용자가 쓰는 양식의 텍스트로 조립한다. 이름은 항상 맨 앞에 붙는다. */
function composeLog({ userName, content, issue, items }) {
  const name = (userName || '').trim()
  const tag = (content || '').trim()
  const header = `${name ? `[${name}]` : ''}${tag ? `[${tag}]` : ''}` || '(이름 미설정)'

  const lines = [header]
  const num = String(issue || '').replace(/[^\d]/g, '')
  if (num) lines.push(`- #${num}`)
  for (const it of items || []) {
    const t = String(it || '').trim()
    if (t) lines.push(t.startsWith('-') ? t : `- ${t}`)
  }
  return lines.join('\n')
}

/** 최근 이력에서 내 서밋만 골라 컨텐츠명·작업번호 후보를 뽑는다. */
function historyHints(history, userName) {
  const name = (userName || '').trim()
  if (!name || !history || !history.length) return { mine: [], tags: [], issues: [] }

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mine = history.filter((h) => h.description.includes(`[${name}]`))
  const tags = []
  const issues = []
  for (const h of mine) {
    const t = h.description.match(new RegExp(`\\[${esc}\\]\\s*\\[([^\\]]+)\\]`))
    if (t && !tags.includes(t[1].trim())) tags.push(t[1].trim())
    for (const m of h.description.matchAll(/#(\d{3,})/g)) if (!issues.includes(m[1])) issues.push(m[1])
  }
  return { mine, tags, issues }
}

/** 변경 파일 목록 + diff + 내 과거 이력으로 프롬프트를 만든다. */
function buildUserPrompt({
  files,
  diff,
  added,
  deleted,
  binary,
  existingDescription,
  truncated,
  diffError,
  history,
  userName,
}) {
  const parts = []

  // 내 과거 서밋 — [컨텐츠명] 과 작업번호를 여기서 따온다
  const { mine, tags, issues } = historyHints(history, userName)
  if (mine.length) {
    const recent = mine.slice(0, 6).map((h) => {
      const first = h.description.split(/\r?\n/).slice(0, 3).join(' / ')
      return `CL ${h.change}${h.time ? ` (${h.time.slice(0, 10)})` : ''}: ${first}`
    })
    parts.push(`[최근 내 작업 이력] — 같은 파일들에 대한 내 이전 서밋\n${recent.join('\n')}`)
    if (tags.length) parts.push(`[이력에서 발견된 컨텐츠명] ${tags.join(', ')}`)
    if (issues.length) parts.push(`[이력에서 발견된 작업번호] ${issues.slice(0, 8).map((n) => `#${n}`).join(', ')}`)
  } else {
    parts.push('[최근 내 작업 이력] 없음 — 컨텐츠명은 파일 경로에서 유추하고, 작업번호는 비워 둬라.')
  }

  if (existingDescription && existingDescription.trim()) {
    parts.push(`[기존 CL 설명]\n${existingDescription.trim()}`)
  }

  const textFiles = (files || []).filter((f) => !(binary || []).includes(f.depotFile))
  parts.push(
    `[변경 파일 ${files ? files.length : 0}개]\n${
      textFiles.map((f) => `${f.depotFile} (${f.action})`).join('\n') || '(텍스트 파일 없음)'
    }`,
  )

  if (binary && binary.length) {
    parts.push(`[바이너리 파일 ${binary.length}개] — diff 를 볼 수 없다. 파일 종류와 한 줄 요약만 적어라.\n${binary.join('\n')}`)
  }
  if (added && added.length) parts.push(`[새로 추가된 파일]\n${added.join('\n')}`)
  if (deleted && deleted.length) parts.push(`[삭제된 파일]\n${deleted.join('\n')}`)

  if (diff && diff.trim()) {
    parts.push(`[diff]\n${diff}`)
    if (truncated) parts.push('(diff 가 길어 일부만 포함되었다. 포함된 범위 안에서만 판단하라.)')
  } else {
    parts.push(
      diffError
        ? `[diff] 가져오지 못함 (${diffError}). 파일 경로와 작업 유형만 보고 작성하되, 추측한 내용은 쓰지 마라.`
        : '[diff] 없음 (바이너리이거나 diff 를 뜰 수 없음). 추측한 내용은 쓰지 마라.',
    )
  }

  return `아래 변경사항의 Perforce 서밋 로그를 작성해줘.\n\n${parts.join('\n\n')}`
}

/**
 * 모델 출력에서 JSON 본문만 꺼낸다.
 * JSON 모드를 켜도 가끔 ```json 코드펜스로 감싸거나 앞뒤에 말을 붙여서 내보낸다.
 */
function extractJson(text) {
  let s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const open = s.indexOf('{')
  const close = s.lastIndexOf('}')
  if (open >= 0 && close > open) s = s.slice(open, close + 1)
  return s
}

/** JSON 이 깨졌을 때 정규식으로 필드를 건져낸다 (응답이 잘린 경우 등). */
function salvage(text) {
  const str = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 'i'))
    if (!m) return ''
    try {
      return JSON.parse(`"${m[1]}"`)
    } catch {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  // items 배열에서 완성된 문자열만 건진다
  const items = []
  const arr = text.match(/"items"\s*:\s*\[([\s\S]*)/i)
  if (arr) {
    for (const m of arr[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      try {
        items.push(JSON.parse(`"${m[1]}"`))
      } catch {
        items.push(m[1])
      }
    }
  }
  return { content: str('content').trim(), issue: str('issue').trim(), items }
}

/** 서밋 로그 작성. 파싱이 실패해도 최대한 건져서 돌려준다. */
async function writeSubmitLog(cfg, input) {
  const res = await chat(cfg, {
    model: input.model,
    maxTokens: input.maxTokens || 1500,
    jsonMode: true,
    timeoutMs: input.timeoutMs,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ],
  })

  const raw = extractJson(res.content)
  let content = ''
  let issue = ''
  let items = []
  let parseFailed = false

  try {
    const parsed = JSON.parse(raw)
    content = String(parsed.content || '').trim()
    issue = String(parsed.issue || '').trim()
    items = Array.isArray(parsed.items) ? parsed.items : parsed.items ? [String(parsed.items)] : []
  } catch {
    const s = salvage(raw)
    content = s.content
    issue = s.issue
    items = s.items
    if (!content && !issue && !items.length) {
      items = [res.content.trim()]
      parseFailed = true
    }
  }

  // 이력에 없는 작업번호를 모델이 지어냈으면 버린다 (틀린 번호는 안 쓰느니만 못하다)
  const { issues } = historyHints(input.history, input.userName)
  const num = issue.replace(/[^\d]/g, '')
  const issueTrusted = !!num && issues.includes(num)
  if (num && !issueTrusted) issue = ''

  return {
    content,
    issue,
    items,
    text: composeLog({ userName: input.userName, content, issue, items }),
    model: res.model,
    usage: res.usage,
    finishReason: res.finishReason,
    truncatedResponse: res.finishReason === 'length',
    parseFailed,
    // UI 안내용 — 모델이 지어낸 번호를 걸렀는지
    issueDropped: !!num && !issueTrusted,
  }
}

module.exports = {
  request,
  listModels,
  chat,
  writeSubmitLog,
  buildUserPrompt,
  composeLog,
  historyHints,
  extractJson,
  salvage,
  SYSTEM_PROMPT,
}
