// CL 코드 리뷰 — 같은 diff 를 여러 LLM 에게 보내고 결과를 마크다운 한 벌로 모은다.
//
// codex / claude 는 **CLI 를 그대로 실행**한다. API 키가 아니라 이미 로그인해 둔 구독 계정으로
// 동작시키는 게 목적이라(auth 방식), 자식 프로세스 환경에서 ANTHROPIC_API_KEY 같은 값을 일부러
// 지운다 — 그게 남아 있으면 CLI 가 로그인 대신 그 키를 쓴다 (실제로 그렇게 동작하는 걸 확인했다).
//
// 사내 LLM(local)은 기존 llm.js 의 OpenAI 호환 경로를 그대로 쓴다.
//
// Electron API 를 쓰지 않는 순수 Node 모듈이라 단독으로 테스트할 수 있다. Windows 전용 기능이다.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const llm = require('./llm')

/**
 * 리뷰어 종류. 설정 화면은 이 표를 IPC 로 받아서 그린다 — 목록을 렌더러에 또 적지 않는다.
 *
 * external=true 는 **코드가 사외로 나간다**는 뜻이다. 화면에서 그렇게 표시한다.
 * codex 의 'minimal' 은 빼 뒀다 — codex 가 기본으로 켜는 web_search/image_gen 도구와 충돌해서
 * 400 으로 떨어진다.
 */
const KINDS = {
  codex: {
    label: 'Codex (GPT)',
    external: true,
    cli: 'codex',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    models: ['gpt-5.5', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1'],
    note: 'ChatGPT 구독 로그인(codex login)으로 동작합니다.',
  },
  claude: {
    label: 'Claude',
    external: true,
    cli: 'claude',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    models: ['opus', 'sonnet', 'haiku'],
    note: 'Claude 구독 로그인(claude 로그인 상태)으로 동작합니다.',
  },
  local: {
    label: '사내 LLM',
    external: false,
    cli: null,
    efforts: [],
    defaultEffort: '',
    models: [],
    note: '사내망(llm.aquatree.games) 안에서 처리되어 코드가 회사 밖으로 나가지 않습니다.',
  },
}

/** 구독 로그인 대신 API 키를 쓰게 만드는 환경변수들 — 자식 프로세스에서 지운다. */
const API_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_API_KEY_HELPER',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'CODEX_API_KEY',
]

/** CLI 자식 프로세스용 환경 — API 키류를 걷어내 구독 로그인으로 떨어지게 한다. */
function cliEnv() {
  const env = { ...process.env }
  for (const k of API_ENV_KEYS) delete env[k]
  // 색 코드가 섞이면 md 가 지저분해진다
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

// ── 실행 파일 찾기 ──────────────────────────────────────────

const isBatch = (p) => /\.(cmd|bat)$/i.test(p || '')

/**
 * PATH 에서 실행 파일을 찾는다. `.exe` 를 `.cmd` 보다 먼저 고른다 —
 * `.cmd` 는 cmd.exe 를 한 번 거쳐야 해서 인용 문제가 생긴다.
 */
function whichExe(name) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
  const rank = (e) => (/\.exe$/i.test(e) ? 0 : /\.com$/i.test(e) ? 1 : 2)
  exts.sort((a, b) => rank(a) - rank(b))

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    // 확장자 없는 이름은 건너뛴다 — npm 은 git-bash 용 셸 스크립트를 확장자 없이 같이 깔아 두는데,
    // 그건 윈도우에서 spawn 하면 ENOENT 로 떨어진다 (실제로 codex 가 그렇다).
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch {
        /* 다음 후보 */
      }
    }
  }
  return null
}

/** dir 아래에서 파일 이름 하나를 깊이 제한을 두고 찾는다 (npm 전역 설치본 안의 네이티브 바이너리용). */
function findUnder(dir, fileName, maxDepth = 10) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const dirs = []
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return path.join(dir, e.name)
    if (e.isDirectory()) dirs.push(path.join(dir, e.name))
  }
  if (maxDepth <= 0) return null
  for (const d of dirs) {
    const hit = findUnder(d, fileName, maxDepth - 1)
    if (hit) return hit
  }
  return null
}

/**
 * codex 는 npm 전역 설치본 안에 네이티브 `codex.exe` 를 들고 있다.
 * PATH 에 잡히는 건 `codex.cmd`(node 래퍼)라, 있으면 exe 쪽을 쓴다.
 */
function findCodexNative() {
  const roots = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai'))
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@openai'))

  // 실제로 쓰이는 배치 두 가지를 먼저 본다 (node_modules 를 훑는 것보다 훨씬 빠르다)
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const pkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
  const known = [
    ['codex', 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe'],
    ['codex', 'node_modules', '@openai', pkg, 'vendor', triple, 'codex', 'codex.exe'],
    [pkg, 'vendor', triple, 'bin', 'codex.exe'],
    [pkg, 'vendor', triple, 'codex', 'codex.exe'],
  ]
  for (const r of roots) {
    for (const parts of known) {
      const p = path.join(r, ...parts)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch {
        /* 다음 후보 */
      }
    }
  }
  // 배치가 또 바뀌었으면 훑어서 찾는다
  for (const r of roots) {
    const hit = findUnder(r, 'codex.exe')
    if (hit) return hit
  }
  return null
}

/** 리뷰어 종류별 CLI 경로. saved 에 값이 있으면 그게 이긴다. */
function resolveCli(kind, saved) {
  const configured = (saved || '').trim()
  if (configured) {
    let ok = false
    try {
      ok = fs.statSync(configured).isFile()
    } catch {
      ok = false
    }
    return { path: configured, found: ok, source: 'setting' }
  }
  if (kind === 'codex') {
    const native = findCodexNative()
    if (native) return { path: native, found: true, source: 'npm' }
  }
  const onPath = whichExe(kind === 'codex' ? 'codex' : 'claude')
  if (onPath) return { path: onPath, found: true, source: 'PATH' }
  return { path: '', found: false, source: null }
}

// ── 프로세스 실행 ───────────────────────────────────────────

/** 윈도우 프로세스 트리를 통째로 죽인다 (cmd.exe 를 거치면 자식이 따로 남는다). */
function killTree(child) {
  if (!child || child.exitCode != null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      return
    } catch {
      /* 아래 kill 로 */
    }
  }
  try {
    child.kill()
  } catch {
    /* 이미 죽음 */
  }
}

/** cmd.exe 로 넘길 때만 쓰는 최소 인용. 인자 안에 큰따옴표는 넣지 않는다(넣을 일도 없다). */
function quoteForCmd(s) {
  const v = String(s)
  if (v === '') return '""'
  return /[\s&|<>^()]/.test(v) ? `"${v.replace(/"/g, '')}"` : v
}

/**
 * 실행하고 stdout/stderr 를 모아 돌려준다. 프롬프트는 stdin 으로 넣는다 —
 * diff 가 수만 자라 명령줄 인자(윈도우 32767자 제한)로는 못 넘긴다.
 */
function runProcess(exe, args, { input = '', cwd, timeoutMs = 900000, onChild } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      if (isBatch(exe)) {
        // .cmd 래퍼는 cmd.exe 를 거쳐야 한다. Node 가 다시 인용하지 않도록 verbatim 으로 넘긴다.
        const line = [exe, ...args].map(quoteForCmd).join(' ')
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
          cwd,
          env: cliEnv(),
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      } else {
        child = spawn(exe, args, { cwd, env: cliEnv(), windowsHide: true })
      }
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false })
      return
    }

    if (onChild) onChild(child)

    const out = []
    const err = []
    let done = false
    let timedOut = false

    const timer = setTimeout(() => {
      if (done) return
      timedOut = true
      killTree(child)
    }, timeoutMs)

    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))

    const finish = (code, spawnErr) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: (spawnErr ? `${spawnErr}\n` : '') + Buffer.concat(err).toString('utf8'),
        timedOut,
      })
    }

    child.on('error', (e) =>
      finish(-1, e.code === 'ENOENT' ? `실행 파일을 찾을 수 없습니다: ${exe}` : e.message),
    )
    child.on('close', (code) => finish(code))

    try {
      child.stdin.end(input, 'utf8')
    } catch {
      /* 이미 죽은 프로세스 */
    }
  })
}

/** ANSI 코드와 잡음을 걷어내고 에러 메시지로 쓸 만한 끝부분만 남긴다. */
function cleanCliError(text, max = 700) {
  const s = String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return s.length > max ? `…${s.slice(-max)}` : s
}

// ── 프롬프트 ────────────────────────────────────────────────

const REVIEW_SYSTEM = `너는 게임 클라이언트 개발팀(언리얼 엔진 · C++ · 블루프린트 · C#)의 시니어 코드 리뷰어다.
아직 서밋하지 않은 Perforce 체인지리스트의 변경분을 검토한다.

반드시 아래 마크다운 형식으로만 답한다. 인사말·서론·맺음말은 쓰지 마라.

## 요약
한두 문장으로 이 변경이 무엇을 하는지, 서밋해도 되는 상태인지.

## 발견
심각한 것부터. 항목마다 이렇게 쓴다.

### [심각] 짧은 제목
- **위치**: 파일 경로 (알 수 있으면 함수/줄까지)
- **문제**: 무엇이 잘못됐는지
- **근거**: diff 의 어느 줄을 보고 그렇게 판단했는지
- **제안**: 어떻게 고치면 되는지 (필요하면 코드 블록)

심각도는 \`[심각]\` \`[주의]\` \`[제안]\` 셋 중 하나만 쓴다.
- [심각] : 크래시 · 메모리/리소스 누수 · 널 역참조 · 데이터 손상 · 보안 · 명백한 로직 오류
- [주의] : 경계 조건 · 예외 처리 누락 · 스레드/수명주기 문제 · 성능 저하 가능성
- [제안] : 가독성 · 네이밍 · 중복 · 컨벤션

문제를 못 찾았으면 "## 발견" 아래에 \`발견 없음\` 한 줄만 쓴다.

## 확인 필요
diff 만으로는 판단할 수 없어 사람이 직접 봐야 하는 것. 없으면 이 절은 통째로 생략한다.

지켜야 할 것:
- diff 에 실제로 있는 근거로만 말한다. 보이지 않는 코드의 동작을 지어내지 마라.
- 확신이 없으면 [심각]/[주의] 대신 "확인 필요" 로 보낸다.
- 바뀐 파일 목록을 그대로 나열하지 마라. 변경의 의미와 위험만 쓴다.
- 바이너리(.uasset/.umap 등)는 내용을 볼 수 없다. 추측하지 말고 언급도 하지 마라.
- 사소한 스타일 지적으로 목록을 채우지 마라. 진짜 문제가 없으면 없다고 하는 편이 낫다.
- 한국어로 쓴다. 코드 블록에는 언어를 표기한다.`

/** 프롬프트 한 덩어리를 만든다. 세 리뷰어 모두 **같은 입력**을 받는다 (비교가 목적이므로). */
function buildReviewPrompt({
  change,
  description,
  workspace,
  files = [],
  diff = '',
  added = [],
  deleted = [],
  binary = [],
  newFiles = [],
  truncated = false,
  diffError = null,
}) {
  const parts = []
  const label = change === 'default' ? 'default 체인지리스트' : `체인지리스트 CL ${change}`
  parts.push(`[대상] ${label}${workspace ? ` · 워크스페이스 ${workspace}` : ''}`)

  if (description && description.trim()) {
    parts.push(`[작성자가 적어 둔 설명]\n${description.trim()}`)
  }

  const textFiles = files.filter((f) => !binary.includes(f.depotFile))
  parts.push(
    `[변경 파일 ${files.length}개]\n${
      textFiles.map((f) => `${f.depotFile} (${f.action})`).join('\n') || '(텍스트 파일 없음)'
    }`,
  )
  if (binary.length) parts.push(`[바이너리 파일 ${binary.length}개] — 내용을 볼 수 없다.\n${binary.join('\n')}`)
  if (deleted.length) parts.push(`[삭제된 파일]\n${deleted.join('\n')}`)

  if (diff && diff.trim()) {
    parts.push(`[변경 내용 (p4 diff -du)]\n${diff}`)
    if (truncated) parts.push('(diff 가 길어 일부만 포함됐다. 포함된 범위 안에서만 판단하라.)')
  } else if (diffError) {
    parts.push(`[변경 내용] 가져오지 못했다 (${diffError}).`)
  }

  // 새로 추가한 파일은 서버에 아직 없어 diff 가 안 나온다 — 리뷰에서는 이게 핵심이라 본문을 넣는다
  if (newFiles.length) {
    const blocks = newFiles.map((n) =>
      n.text
        ? `--- ${n.depotFile} (신규${n.truncated ? ' · 앞부분만' : ''}) ---\n${n.text}`
        : `--- ${n.depotFile} (신규) --- ${n.skipped || '내용 없음'}`,
    )
    parts.push(`[새로 추가된 파일 전문]\n${blocks.join('\n\n')}`)
  } else if (added.length) {
    parts.push(`[새로 추가된 파일]\n${added.join('\n')}\n(내용을 읽지 못해 경로만 있다.)`)
  }

  return `아래 Perforce 체인지리스트를 코드 리뷰해줘.\n\n${parts.join('\n\n')}`
}

// ── 리뷰어별 실행 ───────────────────────────────────────────

/** 같은 밀리초에 codex 를 둘 이상 띄워도 출력 파일이 겹치지 않게 하는 일련번호 */
let outSeq = 0

/** codex CLI. 최종 답변만 파일로 받아 stdout 의 진행 로그와 섞이지 않게 한다. */
async function runCodex(prompt, { exe, model, effort, timeoutMs, cwd, onChild }) {
  const outFile = path.join(cwd, `codex-out-${process.pid}-${Date.now()}-${++outSeq}.md`)
  const args = [
    'exec',
    '-', // 프롬프트는 stdin 에서 읽는다
    '--sandbox',
    'read-only',
    '--skip-git-repo-check', // Perforce 워크스페이스는 git 저장소가 아니다
    '--ephemeral', // 세션 파일을 남기지 않는다
    '--color',
    'never',
    '--output-last-message',
    outFile,
  ]
  if (model) args.push('--model', model)
  // 값에 따옴표를 붙이지 않는다 — TOML 파싱에 실패하면 문자열 그대로 쓰이고, cmd.exe 인용도 피한다
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)

  // codex exec 에는 시스템 프롬프트 옵션이 없다 — 지시문을 프롬프트 앞에 붙인다.
  // (안 붙였더니 형식을 제멋대로 잡아서 심각도 표시가 안 나왔다)
  const r = await runProcess(exe, args, {
    input: `${REVIEW_SYSTEM}\n\n---\n\n${prompt}`,
    cwd,
    timeoutMs,
    onChild,
  })

  let text = ''
  try {
    text = fs.readFileSync(outFile, 'utf8')
  } catch {
    /* 실패했으면 아래에서 에러로 */
  }
  try {
    fs.rmSync(outFile, { force: true })
  } catch {
    /* 남아도 그만 */
  }

  if (text.trim()) return { text: text.trim(), meta: null }
  if (r.timedOut) throw new Error(`시간 초과 — ${Math.round(timeoutMs / 60000)}분 안에 끝나지 않았습니다.`)
  throw new Error(cleanCliError(r.stderr || r.stdout) || `codex 실패 (exit ${r.code})`)
}

/** claude CLI. --output-format json 이라 본문과 함께 비용·소요시간도 받는다. */
async function runClaude(prompt, { exe, model, effort, timeoutMs, cwd, onChild }) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '', // 도구 없이 — 우리가 준 diff 만 보고 리뷰한다 (워크스페이스를 뒤지지 않는다)
    '--no-session-persistence',
    '--strict-mcp-config', // MCP 서버를 붙이지 않는다
    '--setting-sources',
    '', // 사용자/프로젝트 설정을 읽지 않는다 (남의 CLAUDE.md 지시가 섞이지 않게)
  ]
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)

  // 여러 줄 문자열은 cmd.exe 를 거치면 깨진다 — 래퍼로 실행할 땐 프롬프트 앞에 붙인다
  let input = prompt
  if (isBatch(exe)) input = `${REVIEW_SYSTEM}\n\n---\n\n${prompt}`
  else args.push('--system-prompt', REVIEW_SYSTEM)

  const r = await runProcess(exe, args, { input, cwd, timeoutMs, onChild })

  if (r.timedOut) throw new Error(`시간 초과 — ${Math.round(timeoutMs / 60000)}분 안에 끝나지 않았습니다.`)

  let text = ''
  let meta = null
  try {
    const j = JSON.parse(r.stdout)
    text = String(j.result || '')
    if (j.is_error) throw new Error(text || 'claude 오류')
    meta = {
      costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      model: j.modelUsage ? Object.keys(j.modelUsage)[0] || null : null,
    }
  } catch {
    text = r.stdout.trim() // JSON 이 아니면 그대로 본다
  }

  if (text.trim()) return { text: text.trim(), meta }
  throw new Error(cleanCliError(r.stderr || r.stdout) || `claude 실패 (exit ${r.code})`)
}

/** 사내 LLM (OpenAI 호환). 코드가 사외로 나가지 않는 유일한 경로다. */
async function runLocal(prompt, { llmCfg, model, timeoutMs, maxTokens = 4000 }) {
  const res = await llm.chat(llmCfg, {
    model,
    maxTokens,
    timeoutMs,
    messages: [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: prompt },
    ],
  })
  const text = String(res.content || '').trim()
  if (!text) throw new Error('사내 LLM 이 빈 응답을 돌려줬습니다.')
  return {
    text,
    meta: { model: res.model, tokens: res.usage && res.usage.total_tokens ? res.usage.total_tokens : null },
  }
}

/** 리뷰어 하나 실행. 종류에 따라 위 셋 중 하나로 보낸다. */
async function runReviewer(prompt, reviewer, ctx) {
  const started = Date.now()
  try {
    let out
    if (reviewer.kind === 'codex') {
      if (!ctx.cli.codex.found) throw new Error('codex CLI 를 찾지 못했습니다. 설정에서 경로를 지정하세요.')
      out = await runCodex(prompt, {
        exe: ctx.cli.codex.path,
        model: reviewer.model,
        effort: reviewer.effort,
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.tmpDir,
        onChild: ctx.onChild,
      })
    } else if (reviewer.kind === 'claude') {
      if (!ctx.cli.claude.found) throw new Error('claude CLI 를 찾지 못했습니다. 설정에서 경로를 지정하세요.')
      out = await runClaude(prompt, {
        exe: ctx.cli.claude.path,
        model: reviewer.model,
        effort: reviewer.effort,
        timeoutMs: ctx.timeoutMs,
        cwd: ctx.tmpDir,
        onChild: ctx.onChild,
      })
    } else if (reviewer.kind === 'local') {
      if (!ctx.llmCfg || !ctx.llmCfg.baseUrl || !ctx.llmCfg.apiKey) {
        throw new Error('사내 LLM 접속 정보가 없습니다. 설정 → Perforce 에서 넣으세요.')
      }
      out = await runLocal(prompt, { llmCfg: ctx.llmCfg, model: reviewer.model, timeoutMs: ctx.timeoutMs })
    } else {
      throw new Error(`알 수 없는 리뷰어 종류: ${reviewer.kind}`)
    }
    return { ok: true, text: out.text, meta: out.meta, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }
  }
}

/** 화면·파일에 쓸 리뷰어 이름 — "Codex (gpt-5.5 · high)". */
function reviewerLabel(r) {
  const kind = KINDS[r.kind]
  const bits = [r.model, r.effort].filter(Boolean).join(' · ')
  return `${(kind && kind.label) || r.kind}${bits ? ` (${bits})` : ''}`
}

// ── 마크다운 조립 ───────────────────────────────────────────

/** 프론트매터 값은 JSON 으로 적는다 — 한글·따옴표가 섞여도 되돌려 읽을 수 있다. */
function frontMatter(meta) {
  const lines = ['---']
  for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${JSON.stringify(v ?? null)}`)
  lines.push('---')
  return lines.join('\n')
}

/** 저장된 md 앞머리에서 목록에 쓸 정보를 읽는다. */
function parseFrontMatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*([\s\S]*)$/)
    if (!kv) continue
    try {
      out[kv[1]] = JSON.parse(kv[2])
    } catch {
      out[kv[1]] = kv[2].trim()
    }
  }
  return out
}

const two = (n) => String(n).padStart(2, '0')

/** 파일명에 박는 로컬 시각 — 20260814-153012 */
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  )
}

/** 사람이 읽을 로컬 시각 — 2026-08-14 15:30:12 */
function humanTime(d = new Date()) {
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  )
}

function mmss(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${two(s % 60)}초`
}

/**
 * 리뷰 결과 한 벌을 md 로 만든다.
 * 리뷰어 본문이 `##` 부터 쓰므로 구분선은 `#` 한 단계로 둔다.
 */
function renderReviewMarkdown({ change, description, workspace, files = [], results = [], diffMeta = {}, at = new Date() }) {
  const okCount = results.filter((r) => r.ok).length
  const title = (description || '').split(/\r?\n/)[0].trim()

  const head = frontMatter({
    change: String(change),
    createdAt: at.toISOString(),
    createdLocal: humanTime(at),
    workspace: workspace || '',
    fileCount: files.length,
    title,
    reviewers: results.map((r) => r.label),
    ok: okCount,
    failed: results.length - okCount,
  })

  const lines = [head, '']
  lines.push(`# ${change === 'default' ? 'default' : `CL ${change}`} 코드 리뷰`)
  lines.push('')
  const facts = [humanTime(at), `파일 ${files.length}개`]
  if (workspace) facts.push(`워크스페이스 \`${workspace}\``)
  if (diffMeta.truncated) facts.push('diff 일부 생략')
  if (diffMeta.binaryCount) facts.push(`바이너리 ${diffMeta.binaryCount}개`)
  lines.push(`> ${facts.join(' · ')}`)
  lines.push('')

  if (title) {
    lines.push('**CL 설명**')
    lines.push('')
    lines.push(
      String(description)
        .split(/\r?\n/)
        .map((l) => `> ${l}`)
        .join('\n'),
    )
    lines.push('')
  }

  for (const r of results) {
    lines.push('---')
    lines.push('')
    lines.push(`# 🤖 ${r.label}`)
    const bits = [mmss(r.ms)]
    if (r.meta && r.meta.tokens) bits.push(`${r.meta.tokens} 토큰`)
    if (r.meta && typeof r.meta.costUsd === 'number') bits.push(`$${r.meta.costUsd.toFixed(4)}`)
    lines.push('')
    lines.push(`> ${bits.join(' · ')}`)
    lines.push('')
    lines.push(r.ok ? r.text : `**실패** — ${r.error}`)
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

module.exports = {
  KINDS,
  API_ENV_KEYS,
  cliEnv,
  whichExe,
  findCodexNative,
  resolveCli,
  runProcess,
  killTree,
  cleanCliError,
  REVIEW_SYSTEM,
  buildReviewPrompt,
  runReviewer,
  reviewerLabel,
  renderReviewMarkdown,
  frontMatter,
  parseFrontMatter,
  stamp,
  humanTime,
}
