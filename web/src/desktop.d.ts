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
  /** 이 PC 안의 실제 경로 (신규 파일 본문을 읽을 때 쓴다) */
  clientFile?: string
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

// ── AI 코드 리뷰 (Windows 전용) ──────────────────────────────

/** codex = GPT, claude = Claude, local = 사내 LLM */
type ReviewKind = 'codex' | 'claude' | 'local'

interface ReviewKindSpec {
  label: string
  /** true 면 코드가 사외로 나간다 */
  external: boolean
  cli: string | null
  efforts: string[]
  defaultEffort: string
  models: string[]
  note: string
}

interface Reviewer {
  id: string
  kind: ReviewKind
  /** 비우면 CLI/설정 기본 모델 */
  model: string
  effort: string
  enabled: boolean
}

interface ReviewCliState {
  path: string
  found: boolean
  source: 'setting' | 'npm' | 'PATH' | null
  configured: string
}

interface ReviewConfig {
  /** Windows 에서만 동작한다 */
  platformOk: boolean
  dir: string
  dirIsDefault: boolean
  defaultDir: string
  maxDiffChars: number
  timeoutMin: number
  includeNewFiles: boolean
  reviewers: Reviewer[]
  kinds: Record<ReviewKind, ReviewKindSpec>
  cli: { codex: ReviewCliState; claude: ReviewCliState }
  codexDefaultModel: string
  localModel: string
  localReady: boolean
}

/** 저장된 리뷰 파일 한 건 (목록용 — 본문은 read 로 따로 읽는다) */
interface ReviewFile {
  file: string
  change: string
  createdAt: string
  createdLocal: string
  title: string
  workspace: string
  fileCount: number
  reviewers: string[]
  ok: number
  failed: number
  size: number
}

interface ReviewEntry {
  id: string
  kind: ReviewKind
  label: string
  ok: boolean
  ms: number
  error: string | null
  chars: number
}

interface ReviewRunResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  file?: string
  dir?: string
  /** 방금 저장한 md 본문 — 다시 읽지 않고 바로 보여준다 */
  text?: string
  diffChars?: number
  diffTruncated?: boolean
  diffError?: string | null
  newFileCount?: number
  entries?: ReviewEntry[]
}

interface ReviewProgress {
  runId: string
  phase: 'start' | 'running' | 'done' | 'error'
  id?: string
  kind?: ReviewKind
  label?: string
  ms?: number
  error?: string | null
  promptChars?: number
  reviewers?: string[]
}

// ── 디스크 정리 (Windows 전용) ───────────────────────────────

interface DiskDrive {
  drive: string // 'C:'
  label: string
  fileSystem: string
  total: number
  free: number
}

/** 폴더 트리 한 칸. children 은 maxDepth 까지만 채워진다(크기는 전체를 다 센 값). */
interface DiskNode {
  path: string
  name: string
  size: number
  files: number
  mtime: number
  children: DiskNode[]
  /** 상위 N 개 밖의 폴더들을 접어 놓은 줄 */
  rest?: boolean
}

type DiskRisk = 'safe' | 'caution' | 'keep'

/** 정리 후보 한 건. risk 는 규칙 판정이고, ai 가 붙으면 더 조여진 값이 risk 에 반영돼 있다. */
interface DiskCandidate {
  path: string
  size: number
  files: number
  mtime: number
  risk: DiskRisk
  /** 규칙이 알아본 종류. 규칙이 모르는 큰 폴더(source='unknown')는 비어 있다. */
  kind?: string
  why?: string
  cost?: string
  project?: string | null
  source: 'rule' | 'unknown'
  ai?: { risk: DiskRisk; reason: string; cost: string } | null
}

interface DiskExtRow {
  ext: string
  size: number
  files: number
}

interface DiskFileRow {
  path: string
  size: number
  mtime: number
}

interface DiskAgeRow {
  key: string
  label: string
  size: number
  files: number
}

interface DiskScanResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  root?: string
  tree?: DiskNode
  stats?: { dirs: number; files: number; bytes: number; skipped: number; denied: number; elapsedMs: number }
  projects?: string[]
  engines?: string[]
  exts?: DiskExtRow[]
  bigFiles?: DiskFileRow[]
  ages?: DiskAgeRow[]
  oldDirs?: DiskFileRow[]
  candidates?: DiskCandidate[]
  unknowns?: DiskFileRow[]
  /** 이력 파일 id·시각 (저장된 스캔을 다시 읽었거나, 방금 저장한 경우) */
  id?: string
  at?: string
  saved?: DiskHistoryItem
}

interface DiskDupGroup {
  size: number
  count: number
  /** 한 개만 남기고 지웠을 때 비는 용량 */
  wasted: number
  files: string[]
}

interface DiskProgress {
  runId: string
  phase: 'start' | 'scan' | 'dup' | 'done'
  current?: string
  dirs?: number
  files?: number
  bytes?: number
  scanned?: number
  hashed?: number
  readBytes?: number
  elapsedMs?: number
}

/** 지난 스캔 한 건의 요약 (목록용). 본문은 historyRead 로 따로 읽는다. */
interface DiskHistoryItem {
  id: string
  root: string
  at: string
  totalBytes: number
  files: number
  dirs: number
  elapsedMs: number
  projects: number
  candidateCount: number
  candidateBytes: number
  safeBytes: number
}

interface DiskTrashResult {
  path: string
  ok: boolean
  size?: number
  /** 실패 이유 — main 이 되짚어 준 사람이 읽을 문장 */
  error?: string
  /** 관리자 권한으로 다시 실행하면 될 가능성이 있다 */
  needsAdmin?: boolean
  /** 휴지통으로는 못 간다(용량 초과·정책·경로 길이) — "영구 삭제로 다시 시도" 를 띄운다 */
  permanentOnly?: boolean
  /** Electron 이 준 원문. 진단이 틀렸을 때 근거를 남긴다. */
  raw?: string
  permanent?: boolean
}

interface DiskConfig {
  platformOk: boolean
  lastRoot: string
  maxDepth: number
  skipSystem: boolean
  model: string
  llmReady: boolean
  drives: DiskDrive[]
}

/** 지금 프로세스의 관리자 권한 상태. 디스크 정리가 이걸 보고 안내를 바꾼다. */
interface Elevation {
  platformOk: boolean
  /** 관리자 권한으로 돌고 있는가 */
  elevated: boolean
  /** 승격해서 다시 열 수 있는가 (Windows) */
  canRelaunch: boolean
  /** "항상 관리자로" 를 걸 수 있는가 — 설치본에서만 (개발 모드는 electron.exe 라 제외) */
  alwaysAdminAvailable: boolean
  alwaysAdmin: boolean
  exePath: string
  error?: string
}

// ── UE 빌드 감시 (Windows 전용) ──────────────────────────────

/** UBT 인자에서 읽어낸 빌드 대상 한 건. 못 알아본 칸은 null 로 온다. */
interface UeTargetSpec {
  target: string | null
  platform: string | null
  configuration: string | null
  project: string | null
}

type UeOriginKind =
  | 'vs'
  | 'rider'
  | 'editor'
  | 'claude'
  | 'codex'
  | 'meos'
  | 'msbuild'
  | 'vscode'
  | 'terminal'
  | 'explorer'
  | 'ci'
  | 'unknown'

/** claude.exe 가 조상일 때만 채워진다 — `~/.claude/sessions/<pid>.json` 에서 읽는다. */
interface UeClaudeSession {
  name: string | null
  sessionId: string | null
  cwd: string | null
  status: string | null
}

/** 이 빌드를 건 주체. 부모 프로세스 사슬로 판정한다. */
interface UeOrigin {
  kind: UeOriginKind
  label: string
  /** 세션 이름·솔루션 파일 등 한 줄 보탬 */
  detail: string | null
  /** 주체 프로세스의 pid. 추측일 때는 null */
  pid: number | null
  /** 'guess' 면 부모가 이미 끝나 커맨드라인 흔적으로 추측한 것 */
  confidence: 'certain' | 'guess'
  chain: { pid: number; name: string }[]
  session?: UeClaudeSession
}

interface UeBuild {
  pid: number
  startedAt: string | null
  elapsedMs: number | null
  targets: UeTargetSpec[]
  /** VS/MSBuild 가 띄웠다는 UBT 자체의 표시 */
  fromMsBuild: boolean
  hotReload: boolean
  /** 에디터에서 Ctrl+Alt+F11 로 건 빌드 */
  liveCoding: boolean
  origin: UeOrigin
  commandLine: string
}

/**
 * 진행률. basis 가 다르면 의미가 다르다 —
 * 'completed' 는 UBA 가 찍어 준 완료 개수, 'started' 는 분산 빌드에서 착수한 obj 개수.
 */
interface UeProgress {
  done: number
  total: number
  basis: 'completed' | 'started'
}

interface UeLog {
  ok: boolean
  path: string
  error?: string
  size?: number
  mtime?: string
  ageMs?: number
  /** 최근에 쓰인 로그인가 — 아니면 지난 빌드의 것이다 */
  fresh?: boolean
  executor?: string | null
  phase?: 'prepare' | 'compile' | 'link' | 'done' | 'uptodate' | 'error'
  building?: string | null
  /** UBT 가 로그에 적어 둔 자기 커맨드라인 — 프로세스가 없어도 무엇을 빌드했는지 알 수 있다 */
  commandLine?: string | null
  targets?: UeTargetSpec[]
  progress?: UeProgress | null
  actions?: string[]
  agents?: { ip: string; ok: boolean | null }[]
  errors?: string[]
  totalSeconds?: number | null
  tail?: string[]
}

interface UeStatus {
  ok: boolean
  platformOk: boolean
  at: string
  error?: string
  running?: boolean
  /** 빌드 기미가 없어 프로세스 전수 조회를 건너뛴 회차 */
  idle?: boolean
  engineRoot?: string
  engineRootDetected?: string | null
  engineRootFromConfig?: boolean
  builds: UeBuild[]
  workers: { label: string; count: number }[]
  /** 에디터가 떠 있으면 링크 단계에서 dll 을 못 덮어쓴다 */
  editors: { pid: number; name: string; startedAt: string | null }[]
  log?: UeLog | null
}

interface UeEngine {
  root: string
  source: 'source' | 'launcher'
  name: string
  /** 이 엔진의 UBT 로그가 마지막으로 쓰인 시각 */
  logMtime: string | null
}

interface UeConfig {
  platformOk: boolean
  engineRoot: string
  engineRootSaved: string
  pollSec: number
  engines: UeEngine[]
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
    /** hard=true 면 서비스워커·캐시까지 비우고 다시 연다 */
    reload: (hard?: boolean) => Promise<{ ok: boolean }>
    elevation: () => Promise<Elevation>
    /** UAC 를 취소하면 { ok:false, cancelled:true } 만 오고 앱은 그대로 살아 있다. */
    relaunchElevated: () => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
    setAlwaysAdmin: (on: boolean) => Promise<{ ok: boolean; on?: boolean; error?: string }>
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
  review: {
    getConfig: () => Promise<ReviewConfig>
    setConfig: (cfg: {
      dir: string
      codexPath: string
      claudePath: string
      maxDiffChars: number
      timeoutMin: number
      includeNewFiles: boolean
      reviewers: Reviewer[]
    }) => Promise<{ ok: boolean; error?: string }>
    pickDir: () => Promise<{ ok: boolean; dir?: string }>
    run: (payload: { runId: string; change: string }) => Promise<ReviewRunResult>
    cancel: (runId: string) => Promise<{ ok: boolean; error?: string }>
    list: (change?: string | null) => Promise<{ ok: boolean; dir: string; reviews: ReviewFile[] }>
    counts: () => Promise<{ ok: boolean; counts: Record<string, number> }>
    read: (file: string) => Promise<{ ok: boolean; error?: string; text?: string; path?: string }>
    remove: (file: string) => Promise<{ ok: boolean; error?: string }>
    openDir: () => Promise<{ ok: boolean; error?: string }>
    openFile: (file: string) => Promise<{ ok: boolean; error?: string }>
    /** 해제 함수를 돌려준다 */
    onProgress: (cb: (msg: ReviewProgress) => void) => () => void
  }
  disk: {
    getConfig: () => Promise<DiskConfig>
    setConfig: (cfg: { lastRoot?: string; maxDepth: number; skipSystem: boolean; model?: string }) => Promise<{ ok: boolean; error?: string }>
    pickDir: () => Promise<{ ok: boolean; dir?: string }>
    scan: (payload: { runId: string; root: string; maxDepth: number; skipSystem: boolean }) => Promise<DiskScanResult>
    duplicates: (payload: { runId: string; root: string; minMB: number }) => Promise<{
      ok: boolean
      error?: string
      cancelled?: boolean
      groups?: DiskDupGroup[]
      groupCount?: number
      wastedTotal?: number
    }>
    cancel: (runId: string) => Promise<{ ok: boolean; error?: string }>
    judge: (payload: {
      candidates: DiskCandidate[]
      unknowns: DiskFileRow[]
      projects: string[]
      engines: string[]
      drive: DiskDrive | null
    }) => Promise<{ ok: boolean; error?: string; items?: DiskCandidate[]; model?: string; promptChars?: number }>
    /**
     * 기본은 휴지통. size 는 표시용(스캔 때 잰 값) — 삭제 허용 여부는 main 이 따로 검사한다.
     * mode 'permanent' 는 휴지통이 거절한 항목을 사용자가 보고 다시 누를 때만 쓴다.
     */
    trash: (
      items: { path: string; size: number }[],
      mode?: 'trash' | 'permanent',
    ) => Promise<{
      ok: boolean
      error?: string
      freed?: number
      elevated?: boolean
      permanent?: boolean
      results?: DiskTrashResult[]
    }>
    reveal: (path: string) => Promise<{ ok: boolean; error?: string }>
    history: () => Promise<{ ok: boolean; dir: string; items: DiskHistoryItem[] }>
    historyRead: (id: string) => Promise<{ ok: boolean; error?: string; scan?: DiskScanResult }>
    historyRemove: (id: string) => Promise<{ ok: boolean }>
    historyOpenDir: () => Promise<{ ok: boolean; error?: string }>
    /** 해제 함수를 돌려준다 */
    onProgress: (cb: (msg: DiskProgress) => void) => () => void
  }
  uebuild: {
    getConfig: () => Promise<UeConfig>
    setConfig: (cfg: { engineRoot?: string; pollSec?: number }) => Promise<{ ok: boolean; error?: string }>
    status: () => Promise<UeStatus>
    pickEngine: () => Promise<{ ok: boolean; dir?: string }>
    openLog: () => Promise<{ ok: boolean; error?: string }>
    revealLog: () => Promise<{ ok: boolean; error?: string }>
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
