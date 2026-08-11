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
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const bts = require('./bts')
const p4 = require('./p4')
const llm = require('./llm')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
const isDev = !app.isPackaged
const PROTOCOL = 'privateplanner'
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

let mainWindow = null
let tray = null
let pendingAuthUrl = null
let isQuitting = false

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

/** 개발 중에는 저장소 루트 .env.local 을 폴백으로 읽는다 (설정 화면 입력값이 우선). */
function readEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local')
  const out = {}
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    /* 없으면 무시 */
  }
  return out
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

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null) // File/Edit 등 기본 메뉴바 제거
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

  if (isDev) {
    mainWindow.loadURL(DEV_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost') || url.startsWith('file://')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
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
