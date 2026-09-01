const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  clipboard,
  safeStorage,
  nativeImage,
  session,
  dialog,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const bts = require('./bts')
const disk = require('./disk')
const diskStore = require('./diskStore')
const elevate = require('./elevate')
const p4 = require('./p4')
const llm = require('./llm')
const review = require('./review')
const reviewStore = require('./reviewStore')
const uebuild = require('./uebuild')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
/** 배포 주소 기본값 — 설정에 저장된 값이 있으면 그쪽이 이긴다. */
const DEFAULT_APP_URL = 'https://meos.dunkhoon.workers.dev'
const isDev = !app.isPackaged
const PROTOCOL = 'privateplanner'
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

// ── 관리자 권한으로 다시 열렸을 때 ─────────────────────────
//
// "관리자 권한으로 다시 실행" 은 UAC 를 먼저 띄우고(취소해도 쓰던 앱이 살아 있도록)
// 그 다음에 이전 인스턴스를 닫는다. 그래서 이쪽(승격된 새 인스턴스)은 잠깐 겹쳐서 뜬다 —
// 단일 인스턴스 잠금이 아직 이전 프로세스에 있으면 이 프로세스가 그대로 죽어 버린다.
// **잠금을 잡기 전에** 여기서 기다리는 이유다. 창을 만들기 전이라 동기로 막아도 된다.
;(function waitForPreviousInstance() {
  try {
    const arg = process.argv.find((a) => a.startsWith(elevate.WAIT_FLAG))
    if (!arg) return
    const pid = Number(arg.slice(elevate.WAIT_FLAG.length))
    if (!Number.isInteger(pid) || pid <= 0) return

    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        return !!e && e.code === 'EPERM' // 신호는 못 보내도 살아 있다는 뜻
      }
    }
    // Atomics.wait 가 막힌 컨텍스트가 있다(임베더에 따라 던진다) — 던지면 그냥 돌면서 기다린다.
    const sab = new Int32Array(new SharedArrayBuffer(4))
    let sleep = (ms) => Atomics.wait(sab, 0, 0, ms)
    try {
      sleep(1)
    } catch {
      sleep = (ms) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          /* 승격 재실행 때만 도는 길이라 이 정도는 감수한다 */
        }
      }
    }

    const until = Date.now() + 20000 // 안 죽으면 그냥 진행한다(잠금에서 걸러진다)
    while (Date.now() < until && alive()) sleep(150)
  } catch (e) {
    // 여기서 나는 어떤 문제도 앱 시작을 막으면 안 된다 — 못 기다렸으면 잠금이 알아서 거른다
    console.error('[elevate] 이전 인스턴스 대기 실패', e && e.message)
  }
})()

let mainWindow = null
let tray = null
let pendingAuthUrl = null
let isQuitting = false
/** 지금 창에 띄운 앱 주소 (내비게이션 허용 판정 기준). */
let loadedUrl = ''

// ── 설정 / 스니펫 저장 (userData) ──────────────────────────
function cfgPath() {
  return path.join(app.getPath('userData'), 'pp-config.json')
}
function snipPath() {
  return path.join(app.getPath('userData'), 'pp-snippets.json')
}
function snipTrashPath() {
  return path.join(app.getPath('userData'), 'pp-snippets-trash.json')
}
function btsPath() {
  return path.join(app.getPath('userData'), 'pp-bts.json')
}
function p4CfgPath() {
  return path.join(app.getPath('userData'), 'pp-p4.json')
}
function reviewCfgPath() {
  return path.join(app.getPath('userData'), 'pp-review.json')
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2))
  } catch (e) {
    console.error('[config] write 실패', e.message)
  }
}
function getConfig() {
  return readJson(cfgPath(), {})
}
function getHotkey() {
  return getConfig().hotkey || DEFAULT_HOTKEY
}
function getSnippets() {
  return readJson(snipPath(), [])
}
function getSnippetTrash() {
  return readJson(snipTrashPath(), [])
}

// ── BTS(Redmine/JIRA) 접속 정보 ────────────────────────────
// 회사 업무 토큰은 데스크톱에만 보관한다 (SPEC §8). 비밀값은 safeStorage 로 암호화 저장하고
// 렌더러에는 절대 평문으로 넘기지 않는다 (설정 화면엔 "저장됨" 여부만 표시).
function enc(v) {
  if (!v) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(v).toString('base64')
}
function dec(v) {
  if (!v) return null
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'))
  } catch {
    return null
  }
}

/**
 * .env.local 을 폴백으로 읽는다 (설정 화면 입력값이 우선).
 * 개발이면 저장소 루트, 패키지본이면 exe 옆이나 userData 에 놓아 쓴다.
 * asar 안에서는 `__dirname/..` 이 resources/ 라 저장소 루트를 못 찾으므로 후보를 여러 곳 본다.
 */
function envCandidates() {
  const list = []
  if (process.env.MEOS_ENV_FILE) list.push(process.env.MEOS_ENV_FILE)
  try {
    list.push(path.join(app.getPath('userData'), '.env.local'))
    list.push(path.join(path.dirname(app.getPath('exe')), '.env.local'))
  } catch {
    /* app 준비 전이면 건너뛴다 */
  }
  list.push(path.join(__dirname, '..', '.env.local')) // 저장소 루트 (개발)
  return list
}

function readEnvLocal() {
  const out = {}
  for (const p of envCandidates()) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (line.trim().startsWith('#')) continue
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
        // 앞 후보가 이긴다 (userData > exe 옆 > 저장소 루트)
        if (m && !(m[1] in out)) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    } catch {
      /* 없으면 다음 후보 */
    }
  }
  return out
}

// ── 앱을 어디서 불러올지 ───────────────────────────────────
// 데스크톱 셸은 화면을 직접 들고 있지 않고 배포된 웹(Cloudflare)을 그대로 띄운다.
// UI 를 고치면 push → 재배포 → 앱 재시작만 하면 반영된다 (exe 재빌드 불필요).
//
//   개발(비패키지)  : 항상 Vite dev 서버. MEOS_APP_URL 로만 덮어쓴다.
//   패키지(exe)     : 저장된 주소 → .env.local(MEOS_APP_URL) → 없으면 설정 화면.
function normalizeUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) {
    // 스킴을 안 적으면 https 로 본다 — 단 로컬 주소는 인증서가 없으니 http 로
    s = (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s) ? 'http://' : 'https://') + s
  }
  try {
    const u = new URL(s)
    // new URL 은 'https://!!!' 같은 것도 통과시킨다 — 호스트 모양을 한 번 더 본다
    if (!/^[a-z0-9.\-[\]:]+$/i.test(u.hostname)) return ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function resolveAppUrl() {
  const override = normalizeUrl(process.env.MEOS_APP_URL)
  if (override) return override
  if (isDev) return DEV_URL
  return normalizeUrl(getConfig().appUrl) || normalizeUrl(readEnvLocal().MEOS_APP_URL) || DEFAULT_APP_URL
}

/**
 * 서비스워커·HTTP 캐시를 비운다.
 *
 * 웹은 PWA(모바일 홈 화면 설치용)라 서비스워커가 번들을 통째로 캐시한다. 데스크톱 셸이 그 주소를
 * 불러오면 워커도 같이 설치되는데, **재시작해도 워커는 살아남아** 재배포한 화면이 안 나온다.
 * 앱 쪽에서는 이제 워커를 등록하지 않지만(web/src/main.tsx), 이미 설치된 것과 캐시는 여기서 치운다.
 * localStorage 는 건드리지 않는다 — 로그인 세션이 거기 있다.
 */
async function clearWebCache() {
  try {
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
    await session.defaultSession.clearCache()
  } catch (e) {
    console.error('[cache] 정리 실패', e.message)
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** 저장된 설정 + .env.local 폴백을 합쳐 실제 조회에 쓸 값을 만든다. */
function resolveBtsConfig() {
  const saved = readJson(btsPath(), {})
  const env = readEnvLocal()
  const r = saved.redmine || {}
  const j = saved.jira || {}
  return {
    redmine: {
      url: r.url || env.REDMINE_URL || '',
      apiKey: dec(r.keyEnc) || env.REDMINE_API_KEY || '',
      insecure: !!r.insecure,
    },
    jira: {
      url: j.url || env.JIRA_URL || '',
      email: j.email || env.JIRA_EMAIL || '',
      token: dec(j.tokenEnc) || env.JIRA_API_TOKEN || '',
    },
  }
}

// ── 창 제어 ────────────────────────────────────────────────
function showMain() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}
function openQuickSearch() {
  showMain()
  if (mainWindow) mainWindow.webContents.send('open-quick-search')
}

// ── 전역 단축키 ────────────────────────────────────────────
function registerHotkey(accel) {
  globalShortcut.unregisterAll()
  try {
    return globalShortcut.register(accel, openQuickSearch)
  } catch {
    return false
  }
}

// ── 커스텀 프로토콜 (매직링크 딥링크) ──────────────────────
if (isDev && process.platform === 'win32' && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

// ── IPC ────────────────────────────────────────────────────
ipcMain.handle('open-shortcut', async (_event, target) => {
  if (typeof target !== 'string' || !target.trim()) return { ok: false, error: '대상이 비어 있습니다.' }
  const t = target.trim()
  try {
    if (/^https?:\/\//i.test(t)) {
      await shell.openExternal(t)
      return { ok: true }
    }
    const err = await shell.openPath(t)
    return { ok: !err, error: err || undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── 앱 주소 (배포된 웹을 띄운다) ───────────────────────────
ipcMain.handle('app:getInfo', () => {
  const env = readEnvLocal()
  return {
    url: resolveAppUrl(),
    savedUrl: normalizeUrl(getConfig().appUrl),
    fromEnv: !getConfig().appUrl && !!(process.env.MEOS_APP_URL || env.MEOS_APP_URL),
    isDev, // 개발 모드에선 저장값을 무시하고 dev 서버를 쓴다
    version: app.getVersion(),
  }
})

ipcMain.handle('app:setUrl', (_e, raw) => {
  const url = normalizeUrl(raw)
  if (raw && !url) return { ok: false, error: '주소 형식이 올바르지 않습니다.' }
  writeJson(cfgPath(), { ...getConfig(), appUrl: url })
  return { ok: true, url }
})

ipcMain.handle('app:reload', async (_e, hard) => {
  if (hard) await clearWebCache()
  loadApp()
  return { ok: true }
})

// ── 관리자 권한 ────────────────────────────────────────────
//
// 디스크 정리가 이걸 쓴다. 관리자가 아니면 스캔은 남의 폴더를 조용히 건너뛰고
// 삭제는 실패한다 — 화면이 지금 권한을 보여 주고, 필요하면 승격해서 다시 열 수 있어야 한다.

/** "항상 관리자로" 를 걸 대상. 개발 모드에서는 execPath 가 electron.exe 라 걸면 안 된다. */
function alwaysAdminTarget() {
  return app.isPackaged ? process.execPath : null
}

ipcMain.handle('app:elevation', async () => {
  const target = alwaysAdminTarget()
  const state = {
    platformOk: process.platform === 'win32',
    elevated: await elevate.isElevated(),
    // 개발 모드에서도 승격 재실행은 된다(electron.exe 를 다시 띄운다)
    canRelaunch: process.platform === 'win32',
    // 항상 관리자로 = 설치본에만 건다
    alwaysAdminAvailable: !!target,
    alwaysAdmin: false,
    exePath: target || process.execPath,
  }
  if (target) {
    const r = await elevate.getAlwaysAdmin(target)
    state.alwaysAdmin = !!r.on
    if (!r.ok) state.error = r.error
  }
  return state
})

/**
 * 관리자 권한으로 다시 연다. 승격 프로세스가 뜬 것을 확인한 **뒤에** 이쪽을 닫는다 —
 * UAC 를 취소하면 { cancelled:true } 만 돌려주고 앱은 그대로 살아 있다.
 */
ipcMain.handle('app:relaunchElevated', async () => {
  const r = await elevate.relaunchElevated()
  if (!r.ok) return r
  // 결과를 화면에 돌려준 다음 닫는다 (지금 닫으면 renderer 가 답을 못 받는다)
  setTimeout(() => {
    isQuitting = true
    app.quit()
  }, 400)
  return { ok: true }
})

ipcMain.handle('app:setAlwaysAdmin', async (_e, on) => {
  const target = alwaysAdminTarget()
  if (!target) return { ok: false, error: '개발 모드에서는 걸 수 없습니다(설치한 앱에서만).' }
  return elevate.setAlwaysAdmin(target, !!on)
})

ipcMain.handle('settings:getHotkey', () => getHotkey())
ipcMain.handle('settings:setHotkey', (_e, hotkey) => {
  if (typeof hotkey !== 'string' || !hotkey.trim()) return { ok: false, error: '잘못된 단축키' }
  const ok = registerHotkey(hotkey)
  if (ok) {
    writeJson(cfgPath(), { ...getConfig(), hotkey })
    return { ok: true }
  }
  registerHotkey(getHotkey()) // 실패 시 기존 것으로 복구
  return { ok: false, error: '단축키 등록 실패 (다른 앱과 충돌일 수 있음)' }
})

ipcMain.handle('snippets:list', () => getSnippets().map((s) => ({ id: s.id, title: s.title })))
ipcMain.handle('snippets:save', (_e, s) => {
  if (!s || typeof s.title !== 'string' || !s.title.trim()) return { ok: false, error: '제목 필요' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'OS 암호화 사용 불가' }
  const list = getSnippets()
  const idx = s.id ? list.findIndex((x) => x.id === s.id) : -1
  const hasContent = typeof s.content === 'string' && s.content.length > 0
  if (idx >= 0) {
    // 편집: 내용 비었으면 기존 유지
    list[idx] = {
      id: list[idx].id,
      title: s.title.trim(),
      enc: hasContent ? safeStorage.encryptString(s.content).toString('base64') : list[idx].enc,
    }
  } else {
    if (!hasContent) return { ok: false, error: '내용 필요' }
    list.push({ id: randomUUID(), title: s.title.trim(), enc: safeStorage.encryptString(s.content).toString('base64') })
  }
  writeJson(snipPath(), list)
  return { ok: true }
})
// 삭제 = 휴지통으로 이동 (암호화된 내용은 그대로 유지 → 복원 가능)
ipcMain.handle('snippets:remove', (_e, id) => {
  const list = getSnippets()
  const s = list.find((x) => x.id === id)
  if (!s) return { ok: false, error: 'not found' }
  writeJson(snipPath(), list.filter((x) => x.id !== id))
  writeJson(snipTrashPath(), [{ ...s, deletedAt: new Date().toISOString() }, ...getSnippetTrash()])
  return { ok: true }
})
ipcMain.handle('snippets:trashList', () =>
  getSnippetTrash().map((s) => ({ id: s.id, title: s.title, deletedAt: s.deletedAt || null })),
)
ipcMain.handle('snippets:restore', (_e, id) => {
  const trash = getSnippetTrash()
  const s = trash.find((x) => x.id === id)
  if (!s) return { ok: false, error: 'not found' }
  writeJson(snipTrashPath(), trash.filter((x) => x.id !== id))
  const { deletedAt, ...clean } = s
  writeJson(snipPath(), [...getSnippets(), clean])
  return { ok: true }
})
ipcMain.handle('snippets:purge', (_e, id) => {
  writeJson(snipTrashPath(), getSnippetTrash().filter((x) => x.id !== id))
  return { ok: true }
})

// ── BTS (Redmine / JIRA) ───────────────────────────────────
ipcMain.handle('bts:getConfig', () => {
  const saved = readJson(btsPath(), {})
  const env = readEnvLocal()
  const r = saved.redmine || {}
  const j = saved.jira || {}
  // 비밀값은 내보내지 않고 "설정됨" 여부만 알린다
  return {
    redmine: {
      url: r.url || env.REDMINE_URL || '',
      insecure: !!r.insecure,
      hasKey: !!(dec(r.keyEnc) || env.REDMINE_API_KEY),
      fromEnv: !r.url && !!env.REDMINE_URL,
    },
    jira: {
      url: j.url || env.JIRA_URL || '',
      email: j.email || env.JIRA_EMAIL || '',
      hasToken: !!(dec(j.tokenEnc) || env.JIRA_API_TOKEN),
      fromEnv: !j.url && !!env.JIRA_URL,
    },
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }
})

ipcMain.handle('bts:setConfig', (_e, cfg) => {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '잘못된 설정' }
  const prev = readJson(btsPath(), {})
  const pr = prev.redmine || {}
  const pj = prev.jira || {}
  const r = cfg.redmine || {}
  const j = cfg.jira || {}

  // 비밀값이 빈 문자열이면 "변경 없음"으로 보고 기존 값을 유지한다
  const keyEnc = r.apiKey ? enc(r.apiKey) : pr.keyEnc
  const tokenEnc = j.token ? enc(j.token) : pj.tokenEnc
  if (r.apiKey && !keyEnc) return { ok: false, error: 'OS 암호화를 사용할 수 없어 API 키를 저장하지 못했습니다.' }
  if (j.token && !tokenEnc) return { ok: false, error: 'OS 암호화를 사용할 수 없어 토큰을 저장하지 못했습니다.' }

  writeJson(btsPath(), {
    redmine: { url: (r.url || '').trim(), insecure: !!r.insecure, keyEnc: keyEnc || null },
    jira: { url: (j.url || '').trim(), email: (j.email || '').trim(), tokenEnc: tokenEnc || null },
  })
  return { ok: true }
})

ipcMain.handle('bts:fetch', () => bts.fetchAll(resolveBtsConfig()))

// ── Perforce + 사내 로컬 LLM ───────────────────────────────
// 워크스페이스 선택은 평문 저장(비밀값 아님), LLM API 키만 safeStorage 로 암호화한다.
// LLM 은 사내망(llm.aquatree.games)이라 diff 를 보내도 회사 밖으로 나가지 않는다.
function resolveP4Config() {
  const saved = readJson(p4CfgPath(), {})
  const env = readEnvLocal()
  return {
    // 접속 정보 — 비워두면 PC 에 설정된 P4PORT/P4USER 를 그대로 쓴다
    port: saved.port || env.P4PORT || '',
    user: saved.user || env.P4USER || '',
    workspace: saved.workspace || env.P4WORKSPACE || '',
    // 서밋 로그 맨 앞 [이름] — 과거 서밋에서 내 것을 골라낼 때도 이 값을 쓴다
    userName: saved.userName || env.P4_USER_NAME || '',
    model: saved.model || 'deepseek-v4-flash-m5max',
    sendDiff: saved.sendDiff !== false, // 기본 켜짐 (사내망이라 안전)
    maxDiffChars: Number(saved.maxDiffChars) || 60000,
    llm: {
      baseUrl: saved.llmBaseUrl || env.LOCAL_LLM_BASE_URL || '',
      apiKey: dec(saved.llmKeyEnc) || env.LOCAL_LLM_API_KEY || '',
    },
  }
}

/** p4 실행 옵션 (접속 정보). 모든 p4 호출에 넘긴다. */
function p4opts(cfg) {
  return { port: cfg.port, user: cfg.user }
}

ipcMain.handle('p4:getConfig', () => {
  const saved = readJson(p4CfgPath(), {})
  const cfg = resolveP4Config()
  return {
    port: cfg.port,
    user: cfg.user,
    workspace: cfg.workspace,
    userName: cfg.userName,
    model: cfg.model,
    sendDiff: cfg.sendDiff,
    maxDiffChars: cfg.maxDiffChars,
    llmBaseUrl: cfg.llm.baseUrl,
    hasLlmKey: !!cfg.llm.apiKey,
    llmFromEnv: !saved.llmBaseUrl && !!readEnvLocal().LOCAL_LLM_BASE_URL,
    hostname: p4.hostname(),
  }
})

ipcMain.handle('p4:setConfig', (_e, cfg) => {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '잘못된 설정' }
  const prev = readJson(p4CfgPath(), {})
  const keyEnc = cfg.llmApiKey ? enc(cfg.llmApiKey) : prev.llmKeyEnc
  if (cfg.llmApiKey && !keyEnc) return { ok: false, error: 'OS 암호화를 사용할 수 없어 키를 저장하지 못했습니다.' }

  writeJson(p4CfgPath(), {
    port: (cfg.port || '').trim(),
    user: (cfg.user || '').trim(),
    workspace: (cfg.workspace || '').trim(),
    userName: (cfg.userName || '').trim(),
    model: (cfg.model || '').trim() || 'deepseek-v4-flash-m5max',
    sendDiff: cfg.sendDiff !== false,
    maxDiffChars: Number(cfg.maxDiffChars) || 60000,
    llmBaseUrl: (cfg.llmBaseUrl || '').trim(),
    llmKeyEnc: keyEnc || null,
  })
  return { ok: true }
})

/** 접속 확인 — 설정 화면의 "연결 테스트". */
ipcMain.handle('p4:info', async () => {
  const cfg = resolveP4Config()
  try {
    return { ok: true, info: await p4.info(p4opts(cfg)) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p4:workspaces', async () => {
  const cfg = resolveP4Config()
  try {
    const opts = p4opts(cfg)
    const me = await p4.info(opts)
    const user = cfg.user || me.user
    return { ok: true, hostname: p4.hostname(), user, workspaces: await p4.listWorkspaces(user, opts) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p4:pending', async () => {
  const cfg = resolveP4Config()
  if (!cfg.workspace) return { ok: false, error: '워크스페이스가 선택되지 않았습니다. 설정에서 고르세요.' }
  try {
    // 선택한 워크스페이스로만 조회한다 — 다른 사람 체인지리스트는 나오지 않는다
    const res = await p4.pending(cfg.workspace, p4opts(cfg))
    return { ok: true, workspace: cfg.workspace, ...res }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p4:reopen', async (_e, { files, toChange }) => {
  const cfg = resolveP4Config()
  if (!cfg.workspace) return { ok: false, error: '워크스페이스가 선택되지 않았습니다.' }
  if (!Array.isArray(files) || !files.length) return { ok: false, error: '옮길 파일이 없습니다.' }
  try {
    return { ok: true, ...(await p4.reopen(cfg.workspace, files, toChange, p4opts(cfg))) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p4:createChange', async (_e, description) => {
  const cfg = resolveP4Config()
  if (!cfg.workspace) return { ok: false, error: '워크스페이스가 선택되지 않았습니다.' }
  try {
    return { ok: true, change: await p4.createChange(cfg.workspace, description, p4opts(cfg)) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('p4:setDescription', async (_e, { change, description }) => {
  const cfg = resolveP4Config()
  if (!cfg.workspace) return { ok: false, error: '워크스페이스가 선택되지 않았습니다.' }
  try {
    await p4.setDescription(cfg.workspace, change, description, p4opts(cfg))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('llm:models', async () => {
  const cfg = resolveP4Config()
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) return { ok: false, error: 'LLM 접속 정보가 없습니다. 설정을 확인하세요.' }
  try {
    return { ok: true, models: await llm.listModels(cfg.llm) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

/** 선택한 체인지리스트의 서밋 로그를 사내 LLM 으로 작성한다. */
ipcMain.handle('llm:submitLog', async (_e, { change, files, description, sendDiff }) => {
  const cfg = resolveP4Config()
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) return { ok: false, error: 'LLM 접속 정보가 없습니다. 설정을 확인하세요.' }

  const useDiff = sendDiff == null ? cfg.sendDiff : !!sendDiff
  let diffRes = { diff: '', added: [], deleted: [], binary: [], truncated: false, error: null }
  if (useDiff && cfg.workspace && Array.isArray(files) && files.length) {
    try {
      diffRes = await p4.diffForChange(cfg.workspace, change, files, { ...p4opts(cfg), maxChars: cfg.maxDiffChars })
    } catch (e) {
      diffRes.error = e instanceof Error ? e.message : String(e)
    }
  } else if (Array.isArray(files)) {
    diffRes.binary = files.filter(p4.isBinary).map((f) => f.depotFile)
  }

  // 이 파일들에 대한 내 과거 서밋 → [컨텐츠명] · 작업번호를 여기서 따온다
  let history = []
  if (cfg.workspace && cfg.userName && Array.isArray(files) && files.length) {
    history = await p4.fileHistory(
      cfg.workspace,
      files.filter((f) => !/add/i.test(f.action)).map((f) => f.depotFile),
      p4opts(cfg),
    )
  }

  try {
    const log = await llm.writeSubmitLog(cfg.llm, {
      model: cfg.model,
      userName: cfg.userName,
      history,
      files,
      existingDescription: description,
      diff: diffRes.diff,
      added: diffRes.added,
      deleted: diffRes.deleted,
      binary: diffRes.binary,
      truncated: diffRes.truncated,
      diffError: diffRes.error,
    })
    return {
      ok: true,
      ...log,
      diffUsed: !!diffRes.diff,
      diffTruncated: diffRes.truncated,
      diffError: diffRes.error,
      binaryCount: (diffRes.binary || []).length,
      historyCount: llm.historyHints(history, cfg.userName).mine.length,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── AI 코드 리뷰 (Windows 전용) ────────────────────────────
// 같은 CL diff 를 설정에 켜 둔 리뷰어들에게 동시에 보내고, 결과를 md 한 벌로 로컬에 남긴다.
// codex/claude 는 CLI 를 그대로 실행한다 — API 키가 아니라 이미 로그인해 둔 구독 계정으로 돈다.
//
// ⚠ codex/claude 는 사외 서비스다. 켜는 순간 회사 코드가 밖으로 나간다는 뜻이라
//   기본값은 사내 LLM 하나뿐이고, 화면에서도 사내/사외를 구분해 표시한다.

function defaultReviewDir() {
  return path.join(app.getPath('userData'), 'reviews')
}

/** codex 가 평소 쓰는 모델 — 설정 화면 placeholder 로 보여준다. */
function codexDefaultModel() {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const m = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

const DEFAULT_REVIEWERS = [{ id: 'local-1', kind: 'local', model: '', effort: '', enabled: true }]

function resolveReviewConfig() {
  const saved = readJson(reviewCfgPath(), {})
  const p4cfg = resolveP4Config()
  const list = Array.isArray(saved.reviewers) && saved.reviewers.length ? saved.reviewers : DEFAULT_REVIEWERS
  return {
    dir: (saved.dir || '').trim() || defaultReviewDir(),
    dirIsDefault: !(saved.dir || '').trim(),
    codexPath: (saved.codexPath || '').trim(),
    claudePath: (saved.claudePath || '').trim(),
    maxDiffChars: Number(saved.maxDiffChars) || 120000,
    timeoutMin: Math.min(60, Math.max(1, Number(saved.timeoutMin) || 15)),
    includeNewFiles: saved.includeNewFiles !== false,
    reviewers: list.map((r, i) => ({
      id: String(r.id || `r${i + 1}`),
      kind: review.KINDS[r.kind] ? r.kind : 'local',
      model: String(r.model || '').trim(),
      effort: String(r.effort || '').trim(),
      enabled: r.enabled !== false,
    })),
    // 사내 LLM 리뷰어는 모델을 안 고르면 Perforce 설정의 모델을 그대로 쓴다
    localModel: p4cfg.model,
    llm: p4cfg.llm,
  }
}

/** 리뷰어 하나가 실제로 쓸 모델 이름 (빈 값이면 CLI 기본값에 맡긴다). */
function modelFor(r, cfg) {
  if (r.kind === 'local') return r.model || cfg.localModel
  return r.model
}

/** 진행 중인 리뷰 — 취소하려면 자식 프로세스를 들고 있어야 한다. */
const activeRuns = new Map()

ipcMain.handle('review:getConfig', () => {
  const cfg = resolveReviewConfig()
  return {
    platformOk: process.platform === 'win32',
    dir: cfg.dir,
    dirIsDefault: cfg.dirIsDefault,
    defaultDir: defaultReviewDir(),
    maxDiffChars: cfg.maxDiffChars,
    timeoutMin: cfg.timeoutMin,
    includeNewFiles: cfg.includeNewFiles,
    reviewers: cfg.reviewers,
    kinds: review.KINDS,
    cli: {
      codex: { ...review.resolveCli('codex', cfg.codexPath), configured: cfg.codexPath },
      claude: { ...review.resolveCli('claude', cfg.claudePath), configured: cfg.claudePath },
    },
    codexDefaultModel: codexDefaultModel(),
    localModel: cfg.localModel,
    localReady: !!(cfg.llm.baseUrl && cfg.llm.apiKey),
  }
})

ipcMain.handle('review:setConfig', (_e, cfg) => {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '잘못된 설정' }
  const reviewers = (Array.isArray(cfg.reviewers) ? cfg.reviewers : []).map((r, i) => ({
    id: String(r.id || `r${i + 1}`),
    kind: review.KINDS[r.kind] ? r.kind : 'local',
    model: String(r.model || '').trim(),
    effort: String(r.effort || '').trim(),
    enabled: r.enabled !== false,
  }))
  writeJson(reviewCfgPath(), {
    dir: (cfg.dir || '').trim(),
    codexPath: (cfg.codexPath || '').trim(),
    claudePath: (cfg.claudePath || '').trim(),
    maxDiffChars: Number(cfg.maxDiffChars) || 120000,
    timeoutMin: Math.min(60, Math.max(1, Number(cfg.timeoutMin) || 15)),
    includeNewFiles: cfg.includeNewFiles !== false,
    reviewers,
  })
  return { ok: true }
})

ipcMain.handle('review:pickDir', async () => {
  const cur = resolveReviewConfig().dir
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '리뷰를 저장할 폴더',
    defaultPath: fs.existsSync(cur) ? cur : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (r.canceled || !r.filePaths.length) return { ok: false }
  return { ok: true, dir: r.filePaths[0] }
})

ipcMain.handle('review:list', (_e, change) => {
  const cfg = resolveReviewConfig()
  return { ok: true, dir: cfg.dir, reviews: reviewStore.list(cfg.dir, { change: change ?? null }) }
})

ipcMain.handle('review:counts', () => {
  const cfg = resolveReviewConfig()
  return { ok: true, counts: reviewStore.counts(cfg.dir) }
})

ipcMain.handle('review:read', (_e, file) => reviewStore.read(resolveReviewConfig().dir, file))
ipcMain.handle('review:delete', (_e, file) => reviewStore.remove(resolveReviewConfig().dir, file))

ipcMain.handle('review:openDir', async () => {
  const dir = reviewStore.ensureDir(resolveReviewConfig().dir)
  const err = await shell.openPath(dir)
  return { ok: !err, error: err || undefined }
})

ipcMain.handle('review:openFile', async (_e, file) => {
  const cfg = resolveReviewConfig()
  const p = reviewStore.safePath(cfg.dir, file)
  if (!p) return { ok: false, error: '잘못된 파일 이름입니다.' }
  const err = await shell.openPath(p)
  return { ok: !err, error: err || undefined }
})

ipcMain.handle('review:cancel', (_e, runId) => {
  const run = activeRuns.get(runId)
  if (!run) return { ok: false, error: '진행 중인 리뷰가 없습니다.' }
  run.cancelled = true
  for (const c of run.children) review.killTree(c)
  return { ok: true }
})

ipcMain.handle('review:run', async (e, payload) => {
  if (process.platform !== 'win32') return { ok: false, error: '이 기능은 Windows 에서만 동작합니다.' }

  const runId = String((payload && payload.runId) || randomUUID())
  const change = String((payload && payload.change) || '')
  const cfg = resolveReviewConfig()
  const p4cfg = resolveP4Config()

  if (!p4cfg.workspace) return { ok: false, error: '워크스페이스가 선택되지 않았습니다. 설정에서 고르세요.' }
  const reviewers = cfg.reviewers.filter((r) => r.enabled)
  if (!reviewers.length) return { ok: false, error: '설정 → AI 코드 리뷰 에서 리뷰 모델을 하나 이상 켜세요.' }

  // 렌더러가 넘긴 파일 목록을 믿지 않고 다시 조회한다 — 신규 파일을 읽으려면 로컬 경로가 필요하고,
  // 리뷰 도중 파일이 바뀌었을 수도 있다.
  let target = null
  try {
    const { changes } = await p4.pending(p4cfg.workspace, p4opts(p4cfg))
    target = changes.find((c) => String(c.change) === change) || null
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!target) return { ok: false, error: `${change === 'default' ? 'default' : `CL ${change}`} 을(를) 찾지 못했습니다. 새로고침해 보세요.` }
  if (!target.files.length) return { ok: false, error: '파일이 없는 체인지리스트는 리뷰할 수 없습니다.' }

  // diff — 서밋 로그보다 훨씬 넉넉하게 가져온다 (리뷰는 내용을 봐야 한다)
  let diffRes = { diff: '', added: [], deleted: [], binary: [], truncated: false, error: null }
  try {
    diffRes = await p4.diffForChange(p4cfg.workspace, change, target.files, {
      ...p4opts(p4cfg),
      maxChars: cfg.maxDiffChars,
    })
  } catch (err) {
    diffRes.error = err instanceof Error ? err.message : String(err)
  }
  const newFiles = cfg.includeNewFiles ? p4.readNewFiles(target.files) : []

  const prompt = review.buildReviewPrompt({
    change,
    description: target.description,
    workspace: p4cfg.workspace,
    files: target.files,
    diff: diffRes.diff,
    added: diffRes.added,
    deleted: diffRes.deleted,
    binary: diffRes.binary,
    newFiles,
    truncated: diffRes.truncated,
    diffError: diffRes.error,
  })

  const tmpDir = reviewStore.ensureDir(path.join(app.getPath('temp'), 'meos-review'))
  const run = { children: new Set(), cancelled: false }
  activeRuns.set(runId, run)

  const send = (msg) => {
    if (!e.sender.isDestroyed()) e.sender.send('review:progress', { runId, ...msg })
  }
  send({ phase: 'start', promptChars: prompt.length, reviewers: reviewers.map((r) => r.id) })

  const ctx = {
    cli: {
      codex: review.resolveCli('codex', cfg.codexPath),
      claude: review.resolveCli('claude', cfg.claudePath),
    },
    llmCfg: cfg.llm,
    timeoutMs: cfg.timeoutMin * 60000,
    tmpDir,
    onChild: (c) => run.children.add(c),
  }

  const results = await Promise.all(
    reviewers.map(async (r) => {
      const spec = { ...r, model: modelFor(r, cfg) }
      const label = review.reviewerLabel(spec)
      send({ phase: 'running', id: r.id, kind: r.kind, label })
      const res = await review.runReviewer(prompt, spec, ctx)
      send({ phase: res.ok ? 'done' : 'error', id: r.id, kind: r.kind, label, ms: res.ms, error: res.error || null })
      return { ...res, id: r.id, kind: r.kind, label }
    }),
  )

  activeRuns.delete(runId)
  if (run.cancelled) return { ok: false, cancelled: true, error: '리뷰를 취소했습니다.' }

  const at = new Date()
  const md = review.renderReviewMarkdown({
    change,
    description: target.description,
    workspace: p4cfg.workspace,
    files: target.files,
    results,
    diffMeta: { truncated: diffRes.truncated, binaryCount: (diffRes.binary || []).length },
    at,
  })

  let saved
  try {
    saved = reviewStore.save(cfg.dir, change, md, at)
  } catch (err) {
    return { ok: false, error: `리뷰는 끝났지만 파일 저장에 실패했습니다: ${err instanceof Error ? err.message : String(err)}` }
  }

  return {
    ok: true,
    file: saved.file,
    dir: cfg.dir,
    text: md,
    diffChars: (diffRes.diff || '').length,
    diffTruncated: diffRes.truncated,
    diffError: diffRes.error,
    newFileCount: newFiles.filter((n) => n.text).length,
    entries: results.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      ok: r.ok,
      ms: r.ms,
      error: r.error || null,
      chars: r.ok ? r.text.length : 0,
    })),
  }
})

/** BTS 새 이슈 등록 페이지를 외부 브라우저로 연다 (앱에서 쓰기는 하지 않음). */
ipcMain.handle('bts:openNew', async (_e, system) => {
  const cfg = resolveBtsConfig()
  const base = system === 'jira' ? cfg.jira.url : cfg.redmine.url
  if (!base) return { ok: false, error: '접속 정보가 설정되지 않았습니다.' }
  // Redmine 은 새 이슈 폼 주소가 정해져 있고, JIRA 는 프로젝트마다 달라 대시보드를 연다
  const url = system === 'jira' ? base.replace(/\/+$/, '') : `${base.replace(/\/+$/, '')}/issues/new`
  await shell.openExternal(url)
  return { ok: true }
})
ipcMain.handle('snippets:copy', (_e, id) => {
  const s = getSnippets().find((x) => x.id === id)
  if (!s) return { ok: false, error: 'not found' }
  try {
    clipboard.writeText(safeStorage.decryptString(Buffer.from(s.enc, 'base64')))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// 편집용: 복호화된 내용 반환 (편집 시에만 평문 노출)
ipcMain.handle('snippets:reveal', (_e, id) => {
  const s = getSnippets().find((x) => x.id === id)
  if (!s) return { ok: false, error: 'not found' }
  try {
    return { ok: true, content: safeStorage.decryptString(Buffer.from(s.enc, 'base64')) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── UE 빌드 감시 (Windows 전용) ────────────────────────────
//
// 조회·해석은 uebuild.js(순수 Node)가 한다. 여기서는 두 가지만 맡는다.
//   1) 엔진 경로를 정하는 일 — 설정값 > 도는 빌드에서 알아낸 값 > 등록된 엔진 중 최근 것
//   2) 로그 파일 열기 (읽기 전용이다 — 빌드를 걸거나 죽이지 않는다)
//
// ⚠️ 알아낸 엔진 경로는 **설정에 적어 둔다.** 빌드가 도는 동안에만 알 수 있는 값인데,
//    기억해 두지 않으면 빌드가 끝난 뒤 "마지막 빌드가 뭐였나" 를 못 읽는다.

function uebuildCfgPath() {
  return path.join(app.getPath('userData'), 'pp-uebuild.json')
}

function resolveUeConfig() {
  const saved = readJson(uebuildCfgPath(), {})
  return {
    engineRoot: (saved.engineRoot || '').trim(),
    /** 화면이 몇 초마다 다시 물을지. 조회 한 번이 2초 남짓이라 너무 짧으면 계속 겹친다. */
    pollSec: Math.min(60, Math.max(3, Number(saved.pollSec) || 6)),
  }
}

function saveUeConfig(next) {
  writeJson(uebuildCfgPath(), { engineRoot: next.engineRoot, pollSec: next.pollSec })
}

ipcMain.handle('uebuild:getConfig', async () => {
  const cfg = resolveUeConfig()
  const engines = await uebuild.listEngines()
  // 설정이 비어 있으면 **가장 최근에 빌드한 엔진**을 골라 둔다 (사용자가 아무것도 안 해도 된다)
  let engineRoot = cfg.engineRoot
  if (!engineRoot && engines.length) {
    engineRoot = engines[0].root
    saveUeConfig({ ...cfg, engineRoot })
  }
  return {
    platformOk: process.platform === 'win32',
    engineRoot,
    engineRootSaved: cfg.engineRoot,
    pollSec: cfg.pollSec,
    engines,
  }
})

ipcMain.handle('uebuild:setConfig', (_e, next) => {
  if (!next || typeof next !== 'object') return { ok: false, error: '잘못된 설정' }
  const cur = resolveUeConfig()
  saveUeConfig({
    engineRoot: typeof next.engineRoot === 'string' ? next.engineRoot.trim() : cur.engineRoot,
    pollSec: Math.min(60, Math.max(3, Number(next.pollSec) || cur.pollSec)),
  })
  return { ok: true }
})

ipcMain.handle('uebuild:status', async () => {
  const cfg = resolveUeConfig()
  const snap = await uebuild.snapshot({ engineRoot: cfg.engineRoot, selfPid: process.pid })
  // 도는 빌드에서 엔진 경로를 알아냈고 저장값과 다르면 갱신한다 — 엔진을 옮겨도 따라온다
  if (snap.ok && snap.engineRootDetected && snap.engineRootDetected !== cfg.engineRoot) {
    saveUeConfig({ ...cfg, engineRoot: snap.engineRootDetected })
  }
  return snap
})

ipcMain.handle('uebuild:pickEngine', async () => {
  const cur = resolveUeConfig().engineRoot
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '엔진 폴더 — Engine 의 부모를 고릅니다 (예: D:\\Work\\TT\\UE\\5.5)',
    defaultPath: cur && fs.existsSync(cur) ? cur : app.getPath('home'),
    properties: ['openDirectory'],
  })
  if (r.canceled || !r.filePaths.length) return { ok: false }
  return { ok: true, dir: r.filePaths[0] }
})

ipcMain.handle('uebuild:openLog', async () => {
  const { engineRoot } = resolveUeConfig()
  if (!engineRoot) return { ok: false, error: '엔진 경로가 정해지지 않았습니다.' }
  const file = uebuild.ubtLogPath(engineRoot)
  if (!fs.existsSync(file)) return { ok: false, error: '로그 파일이 없습니다.' }
  const err = await shell.openPath(file)
  return err ? { ok: false, error: err } : { ok: true }
})

ipcMain.handle('uebuild:revealLog', () => {
  const { engineRoot } = resolveUeConfig()
  if (!engineRoot) return { ok: false, error: '엔진 경로가 정해지지 않았습니다.' }
  const file = uebuild.ubtLogPath(engineRoot)
  if (!fs.existsSync(file)) return { ok: false, error: '로그 파일이 없습니다.' }
  shell.showItemInFolder(file)
  return { ok: true }
})

// ── 디스크 정리 (Windows 전용) ─────────────────────────────
//
// 스캔·판정은 disk.js(순수 Node)가 하고, 여기서는 세 가지만 맡는다.
//   1) 오래 도는 작업의 진행 상황·취소 (스캔 하나가 수 분이다)
//   2) 사내 LLM 호출 (Perforce 와 같은 접속 정보를 쓴다 — 경로 목록이 회사 밖으로 안 나간다)
//   3) 실제 삭제 — **휴지통으로만** 보낸다
//
// ⚠️ 삭제는 화면이 보낸 목록을 믿지 않는다. 이번 세션에 스캔한 루트 안인지, 보호 대상은
//    아닌지 여기서 다시 검사한다. AI 가 무슨 말을 했든 이 관문은 통과해야 한다.
const diskRuns = new Map() // runId → {cancelled}
/** 이번에 스캔한 루트들. 삭제 허용 범위의 근거다(앱을 켠 뒤 스캔한 곳만 지울 수 있다). */
const diskScanned = new Set()

function diskCfgPath() {
  return path.join(app.getPath('userData'), 'pp-disk.json')
}
/** 스캔 이력 폴더 (스캔 1회 = json 두 벌). */
function diskDir() {
  return path.join(app.getPath('userData'), 'disk-scans')
}

function resolveDiskConfig() {
  const saved = readJson(diskCfgPath(), {})
  const p4cfg = resolveP4Config()
  return {
    lastRoot: (saved.lastRoot || '').trim(),
    maxDepth: Math.min(8, Math.max(1, Number(saved.maxDepth) || 3)),
    skipSystem: saved.skipSystem !== false,
    model: (saved.model || '').trim() || p4cfg.model,
    llm: p4cfg.llm,
  }
}

ipcMain.handle('disk:getConfig', async () => {
  const cfg = resolveDiskConfig()
  return {
    platformOk: process.platform === 'win32',
    lastRoot: cfg.lastRoot,
    maxDepth: cfg.maxDepth,
    skipSystem: cfg.skipSystem,
    model: cfg.model,
    llmReady: !!(cfg.llm.baseUrl && cfg.llm.apiKey),
    drives: await disk.listDrives(),
  }
})

ipcMain.handle('disk:setConfig', (_e, cfg) => {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '잘못된 설정' }
  writeJson(diskCfgPath(), {
    lastRoot: (cfg.lastRoot || '').trim(),
    maxDepth: Math.min(8, Math.max(1, Number(cfg.maxDepth) || 3)),
    skipSystem: cfg.skipSystem !== false,
    model: (cfg.model || '').trim(),
  })
  return { ok: true }
})

ipcMain.handle('disk:pickDir', async () => {
  const cur = resolveDiskConfig().lastRoot
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '스캔할 폴더 (드라이브를 고르면 전체를 훑습니다)',
    defaultPath: cur && fs.existsSync(cur) ? cur : app.getPath('home'),
    properties: ['openDirectory'],
  })
  if (r.canceled || !r.filePaths.length) return { ok: false }
  return { ok: true, dir: r.filePaths[0] }
})

/**
 * 폴더 스캔. 무거운 동기 작업이라 도는 동안 이 프로세스는 다른 IPC 를 못 받는다 —
 * 그래서 취소 신호는 미리 만들어 둔 객체를 통해 전달한다(disk:cancel 이 그 값을 바꾼다).
 *
 * ⚠️ 진행 상황을 sender 로 보내는 것도 같은 이유로 setImmediate 없이 동기 흐름 안에서 나간다.
 *    Electron 은 send 를 큐에 넣어 주므로 스캔이 끝난 뒤 한꺼번에 도착할 수 있다 —
 *    화면에서는 "마지막 값" 만 의미 있게 쓴다.
 */
ipcMain.handle('disk:scan', async (e, payload) => {
  const { runId, root, maxDepth, skipSystem } = payload || {}
  if (process.platform !== 'win32') return { ok: false, error: '이 기능은 Windows 에서만 동작합니다.' }
  if (!root || !fs.existsSync(root)) return { ok: false, error: '폴더를 찾을 수 없습니다.' }

  const state = { cancelled: false }
  diskRuns.set(runId, state)
  const send = (phase, data) => {
    if (!e.sender.isDestroyed()) e.sender.send('disk:progress', { runId, phase, ...data })
  }

  try {
    send('start', { root })
    const scan = await disk.scanTree(root, {
      maxDepth: Math.min(8, Math.max(1, Number(maxDepth) || 3)),
      skipSystem: skipSystem !== false,
      state,
      onProgress: (p) => send('scan', p),
    })
    if (!scan.node) return { ok: false, error: '폴더를 읽지 못했습니다(권한 확인).' }
    if (scan.cancelled) return { ok: false, cancelled: true }

    const candidates = disk.collectCandidates(scan)
    const unknowns = disk.unknownBigDirs(scan, candidates)
    const old = disk.oldBigDirs(scan)
    diskScanned.add(root)

    writeJson(diskCfgPath(), { ...readJson(diskCfgPath(), {}), lastRoot: root })
    send('done', {})
    const result = {
      ok: true,
      root,
      tree: scan.node,
      stats: scan.stats,
      projects: scan.projects,
      engines: scan.engines,
      exts: scan.exts.slice(0, 40),
      bigFiles: scan.bigFiles,
      ages: scan.ages,
      oldDirs: old,
      candidates,
      unknowns,
    }

    // 끝난 스캔은 무조건 남긴다. 화면을 옮겼다 와도 다시 6분을 쓰지 않도록,
    // 그리고 지난 스캔과 비교할 수 있도록. (저장 실패가 스캔 결과를 버리게 두지 않는다)
    try {
      result.saved = diskStore.save(diskDir(), result)
    } catch (e) {
      console.error('[disk] 이력 저장 실패', e.message)
    }
    return result
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    diskRuns.delete(runId)
  }
})

// ── 스캔 이력 ──────────────────────────────────────────────
ipcMain.handle('disk:history', () => ({ ok: true, dir: diskDir(), items: diskStore.list(diskDir()) }))

ipcMain.handle('disk:historyRead', (_e, id) => {
  const r = diskStore.read(diskDir(), id)
  if (!r) return { ok: false, error: '이력을 찾을 수 없습니다.' }
  // 지난 스캔을 불러와도 그 안의 항목을 지울 수 있어야 한다 —
  // 삭제 허용 범위(이번 세션에 스캔한 루트)에 그 루트를 다시 넣어 준다.
  if (r.root) diskScanned.add(r.root)
  return { ok: true, scan: r }
})

ipcMain.handle('disk:historyRemove', (_e, id) => ({ ok: diskStore.remove(diskDir(), id) }))

ipcMain.handle('disk:historyOpenDir', async () => {
  const err = await shell.openPath(diskStore.ensureDir(diskDir()))
  return { ok: !err, error: err || undefined }
})

/** 중복 파일 — 디스크를 실제로 읽는 단계가 있어 스캔과 따로 돌린다. */
ipcMain.handle('disk:duplicates', async (e, payload) => {
  const { runId, root, minMB } = payload || {}
  if (!root || !fs.existsSync(root)) return { ok: false, error: '폴더를 찾을 수 없습니다.' }
  const state = { cancelled: false }
  diskRuns.set(runId, state)
  try {
    const r = await disk.findDuplicates(root, {
      minBytes: Math.max(1, Number(minMB) || 8) * 1024 * 1024,
      state,
      onProgress: (p) => {
        if (!e.sender.isDestroyed()) e.sender.send('disk:progress', { runId, phase: 'dup', ...p })
      },
    })
    if (r.cancelled) return { ok: false, cancelled: true }
    diskScanned.add(root)
    return { ok: true, ...r }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    diskRuns.delete(runId)
  }
})

ipcMain.handle('disk:cancel', (_e, runId) => {
  const st = diskRuns.get(runId)
  if (!st) return { ok: false, error: '진행 중인 작업이 없습니다.' }
  st.cancelled = true
  return { ok: true }
})

/** 정리 후보를 사내 LLM 에게 판정시킨다. 보내는 건 경로·크기뿐 — 파일 내용은 안 나간다. */
ipcMain.handle('disk:judge', async (_e, payload) => {
  const cfg = resolveDiskConfig()
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
    return { ok: false, error: 'LLM 접속 정보가 없습니다. Perforce 설정에서 사내 LLM 을 먼저 설정하세요.' }
  }
  // 실제 UE 프로젝트를 스캔하면 후보가 70건을 넘는다(플러그인마다 Intermediate·Binaries).
  // 전부 물으면 답이 max_tokens 에서 잘려 절반이 판정 없이 돌아온다 — 큰 것부터 끊는다.
  const JUDGE_LIMIT = 40
  const all = Array.isArray(payload?.candidates) ? payload.candidates : []
  const candidates = all.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, JUDGE_LIMIT)
  const unknowns = (Array.isArray(payload?.unknowns) ? payload.unknowns : []).slice(0, 12)
  if (!candidates.length && !unknowns.length) return { ok: false, error: '판정할 항목이 없습니다.' }

  const prompt = disk.buildJudgePrompt({
    candidates,
    unknowns,
    projects: payload?.projects || [],
    engines: payload?.engines || [],
    drive: payload?.drive || null,
  })
  try {
    const res = await llm.chat(cfg.llm, {
      model: cfg.model,
      messages: [
        { role: 'system', content: disk.JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      maxTokens: 6000,
      jsonMode: true,
      timeoutMs: 240000,
    })
    // ⚠️ extractJson 은 **문자열**을 돌려준다(코드펜스·잡소리를 걷어낸 JSON 본문).
    //    파싱은 여기서 한다 — 모델은 jsonMode 를 켜도 ```json 펜스를 붙여 보낸다(실측).
    let json = null
    try {
      json = JSON.parse(llm.extractJson(res.content))
    } catch {
      /* 아래에서 처리 */
    }
    if (!json || !Array.isArray(json.verdicts)) {
      return { ok: false, error: 'LLM 응답을 읽지 못했습니다.', raw: String(res.content || '').slice(0, 400) }
    }
    // 규칙 항목과 정체불명 항목을 한 번에 물었으니, 합칠 때도 한 번에 합친다
    const merged = disk.mergeVerdicts(
      [...candidates, ...unknowns.map((u) => ({ ...u, source: 'unknown', risk: 'caution' }))],
      json.verdicts,
    )
    // 잘려 나간 후보는 규칙 판정 그대로 돌려준다 — 목록에서 사라지면 안 된다
    const rest = all.filter((c) => !candidates.some((x) => disk.norm(x.path) === disk.norm(c.path)))
    return {
      ok: true,
      items: [...merged, ...rest],
      judged: candidates.length + unknowns.length,
      skipped: all.length - candidates.length,
      model: res.model,
      usage: res.usage,
      promptChars: prompt.length,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/**
 * 지운다. 기본은 휴지통(mode 'trash')이고, 'permanent' 는 **휴지통이 거절한 항목을 보고**
 * 사용자가 직접 다시 누를 때만 온다 — 화면이 그 버튼을 실패 뒤에만 띄운다.
 *
 * 어느 쪽이든 관문은 같다: 이번 세션에 스캔한 루트 안인지, 보호 대상은 아닌지
 * (disk.validateDeletion). AI 판정도 화면의 목록도 이 관문을 대신하지 못한다.
 *
 * 휴지통이 실패하면 이유를 되짚어 준다. shell.trashItem 은 실패 이유를 안 알려 주고
 * "Failed to perform delete operation" 한 줄만 준다 — 그대로 보여 주면 사용자가 할 게 없다.
 */
ipcMain.handle('disk:trash', async (_e, payload) => {
  // [{path, size}] — size 는 스캔 때 이미 잰 값이다. 여기서 다시 재지 않는다:
  // 224GB Intermediate 를 지우기 전에 크기를 다시 세면 삭제가 시작되기까지 수십 초가 걸린다.
  // (표시용 숫자라 화면이 준 값을 그대로 쓴다 — 삭제 여부는 아래 검증이 따로 정한다)
  const items = Array.isArray(payload?.items) ? payload.items : []
  if (!items.length) return { ok: false, error: '지울 항목이 없습니다.' }
  const permanent = payload?.mode === 'permanent'
  const elevated = await elevate.isElevated()
  const roots = [...diskScanned]
  const results = []
  let freed = 0
  for (const it of items) {
    const p = typeof it === 'string' ? it : it && it.path
    const size = (typeof it === 'object' && Number(it.size)) || 0
    const bad = disk.validateDeletion(p, roots)
    if (bad) {
      results.push({ path: p, ok: false, error: bad })
      continue
    }
    if (permanent) {
      try {
        await disk.removeForever(p)
        freed += size
        results.push({ path: p, ok: true, size, permanent: true })
      } catch (err) {
        const code = err && err.code
        const denied = code === 'EPERM' || code === 'EACCES'
        results.push({
          path: p,
          ok: false,
          needsAdmin: denied && !elevated,
          error: denied
            ? elevated
              ? '관리자 권한으로도 지울 수 없습니다(소유자가 다르거나 정책으로 잠긴 폴더).'
              : '권한이 부족합니다 — 관리자 권한으로 다시 실행한 뒤 지우세요.'
            : code === 'EBUSY'
              ? '다른 프로그램이 쓰는 중입니다(에디터·빌드 등을 닫고 다시 시도).'
              : err instanceof Error
                ? err.message
                : String(err),
        })
      }
      continue
    }
    try {
      await shell.trashItem(p)
      freed += size
      results.push({ path: p, ok: true, size })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const d = await disk.diagnoseTrashFailure(p, size, { elevated })
      results.push({ path: p, ok: false, error: d.message, needsAdmin: d.needsAdmin, permanentOnly: d.permanentOnly, raw })
    }
  }
  return { ok: results.some((r) => r.ok), results, freed, elevated, permanent }
})

ipcMain.handle('disk:reveal', async (_e, p) => {
  if (!p || typeof p !== 'string') return { ok: false, error: '경로가 없습니다.' }
  shell.showItemInFolder(p)
  return { ok: true }
})

// 창 컨트롤 (커스텀 타이틀바)
ipcMain.on('win:minimize', () => mainWindow?.minimize())
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('win:close-to-tray', () => mainWindow?.hide())
ipcMain.on('win:quit', () => {
  isQuitting = true
  app.quit()
})

// ── 단일 인스턴스 ──────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) deliverAuthUrl(url)
    showMain()
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    deliverAuthUrl(url)
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null) // File/Edit 등 기본 메뉴바 제거
    await clearWebCache() // 앱을 다시 켜면 항상 최신 화면이 뜨도록
    createWindow()
    createTray()
    registerHotkey(getHotkey())

    const url = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) deliverAuthUrl(url)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMain()
    })
  })

  // 트레이 상주: 창을 모두 닫아도 자동 종료하지 않음 (종료는 트레이 메뉴)
  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    isQuitting = true
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}

// ── 트레이 ─────────────────────────────────────────────────
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'))
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('MeOS')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '열기', click: () => showMain() },
      { label: 'Quick Search', click: () => openQuickSearch() },
      { type: 'separator' },
      { label: '새로 고침 (Ctrl+R)', click: () => mainWindow?.webContents.reload() },
      { label: '캐시 비우고 새로 열기', click: () => void hardReload() },
      { type: 'separator' },
      { label: '종료', click: () => { isQuitting = true; app.quit() } },
    ]),
  )
  tray.on('click', () => showMain())
}

// ── 딥링크 전달 ────────────────────────────────────────────
function deliverAuthUrl(url) {
  pendingAuthUrl = url
  flushAuthUrl()
  if (mainWindow) mainWindow.focus()
}
function flushAuthUrl() {
  if (pendingAuthUrl && mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('auth-callback', pendingAuthUrl)
    pendingAuthUrl = null
  }
}

// ── 앱 로드 / 안내 화면 ────────────────────────────────────
/** 설정된 주소를 창에 띄운다. 주소가 없으면 설정 화면(shell.html)으로 간다. */
function loadApp() {
  if (!mainWindow) return
  const url = resolveAppUrl()
  loadedUrl = url
  if (!url) {
    showShell(null, '')
    return
  }
  mainWindow.loadURL(url)
}

/** 캐시까지 비우고 주소부터 다시 연다 (Ctrl+Shift+R · 트레이 메뉴 · 설정 버튼). */
async function hardReload() {
  await clearWebCache()
  loadApp()
}

/** 주소 입력 / 오류 안내용 로컬 화면. preload 가 붙어 있어 window.desktop 을 그대로 쓴다. */
function showShell(error, url) {
  if (!mainWindow) return
  void mainWindow.loadFile(path.join(__dirname, 'shell.html'), {
    // 개발 모드에선 주소를 저장해도 dev 서버를 쓰므로, 입력칸 대신 안내만 보여준다
    query: { error: error || '', url: url || resolveAppUrl() || '', dev: isDev ? '1' : '' },
  })
}

// ── 메인 창 ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0e0f13',
    icon: path.join(__dirname, 'app-icon.png'), // 작업표시줄/Alt+Tab 아이콘

    titleBarStyle: 'hidden', // 네이티브 타이틀바 숨김(커스텀 타이틀바 사용), 창은 리사이즈 유지
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  loadApp()

  // 새 창 요청: 같은 앱이면 허용, 나머지는 기본 브라우저로 넘긴다
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file://') || (loadedUrl && sameOrigin(url, loadedUrl))) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 원격 페이지에 window.desktop(=p4 실행·파일 열기)이 노출되므로,
  // 창이 앱 주소 밖으로 흘러가지 못하게 막는다. 외부 링크는 브라우저로 보낸다.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://') || (loadedUrl && sameOrigin(url, loadedUrl))) return
    e.preventDefault()
    void shell.openExternal(url)
  })

  // 주소를 못 열었을 때(오프라인·오타·배포 중) 빈 창 대신 안내 화면을 띄운다
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = ERR_ABORTED (새로고침 등, 오류 아님)
    showShell(`${desc || '연결 실패'} (${code})`, url)
  })

  // 기본 메뉴바를 없앤 탓에 새로고침·개발자도구 단축키까지 사라졌다 — 직접 붙인다.
  // (이게 없으면 화면이 낡았을 때 사용자가 할 수 있는 게 없다)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = (input.key || '').toLowerCase()
    const ctrl = input.control || input.meta
    if ((ctrl && key === 'r') || key === 'f5') {
      event.preventDefault()
      if (input.shift) void hardReload()
      else mainWindow.webContents.reload()
    } else if (key === 'f12') {
      event.preventDefault()
      mainWindow.webContents.toggleDevTools()
    }
  })

  mainWindow.webContents.on('did-finish-load', flushAuthUrl)

  // 최대화 상태 변화 → 렌더러(타이틀바 버튼)에 통지
  mainWindow.on('maximize', () => mainWindow.webContents.send('win:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximized', false))

  // X 버튼: 종료 대신 트레이로 숨김
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}
