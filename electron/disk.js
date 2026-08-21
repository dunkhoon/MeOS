// 하드 드라이브 정리 — 스캔 · 판정 규칙 · LLM 판단 프롬프트.
//
// Electron API 를 쓰지 않는 순수 Node 모듈이다(llm.js 와 같은 이유) — 실제 디스크를 상대로
// 단독 실행해 확인할 수 있어야 한다. 삭제(휴지통 이동)만은 Electron shell 이 필요해
// main.js 가 맡고, 여기서는 **무엇을 지워도 되는지 판정**까지만 한다.
//
// 설계에서 세 가지가 중요하다.
//
// 1) **규칙이 먼저, AI 는 나중.** 지워도 되는지는 경로 구조로 거의 다 판정된다
//    (UE 프로젝트의 Intermediate 는 언제나 다시 생긴다). LLM 은 규칙이 모르는 것을
//    설명하고, 규칙이 안전하다고 본 것을 **더 조이는 쪽으로만** 쓴다.
//    LLM 이 "지워도 된다" 고 해서 보호 대상이 풀리는 일은 없다 — 모델이 헛것을 말해도
//    사용자 데이터가 날아가면 안 된다.
//
// 2) **삭제는 언제나 휴지통.** 되돌릴 수 없는 동작을 AI 판단 뒤에 두지 않는다.
//
// 3) **심볼릭 링크·정션은 따라가지 않는다.** 따라가면 같은 용량을 두 번 세고, 최악의 경우
//    순환에 빠진다. 크기도 정션 자체는 0 으로 둔다.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

// ── 드라이브 목록 ────────────────────────────────────────────

/**
 * 로컬 디스크 용량. wmic 는 최신 Windows 에서 빠져 있어 PowerShell CIM 으로 읽는다.
 * DriveType 3 = 고정 디스크(네트워크·USB 를 빼려는 건 아니고, 정리 대상이 아니라서).
 */
function listDrives() {
  if (process.platform !== 'win32') return Promise.resolve([])
  const ps =
    'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ' +
    'Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        let json = null
        try {
          json = JSON.parse(String(stdout || '').trim() || 'null')
        } catch {
          resolve([])
          return
        }
        // 드라이브가 하나면 배열이 아니라 객체로 온다
        const rows = json == null ? [] : Array.isArray(json) ? json : [json]
        resolve(
          rows.map((r) => ({
            drive: String(r.DeviceID || ''),
            label: String(r.VolumeName || ''),
            fileSystem: String(r.FileSystem || ''),
            total: Number(r.Size) || 0,
            free: Number(r.FreeSpace) || 0,
          })),
        )
      },
    )
  })
}

// ── 보호 대상 ────────────────────────────────────────────────
//
// 여기 걸리면 후보로도 안 올라가고, 삭제 요청이 와도 거절한다.
// "AI 가 지워도 된다고 했다" 는 이유로 뚫리면 안 되는 마지막 방어선이다.

const HOME = os.homedir()

/** 경로 비교는 소문자 + 역슬래시로 맞춘다 (윈도우는 대소문자를 구분하지 않는다). */
function norm(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** a 가 b 이거나 b 아래인가. 'C:\AB' 가 'C:\A' 아래로 잡히지 않게 경계를 본다. */
function isInside(child, parent) {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith('\\') ? p : p + '\\')
}

/** 시스템·설치 폴더. 정리로 건드릴 곳이 아니다. */
const SYSTEM_ROOTS = [
  process.env.SystemRoot || 'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData\\Package Cache',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
  'C:\\Recovery',
]

/**
 * 프로젝트 안에서 지우면 안 되는 것들. 이름만 보고 판단한다.
 * - Source/Content/Config/Plugins: 원본. 다시 못 만든다.
 * - Saved/SaveGames: 플레이 세이브. 로그와 같은 Saved 아래 있어 특히 조심해야 한다.
 * - Saved/Config: 에디터 설정(레이아웃·최근 파일). 지우면 세팅이 초기화된다.
 * - .git/.p4/.svn: 버전관리 메타. 지우면 작업본이 통째로 위험해진다.
 */
const PROTECTED_NAMES = ['source', 'content', 'config', 'plugins', '.git', '.svn', '.p4', '.p4config', 'savegames']
const PROTECTED_SUBPATHS = ['saved\\savegames', 'saved\\config']

function isProtectedPath(p) {
  const n = norm(p)
  if (!n || /^[a-z]:\\?$/.test(n)) return true // 드라이브 루트 자체
  if (SYSTEM_ROOTS.some((r) => isInside(n, r))) return true
  if (PROTECTED_SUBPATHS.some((s) => n.includes(`\\${s}`))) return true
  const parts = n.split('\\')
  const name = parts[parts.length - 1]
  if (PROTECTED_NAMES.includes(name)) return true
  return false
}

// ── 정리 후보 규칙 (Unreal Engine · C++) ─────────────────────
//
// risk 세 단계:
//   safe    — 자동으로 다시 만들어진다. 잃는 게 시간(재빌드·재캐시)뿐이다.
//   caution — 다시 만들 수는 있지만 값이 크다(재빌드 필요 · 재다운로드 · 복구본 소실).
//   keep    — 지우면 안 된다.

/** 폴더 이름만으로 정해지는 것들 (UE 프로젝트/엔진 안에서만 적용) */
const UE_DIR_RULES = {
  intermediate: {
    risk: 'safe',
    why: '빌드·프로젝트 파일 생성 때 다시 만들어지는 중간 산출물이다. 소스가 있으면 언제든 복구된다.',
    cost: '다음 빌드가 느려진다(전체 재컴파일).',
  },
  deriveddatacache: {
    risk: 'safe',
    why: '에디터가 애셋에서 다시 굽는 캐시(DDC)다. 원본 애셋은 Content 에 그대로 있다.',
    cost: '에디터 첫 실행에서 셰이더·메시를 다시 굽느라 오래 걸린다.',
  },
  binaries: {
    risk: 'caution',
    why: '컴파일된 실행/DLL 이다. 소스가 있으면 다시 빌드해 만들 수 있다.',
    cost: '다시 빌드하기 전에는 에디터·게임이 실행되지 않는다. (소스 없이 받은 프로젝트라면 지우면 안 된다)',
  },
  '.vs': {
    risk: 'safe',
    why: 'Visual Studio 가 만드는 로컬 상태(인덱스·중단점 위치)다. 프로젝트 내용이 아니다.',
    cost: '다음에 솔루션을 열 때 인덱싱을 다시 한다.',
  },
  ipch: {
    risk: 'safe',
    why: 'Visual Studio 미리 컴파일된 헤더 캐시다.',
    cost: '다음 빌드에서 다시 만든다.',
  },
  obj: {
    risk: 'safe',
    why: 'C++ 오브젝트 파일(중간 산출물)이다.',
    cost: '다음 빌드가 전체 컴파일이 된다.',
  },
}

/** Saved 아래는 하위 폴더마다 성격이 다르다 — 한 덩어리로 묶으면 세이브까지 날아간다. */
const UE_SAVED_RULES = {
  logs: { risk: 'safe', why: '에디터·게임 로그다.', cost: '없음(과거 로그를 못 본다).' },
  crashes: { risk: 'safe', why: '크래시 리포트 덤프다.', cost: '없음(과거 크래시 분석 자료를 잃는다).' },
  cooked: { risk: 'safe', why: '쿠킹 결과물이다. 원본 애셋에서 다시 굽는다.', cost: '다시 쿠킹해야 한다(오래 걸린다).' },
  stagedbuilds: { risk: 'safe', why: '패키징 스테이징 결과물이다.', cost: '다시 패키징해야 한다.' },
  shaderdebuginfo: { risk: 'safe', why: '셰이더 디버그 정보다.', cost: '셰이더 디버깅 시 다시 필요하다.' },
  autosaves: {
    risk: 'caution',
    why: '에디터 자동 저장본이다. 저장 못 한 작업의 마지막 보루라 함부로 지우면 안 된다.',
    cost: '에디터가 죽었을 때 복구할 것이 없어진다.',
  },
  backup: {
    risk: 'caution',
    why: '에디터가 남긴 애셋 백업이다.',
    cost: '망가진 애셋을 되돌릴 수단이 사라진다.',
  },
}

/** 프로젝트 밖(전역)에 쌓이는 캐시 — 절대 경로로 알아본다. */
function globalCacheRules() {
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
  return [
    {
      match: path.join(local, 'UnrealEngine', 'Common', 'DerivedDataCache'),
      risk: 'safe',
      why: '여러 프로젝트가 함께 쓰는 공유 DDC 다. 애셋 원본이 아니다.',
      cost: '다음 실행에서 다시 굽는다(프로젝트마다 한 번씩 느려진다).',
    },
    {
      match: path.join(local, 'UnrealEngine', 'Common', 'Zen'),
      risk: 'caution',
      why: 'Zen 스토어 데이터다. 캐시이긴 하나 Zen 서버가 도는 중이면 건드리면 안 된다.',
      cost: 'Zen 서버를 먼저 내려야 하고, 이후 캐시를 다시 채운다.',
    },
    { match: path.join(local, 'CrashReportClient'), risk: 'safe', why: '크래시 리포터가 남긴 자료다.', cost: '없음.' },
    { match: path.join(local, 'D3DSCache'), risk: 'safe', why: 'D3D 셰이더 캐시다.', cost: '첫 실행이 잠깐 느려진다.' },
    { match: path.join(local, 'NVIDIA', 'DXCache'), risk: 'safe', why: 'NVIDIA 셰이더 캐시다.', cost: '첫 실행이 잠깐 느려진다.' },
    { match: path.join(local, 'NVIDIA', 'GLCache'), risk: 'safe', why: 'NVIDIA GL 셰이더 캐시다.', cost: '첫 실행이 잠깐 느려진다.' },
    { match: path.join(local, 'AMD', 'DxCache'), risk: 'safe', why: 'AMD 셰이더 캐시다.', cost: '첫 실행이 잠깐 느려진다.' },
    {
      match: path.join(roaming, 'Unreal Engine', 'AutomationTool', 'Logs'),
      risk: 'safe',
      why: 'AutomationTool(빌드·패키징) 로그다.',
      cost: '없음.',
    },
    {
      match: path.join(local, 'EpicGamesLauncher', 'Saved', 'Logs'),
      risk: 'safe',
      why: '에픽 런처 로그다.',
      cost: '없음.',
    },
    {
      match: path.join(local, 'EpicGamesLauncher', 'VaultCache'),
      risk: 'caution',
      why: '마켓플레이스에서 받은 애셋 원본 보관함이다. 캐시라는 이름과 달리 다시 받아야 한다.',
      cost: '프로젝트에 추가할 때 다시 다운로드해야 한다(용량·시간).',
    },
    { match: path.join(local, 'Temp'), risk: 'safe', why: '임시 폴더다. 쓰는 중인 파일은 삭제가 그냥 실패한다.', cost: '없음.' },
  ]
}

/** 규칙이 이름만으로 알아보는 폴더 이름들 (소문자). 색인에서 빠지지 않게 하는 데 쓴다. */
const CANDIDATE_NAMES = new Set([...Object.keys(UE_DIR_RULES), ...Object.keys(UE_SAVED_RULES)])

/** 이 폴더가 UE 프로젝트 루트인가 (*.uproject 가 있는가). */
function isProjectRoot(dir, names) {
  return names.some((n) => n.toLowerCase().endsWith('.uproject'))
}

/** 소스 빌드 엔진 루트인가 (Engine/Build/BatchFiles 가 있는가 — GenerateProjectFiles 가 사는 곳). */
function looksLikeEngineRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Engine', 'Build', 'BatchFiles'))
  } catch {
    return false
  }
}

// ── 스캔 ─────────────────────────────────────────────────────

/** 이벤트 루프에 자리를 내준다. 이걸 안 하면 취소·진행표시가 죽는다(아래 설명). */
function yieldToLoop() {
  return new Promise((r) => setImmediate(r))
}

/**
 * 폴더 하나를 통째로 재귀 스캔한다.
 *
 * 큰 트리(수십만 파일)를 상대로 도는 코드라 다음을 지킨다.
 * - 예외는 삼킨다. 권한 없는 폴더 하나 때문에 스캔 전체가 죽으면 쓸모가 없다(개수만 센다).
 * - 정션·심볼릭 링크는 들어가지 않는다.
 * - 진행 상황은 시간으로 throttle 한다. 폴더마다 보내면 IPC 가 스캔보다 느려진다.
 *
 * ⚠️ **중간중간 이벤트 루프에 자리를 내준다(async).** 실측으로 84만 파일에 91초가 걸리는데,
 *    이걸 동기로 돌리면 그동안 Electron main 이 IPC 를 하나도 못 받는다 —
 *    취소 버튼이 눌러도 아무 일이 없고(취소 신호가 큐에서 대기), 진행 상황도 끝난 뒤에
 *    한꺼번에 도착해 "멈춘 것처럼" 보인다. 그래서 파일 512개마다 한 번 양보한다.
 *
 * @returns {Promise<{root, node, index, projects, engines, stats}>}
 *   node  — maxDepth 까지 잘라 낸 트리(화면용). 크기는 전체를 다 센 값이다.
 *   index — 경로 → {size, files, mtime}. 후보 판정과 "큰 폴더" 목록에 쓴다.
 */
async function scanTree(root, opts = {}) {
  const maxDepth = Math.max(1, Number(opts.maxDepth) || 3)
  const topN = Math.max(1, Number(opts.topN) || 12)
  const skipSystem = opts.skipSystem !== false
  const state = opts.state || { cancelled: false }
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const indexMinBytes = Number(opts.indexMinBytes) || 16 * 1024 * 1024
  const topFiles = Math.max(1, Number(opts.topFiles) || 100)

  const index = new Map()
  const projects = []
  const engines = []
  const byExt = new Map()
  const ages = newAgeBuckets()
  // 가장 큰 파일 — 전부 들고 있다가 정렬하면 파일 수백만 개에서 메모리가 터진다.
  // 넘칠 때마다 잘라 내고, 잘라 낸 꼬리 값보다 작은 파일은 아예 담지 않는다(문턱이 스스로 올라간다).
  let big = []
  let bigMin = 0
  const pushBig = (row) => {
    if (row.size < bigMin) return
    big.push(row)
    if (big.length >= topFiles * 3) {
      big.sort((a, b) => b.size - a.size)
      big = big.slice(0, topFiles)
      bigMin = big[big.length - 1].size
    }
  }

  const stats = { dirs: 0, files: 0, bytes: 0, skipped: 0, denied: 0, startedAt: Date.now() }
  let lastTick = 0

  function tick(current) {
    if (!onProgress) return
    const now = Date.now()
    if (now - lastTick < 250) return
    lastTick = now
    onProgress({ ...stats, current, elapsedMs: now - stats.startedAt })
  }

  let sinceYield = 0
  async function walk(dir, depth) {
    if (state.cancelled) return null
    if (skipSystem && SYSTEM_ROOTS.some((r) => isInside(dir, r))) {
      stats.skipped += 1
      return null
    }

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      // EPERM/EACCES 는 흔하다(시스템 폴더). 세기만 하고 넘어간다.
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) stats.denied += 1
      else stats.skipped += 1
      return null
    }
    stats.dirs += 1

    const names = entries.map((e) => e.name)
    if (isProjectRoot(dir, names)) projects.push(dir)
    else if (depth <= 1 && looksLikeEngineRoot(dir)) engines.push(dir)

    let size = 0
    let files = 0
    let mtime = 0
    const children = []

    for (const ent of entries) {
      if (state.cancelled) return null
      const full = path.join(dir, ent.name)

      // 정션·심볼릭 링크는 크기 0 으로 두고 들어가지 않는다 (중복 계산·순환 방지)
      if (ent.isSymbolicLink()) {
        stats.skipped += 1
        continue
      }

      if (ent.isDirectory()) {
        const sub = await walk(full, depth + 1)
        if (!sub) continue
        size += sub.size
        files += sub.files
        if (sub.mtime > mtime) mtime = sub.mtime
        children.push(sub)
      } else if (ent.isFile()) {
        // throwIfNoEntry:false — 스캔 도중 사라지는 파일(빌드 중 임시파일)이 흔한데,
        // 그때마다 예외를 던지면 뜨거운 루프에서 비용이 크다
        const st = fs.statSync(full, { throwIfNoEntry: false })
        if (!st) {
          stats.skipped += 1
          continue
        }
        size += st.size
        files += 1
        stats.files += 1
        stats.bytes += st.size
        const mt = st.mtimeMs || 0
        if (mt > mtime) mtime = mt

        // 84만 파일을 도는 루프다 — 확장자는 한 번만 뽑는다
        const ext = extOf(ent.name)
        const ex = byExt.get(ext) || { size: 0, files: 0 }
        ex.size += st.size
        ex.files += 1
        byExt.set(ext, ex)

        const b = ages[ageBucket(mt)]
        b.size += st.size
        b.files += 1

        pushBig({ path: full, size: st.size, mtime: mt })

        // 512개마다 한 번 — 취소 신호와 진행 표시가 이 틈으로 들어온다
        if (++sinceYield >= 512) {
          sinceYield = 0
          await yieldToLoop()
        }
      }
    }

    tick(dir)

    // 후보 판정에 쓸 색인 — 작은 폴더까지 다 들면 메모리가 터진다. 큰 것과 얕은 것만.
    // 규칙이 이름으로 아는 폴더(Intermediate·Saved/Logs…)는 크기와 무관하게 남긴다 —
    // 그러지 않으면 색인 문턱보다 작은 후보를 통째로 놓친다(문턱값끼리 얽히면 찾기 어려운 버그가 된다).
    if (size >= indexMinBytes || depth <= maxDepth || CANDIDATE_NAMES.has(path.basename(dir).toLowerCase())) {
      index.set(dir, { size, files, mtime })
    }

    return {
      path: dir,
      name: depth === 0 ? dir : path.basename(dir),
      size,
      files,
      mtime,
      // 화면에 줄 트리는 잘라 낸다 — 깊이·개수 둘 다. 크기는 이미 다 센 뒤다.
      children: depth >= maxDepth ? [] : cutChildren(children, topN),
    }
  }

  const node = await walk(root, 0)
  stats.elapsedMs = Date.now() - stats.startedAt

  big.sort((a, b) => b.size - a.size)
  const exts = [...byExt.entries()]
    .map(([ext, v]) => ({ ext, ...v }))
    .sort((a, b) => b.size - a.size)

  return {
    root,
    node,
    index,
    projects,
    engines,
    stats,
    cancelled: state.cancelled,
    exts,
    bigFiles: big.slice(0, topFiles),
    ages: AGE_KEYS.map((k) => ({ key: k, label: AGE_LABEL[k], ...ages[k] })),
  }
}

// ── 파일 나이 · 확장자 ───────────────────────────────────────

const AGE_KEYS = ['d7', 'd30', 'd90', 'd180', 'd365', 'older']
const AGE_LABEL = {
  d7: '1주 이내',
  d30: '1개월 이내',
  d90: '3개월 이내',
  d180: '6개월 이내',
  d365: '1년 이내',
  older: '1년 넘게 그대로',
}

function newAgeBuckets() {
  const o = {}
  for (const k of AGE_KEYS) o[k] = { size: 0, files: 0 }
  return o
}

function ageBucket(mtimeMs) {
  const d = (Date.now() - (mtimeMs || 0)) / 86400000
  if (d <= 7) return 'd7'
  if (d <= 30) return 'd30'
  if (d <= 90) return 'd90'
  if (d <= 180) return 'd180'
  if (d <= 365) return 'd365'
  return 'older'
}

/** 확장자. 없으면 '(확장자 없음)'. UE 는 대소문자가 섞여 들어와 소문자로 모은다. */
function extOf(name) {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return '(확장자 없음)'
  return name.slice(i).toLowerCase()
}

/**
 * 오래 안 건드린 큰 폴더. 폴더의 mtime 은 **자식 중 가장 최근** 값을 쓴다 —
 * 폴더 자체의 타임스탬프는 안을 고쳐도 안 바뀌는 경우가 있어 믿을 수 없다.
 */
function oldBigDirs(scan, opts = {}) {
  const days = Number(opts.olderThanDays) || 180
  const minBytes = Number(opts.minBytes) || 256 * 1024 * 1024
  const limit = Number(opts.limit) || 30
  const cutoff = Date.now() - days * 86400000
  const rows = []
  for (const [dir, info] of scan.index) {
    if (info.size < minBytes) continue
    if (!info.mtime || info.mtime > cutoff) continue
    if (isProtectedPath(dir)) continue
    rows.push({ path: dir, size: info.size, files: info.files, mtime: info.mtime })
  }
  rows.sort((a, b) => b.size - a.size)
  // 부모가 오래됐으면 그 안은 전부 오래된 것이다(폴더 mtime = 자식 중 최신).
  // 그러니 바깥쪽 하나만 남기고 그 아래는 접는다 — 안 그러면 같은 트리가 수십 줄로 나온다.
  const kept = []
  for (const r of rows) {
    if (kept.some((k) => isInside(r.path, k.path))) continue
    kept.push(r)
    if (kept.length >= limit) break
  }
  return kept
}

/** 큰 것 topN 만 남기고 나머지는 "기타 N개" 한 줄로 접는다. */
function cutChildren(children, topN) {
  const sorted = children.slice().sort((a, b) => b.size - a.size)
  if (sorted.length <= topN) return sorted
  const head = sorted.slice(0, topN)
  const rest = sorted.slice(topN)
  head.push({
    path: '',
    name: `기타 ${rest.length}개 폴더`,
    size: rest.reduce((s, x) => s + x.size, 0),
    files: rest.reduce((s, x) => s + x.files, 0),
    mtime: 0,
    children: [],
    rest: true,
  })
  return head
}

// ── 후보 뽑기 ────────────────────────────────────────────────

/** dir 를 담고 있는 가장 가까운 프로젝트/엔진 루트 */
function contextOf(dir, projects, engines) {
  let best = null
  for (const p of projects) if (isInside(dir, p) && (!best || p.length > best.root.length)) best = { root: p, kind: 'project' }
  for (const e of engines) if (isInside(dir, e) && (!best || e.length > best.root.length)) best = { root: e, kind: 'engine' }
  return best
}

/**
 * 스캔 결과에서 지워도 되는 것들을 골라낸다.
 *
 * 규칙만으로 판정하며, 여기서 나온 risk 가 **상한**이다 — LLM 은 이걸 더 조일 수만 있다.
 * 부모가 이미 후보면 자식은 넣지 않는다(Intermediate 안의 Build 를 따로 지울 이유가 없다).
 */
function collectCandidates(scan, opts = {}) {
  const minBytes = Number(opts.minBytes) || 32 * 1024 * 1024
  const { index, projects, engines } = scan
  const globals = globalCacheRules()
  const out = []

  for (const [dir, info] of index) {
    if (isProtectedPath(dir)) continue

    const lower = norm(dir)
    const name = lower.split('\\').pop()
    const ctx = contextOf(dir, projects, engines)
    let rule = null

    // 1) 전역 캐시 (경로 전체가 일치)
    const g = globals.find((r) => norm(r.match) === lower)
    if (g) rule = { kind: '전역 캐시', risk: g.risk, why: g.why, cost: g.cost }

    // 2) Saved 하위 — 폴더마다 성격이 달라 따로 본다
    if (!rule && ctx && /\\saved\\[^\\]+$/.test(lower)) {
      const r = UE_SAVED_RULES[name]
      if (r) rule = { kind: `UE Saved/${name}`, risk: r.risk, why: r.why, cost: r.cost }
    }

    // 3) 프로젝트·엔진 안의 이름 규칙
    if (!rule && ctx) {
      // DDC 는 이름이 하나가 아니다 — 실제 프로젝트에서 DerivedDataCacheChunks(85GB)가 따로 나온다.
      // 접두사로 잡지 않으면 이런 변종이 통째로 새어 나간다.
      const r = name.startsWith('deriveddatacache') ? UE_DIR_RULES.deriveddatacache : UE_DIR_RULES[name]
      if (r) rule = { kind: `${ctx.kind === 'engine' ? '엔진' : '프로젝트'} ${name}`, risk: r.risk, why: r.why, cost: r.cost }
    }

    // 4) UE 밖의 C++ 빌드 산출물 — 옆에 vcxproj 가 있어야 그 폴더가 맞다
    if (!rule && (name === 'obj' || name === '.vs' || name === 'ipch')) {
      const r = UE_DIR_RULES[name]
      if (r && hasSibling(path.dirname(dir), /\.(vcxproj|sln)$/i)) {
        rule = { kind: `C++ ${name}`, risk: r.risk, why: r.why, cost: r.cost }
      }
    }

    if (!rule) continue
    if (info.size < minBytes) continue
    out.push({
      path: dir,
      size: info.size,
      files: info.files,
      mtime: info.mtime,
      project: ctx ? ctx.root : null,
      ...rule,
      source: 'rule',
    })
  }

  // 부모가 후보면 자식은 뺀다
  const sorted = out.sort((a, b) => a.path.length - b.path.length)
  const kept = []
  for (const c of sorted) {
    if (kept.some((k) => isInside(c.path, k.path) && norm(c.path) !== norm(k.path))) continue
    kept.push(c)
  }
  return kept.sort((a, b) => b.size - a.size)
}

function hasSibling(dir, re) {
  try {
    return fs.readdirSync(dir).some((n) => re.test(n))
  } catch {
    return false
  }
}

/**
 * 규칙이 모르는 큰 폴더 — "이건 뭐지?" 를 LLM 에게 물어볼 대상.
 * 후보(및 그 자식)와 보호 대상은 뺀다. 자식이 이미 목록에 있으면 부모는 넣지 않는다.
 */
function unknownBigDirs(scan, candidates, opts = {}) {
  const minBytes = Number(opts.minBytes) || 512 * 1024 * 1024
  const limit = Number(opts.limit) || 12
  const rows = []
  for (const [dir, info] of scan.index) {
    if (info.size < minBytes) continue
    if (isProtectedPath(dir)) continue
    if (norm(dir) === norm(scan.root)) continue // 스캔한 폴더 자신은 "모르는 폴더" 가 아니다
    if (candidates.some((c) => isInside(dir, c.path) || isInside(c.path, dir))) continue
    rows.push({ path: dir, size: info.size, files: info.files, mtime: info.mtime })
  }
  rows.sort((a, b) => b.size - a.size)
  // 큰 것부터 담되, 이미 담은 폴더의 **안쪽**은 빼다 — 부모와 자식이 같은 용량으로 줄줄이 나오면
  // 목록이 한 트리로 다 차 버린다(node_modules → node_modules/electron → .../dist …).
  const kept = []
  for (const r of rows) {
    if (kept.some((k) => isInside(r.path, k.path))) continue
    kept.push(r)
    if (kept.length >= limit) break
  }
  return kept
}

// ── 중복 파일 ────────────────────────────────────────────────

/**
 * 같은 내용의 파일 찾기. 세 단계로 좁혀 가며 **읽는 양을 최소로** 한다.
 *
 *   1) 크기로 묶는다 — 크기가 다르면 내용이 같을 수 없다. 여기서 대부분 걸러진다(디스크를 안 읽는다).
 *   2) 같은 크기 그룹만 앞 64KB 해시 — 다른 파일은 거의 여기서 갈린다.
 *   3) 그래도 남은 것만 전체 해시 — 실제로 같은 파일들만 통째로 읽는다.
 *
 * ⚠️ 2·3 단계는 디스크를 실제로 읽는다. minBytes 를 낮추면(작은 파일까지 포함) 수십만 개를
 *    읽게 되어 몇 배로 느려진다. 기본 8MB 는 "지워서 의미 있는 크기" 의 하한이다.
 */
async function findDuplicates(root, opts = {}) {
  const crypto = require('node:crypto')
  const minBytes = Number(opts.minBytes) || 8 * 1024 * 1024
  const state = opts.state || { cancelled: false }
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const skipSystem = opts.skipSystem !== false
  const maxGroups = Number(opts.maxGroups) || 200

  const stats = { scanned: 0, candidates: 0, hashed: 0, readBytes: 0, phase: '목록', startedAt: Date.now() }
  let lastTick = 0
  const tick = (current) => {
    if (!onProgress) return
    const now = Date.now()
    if (now - lastTick < 250) return
    lastTick = now
    onProgress({ ...stats, current, elapsedMs: now - stats.startedAt })
  }

  // 1) 크기별로 모은다
  const bySize = new Map()
  let dupYield = 0
  const walk = async (dir) => {
    if (state.cancelled) return
    if (skipSystem && SYSTEM_ROOTS.some((r) => isInside(dir, r))) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (state.cancelled) return
      if (ent.isSymbolicLink()) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (ent.isFile()) {
        const st = fs.statSync(full, { throwIfNoEntry: false })
        if (!st || st.size < minBytes) continue
        stats.scanned += 1
        const list = bySize.get(st.size) || []
        list.push(full)
        bySize.set(st.size, list)
        tick(dir)
        if (++dupYield >= 512) {
          dupYield = 0
          await yieldToLoop()
        }
      }
    }
  }
  await walk(root)
  if (state.cancelled) return { groups: [], stats, cancelled: true }

  // 2) 같은 크기끼리만 앞부분 해시
  stats.phase = '앞부분 비교'
  const headGroups = []
  for (const [size, list] of bySize) {
    if (list.length < 2) continue
    stats.candidates += list.length
    const byHead = new Map()
    for (const f of list) {
      if (state.cancelled) return { groups: [], stats, cancelled: true }
      const h = hashPart(f, 64 * 1024, crypto)
      await yieldToLoop()
      if (!h) continue
      stats.hashed += 1
      stats.readBytes += Math.min(size, 64 * 1024)
      const g = byHead.get(h) || []
      g.push(f)
      byHead.set(h, g)
      tick(f)
    }
    for (const g of byHead.values()) if (g.length >= 2) headGroups.push({ size, files: g })
  }

  // 3) 남은 것만 전체 해시
  stats.phase = '전체 비교'
  const groups = []
  for (const hg of headGroups) {
    if (state.cancelled) return { groups, stats, cancelled: true }
    const byFull = new Map()
    for (const f of hg.files) {
      const h = hashPart(f, 0, crypto) // 0 = 끝까지
      await yieldToLoop()
      if (!h) continue
      stats.readBytes += hg.size
      const g = byFull.get(h) || []
      g.push(f)
      byFull.set(h, g)
      tick(f)
    }
    for (const g of byFull.values()) {
      if (g.length < 2) continue
      groups.push({ size: hg.size, count: g.length, wasted: hg.size * (g.length - 1), files: g.sort() })
    }
  }

  groups.sort((a, b) => b.wasted - a.wasted)
  stats.elapsedMs = Date.now() - stats.startedAt
  stats.phase = '완료'
  return {
    groups: groups.slice(0, maxGroups),
    groupCount: groups.length,
    wastedTotal: groups.reduce((s, g) => s + g.wasted, 0),
    stats,
    cancelled: false,
  }
}

/** 파일 앞 n 바이트(n=0 이면 전체)의 sha1. 못 읽으면 null. */
function hashPart(file, n, crypto) {
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    const h = crypto.createHash('sha1')
    const buf = Buffer.allocUnsafe(1 << 20)
    let read = 0
    for (;;) {
      const want = n > 0 ? Math.min(buf.length, n - read) : buf.length
      if (want <= 0) break
      const got = fs.readSync(fd, buf, 0, want, null)
      if (got <= 0) break
      h.update(buf.subarray(0, got))
      read += got
    }
    return h.digest('hex')
  } catch {
    return null // 다른 프로세스가 잠근 파일(빌드 중 pdb 등) — 조용히 뺀다
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 닫기 실패는 무시 */
      }
    }
  }
}

// ── LLM 판단 ─────────────────────────────────────────────────

const JUDGE_SYSTEM = `너는 Unreal Engine 과 C++ 로 게임을 개발하는 PC 의 디스크 정리를 돕는다.
개발자가 스캔한 폴더 목록을 보고, 각 경로를 **지워도 되는지** 판정한다.

반드시 아래 형태의 JSON 만 출력한다:
{"verdicts":[{"path":"<입력에 있던 경로 그대로>","risk":"safe|caution|keep","reason":"왜 그런지 한 문장","cost":"지웠을 때 치르는 값 한 문장"}]}

risk 기준:
- safe: 도구가 자동으로 다시 만든다. 잃는 것은 시간뿐이다. (빌드 중간 산출물, 캐시, 로그)
- caution: 다시 만들 수는 있으나 값이 크다. (재빌드 필요, 재다운로드, 복구본 소실)
- keep: 지우면 안 된다. 원본·설정·세이브·버전관리 자료.

지켜야 할 것:
- **입력에 있는 경로만** 판정한다. 새 경로를 지어내지 마라.
- 모든 입력 경로에 대해 하나씩 답한다. 빠뜨리지 마라.
- 무엇인지 모르겠으면 safe 라고 하지 마라. 모르면 caution 이나 keep 이다.
- 이름이 캐시처럼 보여도 실제로 다시 받아야 하는 것이면 caution 이다.
- 소스코드(Source), 애셋 원본(Content), 설정(Config), 세이브(SaveGames),
  버전관리 메타(.git/.p4)는 언제나 keep 이다.
- reason·cost 는 한국어로, 개발자가 판단할 수 있게 구체적으로 쓴다.`

/** 후보 + 정체불명 큰 폴더를 한 번에 물어보는 프롬프트. */
function buildJudgePrompt({ candidates, unknowns, projects, engines, drive }) {
  const parts = []
  if (drive) {
    parts.push(`[드라이브] ${drive.drive} — 전체 ${gb(drive.total)}, 남은 공간 ${gb(drive.free)}`)
  }
  if (projects && projects.length) parts.push(`[발견한 UE 프로젝트]\n${projects.slice(0, 20).join('\n')}`)
  if (engines && engines.length) parts.push(`[발견한 엔진 소스 트리]\n${engines.slice(0, 5).join('\n')}`)

  if (candidates.length) {
    parts.push(
      '[규칙이 이미 정리 후보로 본 것] — 규칙 판정이 맞는지 보고, 더 위험하다고 판단되면 조여라.\n' +
        candidates
          .map((c) => `${c.path} | ${gb(c.size)} | 파일 ${c.files}개 | 마지막수정 ${days(c.mtime)} | 규칙판정 ${c.risk} (${c.kind})`)
          .join('\n'),
    )
  }
  if (unknowns.length) {
    parts.push(
      '[규칙이 모르는 큰 폴더] — 무엇인지 판단해라. 확실하지 않으면 caution 또는 keep 이다.\n' +
        unknowns.map((u) => `${u.path} | ${gb(u.size)} | 파일 ${u.files}개 | 마지막수정 ${days(u.mtime)}`).join('\n'),
    )
  }
  parts.push('위 경로 전부에 대해 JSON 으로 판정하라.')
  return parts.join('\n\n')
}

function gb(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}MB`
  return `${Math.round(n / 1024)}KB`
}

function days(mtimeMs) {
  if (!mtimeMs) return '알 수 없음'
  const d = Math.floor((Date.now() - mtimeMs) / 86400000)
  return d <= 0 ? '오늘' : `${d}일 전`
}

const RISK_ORDER = { safe: 0, caution: 1, keep: 2 }

/**
 * 규칙 판정과 LLM 판정을 합친다.
 *
 * ⚠️ **LLM 은 조이기만 한다.** 규칙이 caution 이라고 본 것을 모델이 safe 라고 해도 caution 으로 남는다.
 * 규칙이 모르는 폴더는 아무리 모델이 safe 라 해도 caution 이 상한이다 — 근거가 모델의 말뿐이라
 * 체크박스가 기본으로 켜지면 안 된다.
 */
function mergeVerdicts(items, verdicts) {
  const byPath = new Map()
  for (const v of verdicts || []) {
    if (!v || !v.path) continue
    byPath.set(norm(v.path), v)
  }
  return items.map((it) => {
    const v = byPath.get(norm(it.path))
    if (!v) return { ...it, ai: null }
    const aiRisk = RISK_ORDER[v.risk] == null ? 'caution' : v.risk
    const floor = it.source === 'rule' ? it.risk : 'caution'
    const risk = RISK_ORDER[aiRisk] > RISK_ORDER[floor] ? aiRisk : floor
    return {
      ...it,
      risk,
      ai: { risk: aiRisk, reason: String(v.reason || '').trim(), cost: String(v.cost || '').trim() },
    }
  })
}

// ── 삭제 전 검증 ─────────────────────────────────────────────

/**
 * 이 경로를 지워도 되는가. 삭제 직전 main 에서 한 번 더 부른다 —
 * 화면에서 온 목록을 그대로 믿지 않는다(스캔 뒤 경로가 바뀌었을 수도 있다).
 */
function validateDeletion(p, roots) {
  const abs = String(p || '')
  if (!abs || !path.isAbsolute(abs)) return '경로가 올바르지 않습니다.'
  if (isProtectedPath(abs)) return '보호 대상(시스템·원본·설정)이라 지울 수 없습니다.'
  if (!roots || !roots.length) return '스캔한 폴더 정보가 없습니다. 다시 스캔해 주세요.'
  if (!roots.some((r) => isInside(abs, r) && norm(abs) !== norm(r))) {
    return '이번에 스캔한 폴더 안에 있는 항목만 지울 수 있습니다.'
  }
  if (!fs.existsSync(abs)) return '이미 없는 경로입니다.'
  return null
}

module.exports = {
  listDrives,
  scanTree,
  findDuplicates,
  oldBigDirs,
  collectCandidates,
  unknownBigDirs,
  extOf,
  ageBucket,
  AGE_KEYS,
  AGE_LABEL,
  buildJudgePrompt,
  mergeVerdicts,
  validateDeletion,
  isProtectedPath,
  isInside,
  norm,
  globalCacheRules,
  JUDGE_SYSTEM,
  SYSTEM_ROOTS,
  gb,
}
