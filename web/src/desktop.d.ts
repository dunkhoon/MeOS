// Electron preload 가 노출하는 window.desktop 브리지 타입

/** Redmine/JIRA 이슈 (정규화). 데스크톱 메모리에만 존재 — DB 저장 안 함. */
interface BtsIssue {
  key: string // 'redmine:29445' | 'jira:AT-1234'
  system: 'redmine' | 'jira'
  issueId: string
  title: string
  tracker: string // 개발 / 버그 / Task …
  status: string
  version: string | null
  project: string | null
  url: string
  updatedAt: string | null
}

interface BtsSourceState {
  configured: boolean
  count: number
  error: string | null
}

interface BtsResult {
  issues: BtsIssue[]
  sources: { redmine: BtsSourceState; jira: BtsSourceState }
  fetchedAt: string
}

interface BtsConfig {
  redmine: { url: string; insecure: boolean; hasKey: boolean; fromEnv: boolean }
  jira: { url: string; email: string; hasToken: boolean; fromEnv: boolean }
  encryptionAvailable: boolean
}

/** Perforce — 열린 파일 한 건. */
interface P4File {
  depotFile: string
  action: string
  change: string
  type: string
  rev: string
}

interface P4Change {
  change: string // 번호 또는 'default'
  description: string
  time: string | null
  shelved: boolean
  files: P4File[]
}

interface P4Workspace {
  client: string
  root: string
  host: string
  /** Host 잠금상 이 PC에서 쓸 수 있는지 */
  usable: boolean
  description: string
}

interface P4Config {
  port: string
  user: string
  workspace: string
  /** 서밋 로그 맨 앞 [이름] */
  userName: string
  model: string
  sendDiff: boolean
  maxDiffChars: number
  llmBaseUrl: string
  hasLlmKey: boolean
  llmFromEnv: boolean
  hostname: string
}

interface SubmitLogResult {
  ok: boolean
  error?: string
  /** 컨텐츠명 — [이름][컨텐츠] 의 두 번째 칸 */
  content?: string
  /** 작업번호 (숫자만). 이력에서 확인된 것만 채워진다 */
  issue?: string
  items?: string[]
  /** 최종 조립된 로그 텍스트 */
  text?: string
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
  finishReason?: string | null
  truncatedResponse?: boolean
  parseFailed?: boolean
  /** 모델이 이력에 없는 번호를 지어내 걸렀는지 */
  issueDropped?: boolean
  diffUsed?: boolean
  diffTruncated?: boolean
  diffError?: string | null
  binaryCount?: number
  /** 참고한 내 과거 서밋 수 */
  historyCount?: number
}

interface AppInfo {
  /** 지금 띄우고 있는 주소 */
  url: string
  /** 설정에 저장된 주소 (없으면 빈 문자열) */
  savedUrl: string
  /** 저장값 없이 MEOS_APP_URL 환경변수/.env.local 로 정해졌는지 */
  fromEnv: boolean
  /** 개발 모드 — 저장값을 무시하고 Vite dev 서버를 쓴다 */
  isDev: boolean
  version: string
}

interface DesktopBridge {
  isDesktop: boolean
  app: {
    getInfo: () => Promise<AppInfo>
    setUrl: (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>
    reload: () => Promise<{ ok: boolean }>
  }
  onAuthCallback: (cb: (url: string) => void) => void
  openShortcut: (target: string) => Promise<{ ok: boolean; error?: string }>
  onOpenQuickSearch: (cb: () => void) => void
  snippets: {
    list: () => Promise<{ id: string; title: string }[]>
    save: (s: { id?: string; title: string; content?: string }) => Promise<{ ok: boolean; error?: string }>
    remove: (id: string) => Promise<{ ok: boolean }>
    copy: (id: string) => Promise<{ ok: boolean; error?: string }>
    reveal: (id: string) => Promise<{ ok: boolean; content?: string; error?: string }>
    trashList: () => Promise<{ id: string; title: string; deletedAt: string | null }[]>
    restore: (id: string) => Promise<{ ok: boolean; error?: string }>
    purge: (id: string) => Promise<{ ok: boolean }>
  }
  p4: {
    getConfig: () => Promise<P4Config>
    setConfig: (cfg: {
      port: string
      user: string
      workspace: string
      userName: string
      model: string
      sendDiff: boolean
      maxDiffChars?: number
      llmBaseUrl: string
      llmApiKey?: string
    }) => Promise<{ ok: boolean; error?: string }>
    info: () => Promise<{ ok: boolean; error?: string; info?: { user: string; serverAddress: string; clientName: string; clientRoot: string } }>
    workspaces: () => Promise<{ ok: boolean; error?: string; hostname?: string; user?: string; workspaces?: P4Workspace[] }>
    pending: () => Promise<{ ok: boolean; error?: string; workspace?: string; changes?: P4Change[]; fileCount?: number }>
    reopen: (files: string[], toChange: string) => Promise<{ ok: boolean; error?: string; moved?: number }>
    createChange: (description: string) => Promise<{ ok: boolean; error?: string; change?: string }>
    setDescription: (change: string, description: string) => Promise<{ ok: boolean; error?: string }>
  }
  llm: {
    models: () => Promise<{ ok: boolean; error?: string; models?: string[] }>
    submitLog: (payload: {
      change: string
      files: P4File[]
      description: string
      sendDiff?: boolean
    }) => Promise<SubmitLogResult>
  }
  bts: {
    getConfig: () => Promise<BtsConfig>
    setConfig: (cfg: {
      redmine: { url: string; apiKey?: string; insecure: boolean }
      jira: { url: string; email: string; token?: string }
    }) => Promise<{ ok: boolean; error?: string }>
    fetch: () => Promise<BtsResult>
    openNew: (system: 'redmine' | 'jira') => Promise<{ ok: boolean; error?: string }>
  }
  settings: {
    getHotkey: () => Promise<string>
    setHotkey: (hotkey: string) => Promise<{ ok: boolean; error?: string }>
  }
  win: {
    minimize: () => void
    toggleMaximize: () => void
    closeToTray: () => void
    quit: () => void
    onMaximizeChange: (cb: (maximized: boolean) => void) => void
  }
}

interface Window {
  desktop?: DesktopBridge
}
