// Electron ↔ 렌더러 브리지.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,

  // 앱 주소 — 데스크톱 셸은 배포된 웹(Cloudflare)을 띄운다
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    setUrl: (url) => ipcRenderer.invoke('app:setUrl', url),
    // hard=true 면 서비스워커·캐시까지 비우고 다시 연다
    reload: (hard) => ipcRenderer.invoke('app:reload', !!hard),
  },

  // 매직링크 딥링크(privateplanner://auth?code=...) 도착 시 콜백
  onAuthCallback: (cb) => {
    ipcRenderer.on('auth-callback', (_event, url) => cb(url))
  },

  // 바로가기 실행 (웹주소 또는 로컬 앱/파일 경로)
  openShortcut: (target) => ipcRenderer.invoke('open-shortcut', target),

  // Quick Search 열기 요청(전역 단축키/트레이) 수신
  onOpenQuickSearch: (cb) => {
    ipcRenderer.on('open-quick-search', () => cb())
  },

  // 스니펫 (내용은 main에서 safeStorage로 암호화 저장, 복사 시 main에서 복호화→클립보드)
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (s) => ipcRenderer.invoke('snippets:save', s),
    remove: (id) => ipcRenderer.invoke('snippets:remove', id), // → 휴지통
    copy: (id) => ipcRenderer.invoke('snippets:copy', id),
    reveal: (id) => ipcRenderer.invoke('snippets:reveal', id),
    trashList: () => ipcRenderer.invoke('snippets:trashList'),
    restore: (id) => ipcRenderer.invoke('snippets:restore', id),
    purge: (id) => ipcRenderer.invoke('snippets:purge', id),
  },

  // Perforce — 데스크톱 전용. p4 CLI 를 main 에서 실행한다.
  p4: {
    getConfig: () => ipcRenderer.invoke('p4:getConfig'),
    setConfig: (cfg) => ipcRenderer.invoke('p4:setConfig', cfg),
    info: () => ipcRenderer.invoke('p4:info'),
    workspaces: () => ipcRenderer.invoke('p4:workspaces'),
    pending: () => ipcRenderer.invoke('p4:pending'),
    reopen: (files, toChange) => ipcRenderer.invoke('p4:reopen', { files, toChange }),
    createChange: (description) => ipcRenderer.invoke('p4:createChange', description),
    setDescription: (change, description) => ipcRenderer.invoke('p4:setDescription', { change, description }),
  },

  // 사내 로컬 LLM (llm.aquatree.games) — 사내망 안이라 diff 가 회사 밖으로 나가지 않는다.
  llm: {
    models: () => ipcRenderer.invoke('llm:models'),
    submitLog: (payload) => ipcRenderer.invoke('llm:submitLog', payload),
  },

  // AI 코드 리뷰 (Windows 전용) — codex/claude CLI + 사내 LLM. 결과는 로컬 md 파일로 남는다.
  review: {
    getConfig: () => ipcRenderer.invoke('review:getConfig'),
    setConfig: (cfg) => ipcRenderer.invoke('review:setConfig', cfg),
    pickDir: () => ipcRenderer.invoke('review:pickDir'),
    run: (payload) => ipcRenderer.invoke('review:run', payload),
    cancel: (runId) => ipcRenderer.invoke('review:cancel', runId),
    list: (change) => ipcRenderer.invoke('review:list', change ?? null),
    counts: () => ipcRenderer.invoke('review:counts'),
    read: (file) => ipcRenderer.invoke('review:read', file),
    remove: (file) => ipcRenderer.invoke('review:delete', file),
    openDir: () => ipcRenderer.invoke('review:openDir'),
    openFile: (file) => ipcRenderer.invoke('review:openFile', file),
    // 진행 상황 구독. 해제 함수를 돌려준다 (모달이 닫힐 때 떼어내야 한다).
    onProgress: (cb) => {
      const h = (_e, msg) => cb(msg)
      ipcRenderer.on('review:progress', h)
      return () => ipcRenderer.removeListener('review:progress', h)
    },
  },

  // BTS (Redmine / JIRA) — 데스크톱 전용 실시간 조회. 결과는 메모리로만 전달된다.
  bts: {
    getConfig: () => ipcRenderer.invoke('bts:getConfig'),
    setConfig: (cfg) => ipcRenderer.invoke('bts:setConfig', cfg),
    fetch: () => ipcRenderer.invoke('bts:fetch'),
    openNew: (system) => ipcRenderer.invoke('bts:openNew', system),
  },

  // Quick Search 전역 단축키 설정
  settings: {
    getHotkey: () => ipcRenderer.invoke('settings:getHotkey'),
    setHotkey: (hotkey) => ipcRenderer.invoke('settings:setHotkey', hotkey),
  },

  // 창 컨트롤 (커스텀 타이틀바)
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    closeToTray: () => ipcRenderer.send('win:close-to-tray'),
    quit: () => ipcRenderer.send('win:quit'),
    onMaximizeChange: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),
  },
})
