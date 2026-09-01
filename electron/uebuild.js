// UE 빌드 감시 — 지금 빌드가 도는가 · 어디까지 갔는가 · **누가 걸었는가**.
//
// Electron API 를 쓰지 않는 순수 Node 모듈이다(disk.js·bts.js 와 같은 이유) — 실제 빌드를
// 상대로 `node -e "require('./uebuild').snapshot().then(console.log)"` 처럼 단독 확인할 수 있어야 한다.
//
// 이 모듈은 **읽기 전용**이다. 빌드를 죽이거나 걸지 않는다 (SPEC — 외부 연동은 읽기만).
//
// 설계에서 네 가지가 중요하다.
//
// 1) **"누가 걸었는가" 는 부모 프로세스 사슬로 답한다.** UBT 프로세스 하나만 봐서는 알 수 없다.
//    VS 가 걸면 `UBT ← cmd ← MSBuild ← devenv.exe`, 에이전트가 걸면
//    `UBT ← cmd(Build.bat) ← powershell ← claude.exe ← … ← Code.exe` 로 사슬이 다르다.
//    사슬 전체를 모아 **우선순위로** 고른다 — 첫 매칭을 쓰면 에이전트가 띄운 빌드도
//    중간의 powershell 때문에 "터미널" 로 잘못 나온다.
//
// 2) **사슬은 끊긴다.** 부모가 먼저 끝나면(MSBuild 는 UBT 보다 자주 먼저 죽는다) 거기서 끝이다.
//    그래서 커맨드라인의 흔적(`-FromMsBuild`, `MSBuildTemp\…exec.cmd`, `Build.bat`)을
//    보조 근거로 남겨 두고, 이 경우 confidence 를 'guess' 로 낮춰 화면에 그대로 알린다.
//    ⚠️ PID 는 재사용된다. 부모의 시작 시각이 자식보다 **늦으면** 그건 남의 PID 다 — 사슬을 끊는다.
//
// 3) **진행률의 근거를 섞지 않는다.** UBA(로컬) 는 `[12/48]` 로 **완료** 개수를 찍고,
//    FASTBuild(분산) 는 그런 줄이 없어 obj 착수 개수로 셀 수밖에 없다. 둘은 의미가 다르므로
//    basis('completed'|'started')를 같이 돌려주고 화면이 그대로 표기한다.
//
// 4) **프로세스 조회는 비싸다.** WMI(Win32_Process) 는 이 PC 에서 한 번에 1.5초쯤 걸리고,
//    그 비용은 필터를 걸어도 거의 줄지 않는다(고정 오버헤드). 그래서 **전체를 한 번만** 읽고
//    부모 사슬은 메모리에서 걷는다. 빌드 기미가 없으면 그 한 번도 건너뛴다(Get-Process 선검사).

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

// ── 프로세스 분류표 ──────────────────────────────────────────

/** 빌드에 관여하는 프로세스. 이 이름들이 사슬 수집의 출발점이 된다. */
const BUILD_NAMES = [
  'dotnet.exe', // UnrealBuildTool.dll 을 이걸로 띄운다 (UE5 기본)
  'UnrealBuildTool.exe',
  'MSBuild.exe',
  'cl.exe',
  'clang-cl.exe',
  'link.exe',
  'lib.exe',
  'rc.exe',
  'mt.exe',
  'cvtres.exe',
  'ispc.exe',
  'UnrealHeaderTool.exe',
  'ShaderCompileWorker.exe',
  'FBuild.exe', // FASTBuild — 사내 분산 빌드
  'FBuildWorker.exe',
  'ib_console.exe', // IncrediBuild
  'BuildConsole.exe',
  'xgConsole.exe',
  'UbaAgent.exe', // Unreal Build Accelerator
  'UbaHost.exe',
  'AutomationTool.exe',
  'UnrealPak.exe',
  'UnrealEditor.exe', // 빌드는 아니지만 링크를 막는 흔한 원인이라 같이 본다
  'UnrealEditor-Cmd.exe',
]

/** 빌드 기미 선검사용 — dotnet 만으로는 빌드라 볼 수 없어 뺀다(다른 앱도 dotnet 을 쓴다). */
const STRONG_HINT_NAMES = [
  'cl',
  'clang-cl',
  'link',
  'lib',
  'MSBuild',
  'UnrealBuildTool',
  'UnrealHeaderTool',
  'ShaderCompileWorker',
  'FBuild',
  'ib_console',
  'BuildConsole',
  'xgConsole',
  'UbaAgent',
  'AutomationTool',
  'UnrealPak',
]

/** 실제로 CPU 를 쓰는 일꾼. 화면의 "일꾼" 요약에 개수로 나간다. */
const WORKER_LABEL = {
  'cl.exe': '컴파일(cl)',
  'clang-cl.exe': '컴파일(clang)',
  'link.exe': '링크',
  'lib.exe': '라이브러리',
  'rc.exe': '리소스',
  'mt.exe': '매니페스트',
  'cvtres.exe': '리소스 변환',
  'ispc.exe': 'ISPC',
  'UnrealHeaderTool.exe': '헤더 생성(UHT)',
  'ShaderCompileWorker.exe': '셰이더',
  'FBuild.exe': 'FASTBuild',
  'FBuildWorker.exe': 'FASTBuild 워커',
  'ib_console.exe': 'IncrediBuild',
  'BuildConsole.exe': 'IncrediBuild',
  'xgConsole.exe': 'IncrediBuild',
  'UbaAgent.exe': 'UBA 에이전트',
  'UbaHost.exe': 'UBA 호스트',
}

/**
 * 빌드를 건 "주체" 후보. 사슬에서 **여러 개가 잡히면 priority 가 작은 쪽**이 이긴다.
 * (에이전트가 powershell 을 거쳐 띄우므로 첫 매칭을 쓰면 언제나 터미널로 나온다.)
 */
const ORIGINS = [
  { kind: 'ci', priority: 0, label: 'CI', match: (n) => /(jenkins|teamcity|buildkite|gitlab-runner|azurepipelines)/i.test(n) },
  { kind: 'claude', priority: 1, label: 'Claude Code', match: (n) => n === 'claude.exe' },
  { kind: 'codex', priority: 1, label: 'Codex', match: (n) => n === 'codex.exe' },
  { kind: 'vs', priority: 2, label: 'Visual Studio', match: (n) => n === 'devenv.exe' },
  { kind: 'rider', priority: 2, label: 'Rider', match: (n) => /^rider(64)?\.exe$/i.test(n) },
  // 에디터에서 Ctrl+Alt+F11 (라이브 코딩). UBT 를 직접 띄우므로 사슬에 그대로 잡힌다.
  { kind: 'editor', priority: 2, label: '라이브 코딩 (UnrealEditor)', match: (n) => /^unrealeditor(-cmd)?\.exe$/i.test(n) },
  { kind: 'meos', priority: 3, label: 'MeOS', match: () => false }, // selfPid 로만 잡는다
  { kind: 'msbuild', priority: 4, label: 'MSBuild', match: (n) => n === 'msbuild.exe' },
  { kind: 'vscode', priority: 5, label: 'VS Code 터미널', match: (n) => n === 'code.exe' },
  {
    kind: 'terminal',
    priority: 6,
    label: '터미널',
    match: (n) => ['windowsterminal.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'mintty.exe', 'conemu64.exe'].includes(n),
  },
  { kind: 'explorer', priority: 7, label: '직접 실행', match: (n) => n === 'explorer.exe' },
]

// ── 프로세스 스냅샷 ──────────────────────────────────────────

/**
 * Win32_Process 를 한 번 읽어 **빌드 프로세스 + 그 조상들** 만 돌려준다.
 *
 * 전체를 읽고 메모리에서 걷는 이유는 파일 맨 위 4) 참고 — 조상마다 WMI 를 다시 물으면
 * 같은 결과에 11초가 걸린다(측정값). 전체 1회는 2.2초쯤.
 */
function probeProcesses({ timeoutMs = 30000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: '이 기능은 Windows 에서만 동작합니다.', procs: [] })

  const nameList = BUILD_NAMES.map((n) => `'${n}'`).join(',')
  const hintList = STRONG_HINT_NAMES.map((n) => `'${n}'`).join(',')

  // PS 안에서 $ 는 그대로 쓴다(JS 템플릿은 ${ 만 가로챈다). ${ 를 쓰지 말 것.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$hints = @(${hintList})
# 빌드 기미가 전혀 없으면 비싼 WMI 조회를 건너뛴다 (대기 상태의 폴링 비용을 1/3 로)
if (-not (Get-Process -Name $hints)) { '{"idle":true,"procs":[]}'; exit 0 }

$want = @{}
foreach ($n in @(${nameList})) { $want[$n] = $true }

$all = @{}
foreach ($p in @(Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,Name,CommandLine,CreationDate FROM Win32_Process")) {
  $all[[int]$p.ProcessId] = $p
}

$out = @{}
function Emit($p, $matched) {
  $id = [int]$p.ProcessId
  if ($out.ContainsKey($id)) { return }
  $out[$id] = [pscustomobject]@{
    pid     = $id
    ppid    = [int]$p.ParentProcessId
    name    = $p.Name
    cmd     = $p.CommandLine
    start   = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null }
    matched = [bool]$matched
  }
}
foreach ($id in @($all.Keys)) { if ($want[$all[$id].Name]) { Emit $all[$id] $true } }

# 조상 걷기 — 메모리 안에서만 돈다
$queue = New-Object System.Collections.Queue
foreach ($k in @($out.Keys)) { [void]$queue.Enqueue($out[$k].ppid) }
while ($queue.Count -gt 0) {
  $id = [int]$queue.Dequeue()
  if ($id -le 0 -or $out.ContainsKey($id) -or -not $all.ContainsKey($id)) { continue }
  Emit $all[$id] $false
  [void]$queue.Enqueue([int]$all[$id].ParentProcessId)
}

@{ idle = $false; procs = @($out.Values) } | ConvertTo-Json -Compress -Depth 4
`.trim()

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 << 20 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: `프로세스를 읽지 못했습니다 — ${err.message}`, procs: [] })
          return
        }
        let json = null
        try {
          json = JSON.parse(String(stdout || '').trim() || 'null')
        } catch {
          resolve({ ok: false, error: '프로세스 목록을 JSON 으로 읽지 못했습니다.', procs: [] })
          return
        }
        if (!json) {
          resolve({ ok: true, idle: true, procs: [] })
          return
        }
        // 하나뿐이면 배열이 아니라 객체로 온다 (ConvertTo-Json 의 오랜 함정)
        const raw = json.procs == null ? [] : Array.isArray(json.procs) ? json.procs : [json.procs]
        resolve({
          ok: true,
          idle: !!json.idle,
          procs: raw.map((p) => ({
            pid: Number(p.pid) || 0,
            ppid: Number(p.ppid) || 0,
            name: String(p.name || ''),
            cmd: p.cmd == null ? '' : String(p.cmd),
            startMs: p.start ? Date.parse(p.start) : null,
            matched: !!p.matched,
          })),
        })
      },
    )
  })
}

// ── 커맨드라인 읽기 ──────────────────────────────────────────

const PLATFORMS = ['Win64', 'Win32', 'Android', 'IOS', 'TVOS', 'Linux', 'LinuxArm64', 'Mac', 'PS4', 'PS5', 'XboxOne', 'XSX', 'Switch', 'HoloLens', 'VisionOS']
const CONFIGS = ['Debug', 'DebugGame', 'Development', 'Test', 'Shipping']

/** 따옴표(그리고 \" 이스케이프)를 존중하며 자른다. UBT 인자는 -Target="A B \"C\"" 처럼 중첩된다. */
function tokenize(cmd) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '\\' && cmd[i + 1] === '"') {
      cur += '"'
      i++
      continue
    }
    if (c === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** 토큰 묶음에서 타겟·플랫폼·구성·프로젝트를 골라낸다. 위치가 아니라 값으로 알아본다. */
function pickTargetSpec(tokens) {
  let target = null
  let platform = null
  let configuration = null
  let project = null
  for (const t of tokens) {
    const pj = /^-Project=(.+)$/i.exec(t)
    if (pj) {
      project = pj[1].replace(/^"|"$/g, '')
      continue
    }
    if (/\.uproject$/i.test(t)) {
      project = t
      continue
    }
    if (t.startsWith('-')) continue
    if (!platform && PLATFORMS.some((p) => p.toLowerCase() === t.toLowerCase())) {
      platform = t
      continue
    }
    if (!configuration && CONFIGS.some((c) => c.toLowerCase() === t.toLowerCase())) {
      configuration = t
      continue
    }
    if (!target) target = t
  }
  return { target, platform, configuration, project }
}

/**
 * UBT 커맨드라인 한 줄 → 빌드 대상들.
 *
 * 두 가지 형태가 온다.
 *  - Build.bat/직접:  `… UnrealBuildTool.dll ProjectTTEditor Win64 Development D:\…\X.uproject -NoHotReload`
 *  - MSBuild(VS):     `… -Target="ProjectTTEditor Win64 DebugGame -Project=\"D:\…\X.uproject\"" -WaitMutex -FromMsBuild`
 */
function parseUbtCommand(cmd) {
  const line = String(cmd || '')
  const fromMsBuild = /-FromMsBuild\b/i.test(line)
  const hotReload = /-HotReload/i.test(line) && !/-NoHotReload/i.test(line)
  // 라이브 코딩은 에디터가 띄운다 — 같은 타겟의 VS 빌드를 막는 원인이 되기도 한다
  const liveCoding = /-LiveCoding\b/i.test(line)

  // ⚠️ 정규식으로 -Target= 를 뜯지 말 것. 따옴표 위치가 두 가지다 —
  //    프로세스 커맨드라인은 `-Target="A B"`, UBT 가 로그에 적어 두는 줄은 `"-Target=A B"`.
  //    토크나이저를 한 번 태우면 둘 다 `-Target=A B` 라는 토큰 하나로 같아진다.
  const toks = tokenize(line)
  const targets = []
  for (const t of toks) {
    const m = /^-Target=([\s\S]*)$/i.exec(t)
    if (m) targets.push(pickTargetSpec(tokenize(m[1])))
  }

  if (!targets.length) {
    // -Target= 이 없는 형태(Build.bat·직접 실행): dll 경로 뒤부터가 인자다.
    const at = toks.findIndex((t) => /UnrealBuildTool\.(dll|exe)$/i.test(t))
    const args = at >= 0 ? toks.slice(at + 1) : toks.slice(1)
    const spec = pickTargetSpec(args)
    if (spec.target) targets.push(spec)
  }

  return { targets, fromMsBuild, hotReload, liveCoding }
}

/** 커맨드라인들에서 엔진 루트(…\Engine 의 부모)를 추려낸다. 가장 많이 나온 것을 쓴다. */
function guessEngineRoot(procs) {
  const tally = new Map()
  const re = /([A-Za-z]:[\\/](?:[^"'|<>\r\n]*?))[\\/]Engine[\\/](?:Binaries|Build|Source|Intermediate|Programs|Plugins)[\\/]/gi
  for (const p of procs) {
    let m
    re.lastIndex = 0
    while ((m = re.exec(p.cmd))) {
      const root = m[1]
      tally.set(root, (tally.get(root) || 0) + 1)
    }
  }
  let best = null
  let bestN = 0
  for (const [root, n] of tally) {
    if (n > bestN) {
      best = root
      bestN = n
    }
  }
  return best
}

// ── 주체 판정 ────────────────────────────────────────────────

/** `~/.claude/sessions/<pid>.json` — 세션 이름·id·작업폴더가 들어 있다. 없으면 조용히 넘긴다. */
function readClaudeSession(pid) {
  try {
    const p = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (Number(j.pid) !== Number(pid)) return null
    return {
      name: j.name || null,
      sessionId: j.sessionId || null,
      cwd: j.cwd || null,
      status: j.status || null,
    }
  } catch {
    return null
  }
}

/** 실행 파일 이름만 (경로·인자 제거). 주체 라벨의 보조 설명에 쓴다. */
function exeOf(cmd) {
  const t = tokenize(String(cmd || ''))[0] || ''
  return t ? path.basename(t) : ''
}

/** 사슬에서 이 밑으로는 "그냥 배관" 이다 — cmd/powershell 은 UBT 를 띄우는 통로일 뿐. */
const WEAK_PRIORITY = 5

/**
 * 프로세스 하나의 부모 사슬을 걷고, 그 안에서 빌드를 건 주체를 고른다.
 *
 * ⚠️ PID 재사용 방어 — 부모가 자식보다 **나중에** 시작했다면 그건 남의 PID 다. 거기서 끊는다.
 */
function walkChain(proc, byPid) {
  const chain = []
  const seen = new Set()
  let cur = proc
  let truncated = true
  while (cur && !seen.has(cur.pid) && chain.length < 24) {
    seen.add(cur.pid)
    chain.push({ pid: cur.pid, name: cur.name, cmd: cur.cmd, startMs: cur.startMs })
    if (cur.ppid <= 0) {
      truncated = false // 뿌리까지 갔다
      break
    }
    const parent = byPid.get(cur.ppid)
    if (!parent) break // 부모가 이미 종료 — 여기서 끊긴다
    if (cur.startMs != null && parent.startMs != null && parent.startMs > cur.startMs) break // PID 재사용
    // explorer 까지 닿았으면 로그온 세션의 뿌리다. 더 올라가도 얻을 게 없다.
    if (parent.name.toLowerCase() === 'explorer.exe') {
      chain.push({ pid: parent.pid, name: parent.name, cmd: parent.cmd, startMs: parent.startMs })
      truncated = false
      break
    }
    cur = parent
  }
  return { chain, truncated }
}

/**
 * 빌드를 건 주체.
 *
 * 사슬에서 찾은 후보와 **커맨드라인의 흔적**을 같은 저울에 올린다. 흔적을 "사슬에서 아무도
 * 못 찾았을 때만" 쓰면, VS 빌드인데 MSBuild 가 먼저 죽은 흔한 경우에 바로 위 cmd.exe 가
 * 잡혀 "터미널" 이라고 **단정**해 버린다 — 틀린 답을 자신 있게 말하는 게 제일 나쁘다.
 * `-FromMsBuild` 는 UBT 자신이 남긴 표시라 죽은 부모보다 오히려 근거가 세다.
 */
function classifyOrigin(proc, byPid, { selfPid = 0 } = {}) {
  const { chain, truncated } = walkChain(proc, byPid)
  const chainOut = chain.map((n) => ({ pid: n.pid, name: n.name }))
  const cands = []

  chain.slice(1).forEach((node, i) => {
    // 자기 자신(UBT)은 후보가 아니다
    const lower = node.name.toLowerCase()
    const hit = selfPid && node.pid === selfPid ? ORIGINS.find((o) => o.kind === 'meos') : ORIGINS.find((o) => o.match(lower))
    if (!hit) return
    // 끊긴 사슬에서 배관(cmd·powershell)만 잡힌 건 근거가 못 된다 — 추측으로 낮춘다
    const weak = hit.priority >= WEAK_PRIORITY
    cands.push({ spec: hit, node, depth: i, priority: hit.priority, confidence: weak && truncated ? 'guess' : 'certain' })
  })

  const all = chain.map((n) => n.cmd || '').join(' ')
  if (/-FromMsBuild\b/i.test(all) || /MSBuildTemp/i.test(all)) {
    cands.push({
      spec: { kind: 'vs', label: 'Visual Studio' },
      node: null,
      // 살아 있는 devenv(2) 보다는 약하고, 배관(5~7) 보다는 세다
      priority: 2.5,
      confidence: 'guess',
      detail: 'UBT 인자의 -FromMsBuild 로 추정',
    })
  }
  if (/Build\.bat/i.test(all)) {
    cands.push({
      spec: { kind: 'terminal', label: '명령줄 (Build.bat)' },
      node: null,
      priority: 6.5,
      confidence: 'guess',
      detail: '누가 그 배치를 띄웠는지는 부모가 남아 있어야 알 수 있다',
    })
  }

  if (!cands.length) {
    return { kind: 'unknown', label: '알 수 없음', detail: '부모 프로세스가 이미 종료됨', pid: null, confidence: 'guess', chain: chainOut }
  }

  // 같은 값이면:
  //  - 배관(터미널·셸)은 **바깥쪽**이 답이다. UBT 바로 위 cmd 는 Build.bat 을 태우는 통로일 뿐,
  //    사람이 실제로 앉아 있던 건 그 위의 WindowsTerminal 이다.
  //  - 반대로 강한 주체(claude·devenv)는 **안쪽**이 답이다. 세션 안에 세션이 겹쳐 있으면
  //    빌드를 실제로 띄운 건 가장 가까운 쪽이다.
  cands.sort((a, b) => a.priority - b.priority || (a.priority >= WEAK_PRIORITY ? b.depth - a.depth : a.depth - b.depth))
  const best = cands[0]
  const o = {
    kind: best.spec.kind,
    label: best.spec.label,
    detail: best.detail ?? null,
    pid: best.node ? best.node.pid : null,
    confidence: best.confidence,
    chain: chainOut,
  }

  if (best.node) {
    if (o.kind === 'claude') {
      const s = readClaudeSession(best.node.pid)
      if (s) {
        o.detail = s.name ? `세션 “${s.name}”` : s.cwd || null
        o.session = s
      }
    } else if (o.kind === 'vs' || o.kind === 'rider') {
      // devenv 인자에 .sln 이 들어 있다 — 어느 솔루션인지까지 보여 준다
      const sln = tokenize(best.node.cmd || '').find((t) => /\.(sln|uproject)$/i.test(t))
      if (sln) o.detail = path.basename(sln)
    } else if (o.kind === 'terminal' || o.kind === 'vscode' || o.kind === 'explorer') {
      o.detail = exeOf(best.node.cmd) || null
    }
  }
  return o
}

// ── UBT 로그 읽기 ────────────────────────────────────────────

/**
 * 파일의 **앞머리와 꼬리**를 따로 읽는다. 로그는 수십 MB 가 되기도 해서 통째로는 못 읽는데,
 * 필요한 정보가 양쪽 끝에 나뉘어 있다 —
 *   앞: `Command line:` (무엇을 빌드하는지), `Log started at`
 *   뒤: 지금 무엇을 하고 있는지, 총 소요 시간, 오류
 * 꼬리만 읽으면 580KB 짜리 로그에서 커맨드라인을 놓친다(실제로 겪었다).
 */
function readHeadTail(file, { headBytes, tailBytes }) {
  const st = fs.statSync(file)
  const fd = fs.openSync(file, 'r')
  try {
    const read = (start, len) => {
      if (len <= 0) return ''
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, start)
      return buf.subarray(0, n).toString('utf8')
    }
    // 통째로 들어오면 한 번만 읽어 양쪽에 같이 쓴다
    if (st.size <= tailBytes) {
      const all = read(0, st.size)
      return { head: all, tail: all, size: st.size, mtimeMs: st.mtimeMs, truncated: false }
    }
    const tailStart = st.size - tailBytes
    // 겹쳐도 그냥 둔다 — head 는 `Command line:` 한 줄을 찾는 데만 쓰고, 진행 해석은 tail 로만 한다
    return {
      head: read(0, headBytes),
      tail: read(tailStart, st.size - tailStart),
      size: st.size,
      mtimeMs: st.mtimeMs,
      truncated: true,
    }
  } finally {
    fs.closeSync(fd)
  }
}

const ERR_RE = /(?:\berror\s+(?:C\d{4}|LNK\d{4}|MSB\d+)\b|:\s*fatal error\b|^ERROR:|\bBuild failed\b)/i

/**
 * 로그 꼬리를 읽어 지금 무엇을 하고 있는지 뽑는다.
 *
 * 실행기가 둘이라 형식이 다르다.
 *  - UBA(로컬):    `------ Building 8 action(s) started ------` 뒤로 `[3/8] Compile [x64] Foo.cpp`
 *  - FASTBuild(분산): `Using FASTBuild executor to run 48 action(s)` 뒤로 `-> Obj: …  <REMOTE: 10.10.10.78>`
 *
 * 마지막 "실행 시작" 표시부터만 해석한다 — 그 앞은 준비 단계(모듈 수집·헤더 파싱)라
 * 지금 진행률과 섞으면 숫자가 거짓이 된다.
 */
function parseLogTail(text) {
  const lines = text.split(/\r?\n/)

  // 실행 시작 지점 찾기 (뒤에서부터)
  let startIdx = 0
  let executor = null
  let total = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    let m = /Using (.+?) executor to run (\d+) action\(s\)/i.exec(l)
    if (m) {
      executor = m[1].trim()
      total = Number(m[2])
      startIdx = i
      break
    }
    m = /-{2,}\s*Building (\d+) action\(s\) started\s*-{2,}/i.exec(l)
    if (m) {
      total = Number(m[1])
      startIdx = i
      // UBA 는 실행기 이름을 이 줄보다 **앞에** 찍는다 ("Using … executor to run N action(s)").
      // 바로 위 몇 줄만 되짚어 이름을 채운다 — 없으면 비워 둔다.
      for (let j = i - 1; j >= 0 && j >= i - 20; j--) {
        const e = /Using (.+?) executor to run \d+ action\(s\)/i.exec(lines[j])
        if (e) {
          executor = e[1].trim()
          break
        }
      }
      break
    }
  }

  const body = lines.slice(startIdx)

  let done = null
  let basis = null
  const actions = [] // 최근에 손댄 것들 (화면에 몇 줄만 보여 준다)
  const objs = new Set()
  const agents = new Map() // ip → ok/failed
  const errors = []
  let phase = 'prepare'
  let totalSeconds = null
  let building = null
  let commandLine = null

  // UBT 는 자기 커맨드라인을 로그 앞부분에 적어 둔다. 프로세스가 이미 사라진 뒤에도
  // **무엇을 빌드했는지**는 여기서 되살릴 수 있다 (누가 걸었는지까지는 알 수 없다).
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^Command line:\s*(.+)$/i.exec(lines[i])
    if (m) {
      commandLine = m[1].trim()
      break
    }
  }

  for (const l of body) {
    let m

    if ((m = /^\s*\[(\d+)\/(\d+)\]\s+(.+)$/.exec(l))) {
      // UBA — 완료 개수를 그대로 준다
      done = Number(m[1])
      total = Number(m[2])
      basis = 'completed'
      actions.push(m[3].trim())
      if (/^Link\b/i.test(m[3])) phase = 'link'
      else if (/^Compile\b/i.test(m[3])) phase = 'compile'
      continue
    }

    if ((m = /(?:->|^\s*\d+>)\s*Obj:\s*(.+?)(?:\s*<(REMOTE:\s*[\d.]+|LOCAL[^>]*)>)?\s*$/.exec(l))) {
      // FASTBuild — 완료 표시가 없어 **착수** 개수로 셀 수밖에 없다
      const p = m[1].trim()
      objs.add(p)
      actions.push(`Compile ${path.basename(p)}${m[2] ? ` (${m[2].replace(/\s+/g, ' ')})` : ''}`)
      phase = 'compile'
      continue
    }

    if ((m = /^\s*Got Result:\s*([\d.]+)\s*-\s*(.+)$/.exec(l))) {
      objs.add(m[2].trim())
      continue
    }

    if ((m = /^\s*Run:\s*(.+\.(?:lib|dll|exe))\s*$/i.exec(l))) {
      actions.push(`Link ${path.basename(m[1])}`)
      phase = 'link'
      continue
    }

    if ((m = /^\s*Linking:\s*(.+)$/i.exec(l))) {
      actions.push(`Link ${m[1].trim()}`)
      phase = 'link'
      continue
    }

    if ((m = /^\s*Compile module:\s*(.+)$/i.exec(l))) {
      actions.push(`모듈 ${m[1].trim()}`)
      continue
    }

    if ((m = /^\s*Parsing headers for\s+(.+)$/i.exec(l))) {
      actions.push(`헤더 파싱 ${m[1].trim()}`)
      continue
    }

    if ((m = /^\s*Connecting to:\s*([\d.]+)/i.exec(l))) {
      if (!agents.has(m[1])) agents.set(m[1], null)
      continue
    }
    if ((m = /^\s*-\s*connection:\s*([\d.]+)\s*\((OK|FAILED)\)/i.exec(l))) {
      agents.set(m[1], m[2].toUpperCase() === 'OK')
      continue
    }
    if ((m = /^\s*(\d+)\s+workers found in/i.exec(l))) {
      actions.push(`분산 워커 ${m[1]}대 확보`)
      continue
    }

    if ((m = /^\s*Building (.+?)\.\.\.\s*$/i.exec(l))) {
      building = m[1].trim()
      continue
    }

    if (/^\s*Targets? (?:are|is) up to date\s*$/i.test(l)) {
      // 고칠 게 없어 아무것도 안 한 실행. "완료 · 246초" 만 보여 주면 무엇이 빌드됐는지
      // 오해하게 된다 — 따로 구분한다.
      phase = 'uptodate'
      continue
    }

    if ((m = /^Total execution time:\s*([\d.]+)\s*seconds/i.exec(l))) {
      totalSeconds = Number(m[1])
      if (phase !== 'uptodate' && phase !== 'error') phase = 'done'
      continue
    }

    if (ERR_RE.test(l)) {
      const t = l.trim()
      if (t && !errors.includes(t)) errors.push(t)
      phase = 'error'
    }
  }

  if (done == null && objs.size) {
    done = objs.size
    basis = 'started'
  }
  if (phase === 'prepare' && (done != null || total != null)) phase = 'compile'

  const progress = total ? { done: Math.min(done ?? 0, total), total, basis: basis || 'started' } : null

  return {
    executor,
    phase,
    building,
    commandLine,
    /** 프로세스가 없어도 무엇을 빌드했는지는 로그의 커맨드라인으로 되살린다 */
    targets: commandLine ? parseUbtCommand(commandLine).targets : [],
    progress,
    actions: actions.slice(-12),
    agents: [...agents].map(([ip, ok]) => ({ ip, ok })),
    errors: errors.slice(-12),
    totalSeconds,
    tail: lines.filter((l) => l.trim()).slice(-40),
  }
}

/** UBT 로그 파일 위치. 엔진 루트만 알면 정해진다. */
function ubtLogPath(engineRoot) {
  return path.join(engineRoot, 'Engine', 'Programs', 'UnrealBuildTool', 'Log.txt')
}

/**
 * 로그를 읽어 상태로 바꾼다.
 * freshMs 안에 갱신된 로그만 "지금 이 빌드의 것" 으로 본다 — 어제 로그의 진행률을
 * 오늘 화면에 띄우면 그건 거짓말이다.
 */
function readUbtLog(engineRoot, { maxBytes = 512 * 1024, headBytes = 128 * 1024, freshMs = 120000 } = {}) {
  if (!engineRoot) return null
  const file = ubtLogPath(engineRoot)
  let t
  try {
    t = readHeadTail(file, { headBytes, tailBytes: maxBytes })
  } catch (e) {
    return { path: file, ok: false, error: e.code === 'ENOENT' ? '로그 파일이 아직 없습니다.' : e.message }
  }
  const parsed = parseLogTail(t.tail)
  // 커맨드라인은 앞머리에 있다 — 꼬리에서 못 찾았으면 거기서 가져온다
  if (!parsed.commandLine) {
    const m = /^Command line:\s*(.+)$/im.exec(t.head)
    if (m) {
      parsed.commandLine = m[1].trim()
      parsed.targets = parseUbtCommand(parsed.commandLine).targets
    }
  }
  const age = Date.now() - t.mtimeMs
  return {
    ok: true,
    path: file,
    size: t.size,
    mtime: new Date(t.mtimeMs).toISOString(),
    ageMs: age,
    fresh: age <= freshMs,
    ...parsed,
  }
}

// ── 엔진 찾기 ────────────────────────────────────────────────

/**
 * 이 PC 에 등록된 UE 엔진들.
 *
 * 설정을 시키지 않으려고 넣었다. 소스 빌드 엔진은 레지스트리
 * `HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds` 에, 런처 설치본은
 * `HKLM\SOFTWARE\EpicGames\Unreal Engine\<버전>\InstalledDirectory` 에 적혀 있다.
 * 마지막 빌드 로그 시각(logMtime)까지 같이 돌려주므로, **가장 최근에 빌드한 엔진**을
 * 기본값으로 고를 수 있다.
 *
 * ⚠️ status 폴링에서는 부르지 않는다 (PowerShell 한 번 = 0.6초). 설정을 읽을 때만.
 */
function listEngines({ timeoutMs = 20000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve([])
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.ArrayList
$b = Get-ItemProperty -Path 'HKCU:\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds'
if ($b) {
  foreach ($p in $b.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    [void]$out.Add([pscustomobject]@{ id = $p.Name; root = [string]$p.Value; source = 'source' })
  }
}
foreach ($k in @(Get-ChildItem -Path 'HKLM:\\SOFTWARE\\EpicGames\\Unreal Engine')) {
  $d = (Get-ItemProperty $k.PSPath).InstalledDirectory
  if ($d) { [void]$out.Add([pscustomobject]@{ id = $k.PSChildName; root = [string]$d; source = 'launcher' }) }
}
@($out) | ConvertTo-Json -Compress -Depth 3
`.trim()

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 },
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
        const rows = json == null ? [] : Array.isArray(json) ? json : [json]
        const out = []
        const seen = new Set()
        for (const r of rows) {
          const root = path.normalize(String(r.root || '').replace(/[\\/]+$/, ''))
          if (!root || seen.has(root.toLowerCase())) continue
          seen.add(root.toLowerCase())
          // UBT 가 있는 곳만 — 등록만 돼 있고 지운 엔진이 흔하다
          if (!fs.existsSync(path.join(root, 'Engine', 'Binaries', 'DotNET'))) continue
          let logMtime = null
          try {
            logMtime = fs.statSync(ubtLogPath(root)).mtimeMs
          } catch {
            /* 아직 빌드한 적 없는 엔진 */
          }
          out.push({
            root,
            source: r.source === 'launcher' ? 'launcher' : 'source',
            name: path.basename(root),
            logMtime: logMtime ? new Date(logMtime).toISOString() : null,
          })
        }
        // 최근에 빌드한 엔진이 위로
        out.sort((a, b) => (b.logMtime ? Date.parse(b.logMtime) : 0) - (a.logMtime ? Date.parse(a.logMtime) : 0))
        resolve(out)
      },
    )
  })
}

// ── 스냅샷 ───────────────────────────────────────────────────

/**
 * 지금 상태 한 벌. 화면은 이걸 주기적으로 받아 그리기만 한다.
 *
 * engineRoot 를 몰라도 동작한다 — 도는 빌드의 커맨드라인에서 찾아낸다. 찾아낸 값은
 * main 이 설정에 적어 두므로, 빌드가 없을 때도 마지막 로그를 읽을 수 있다.
 */
async function snapshot({ engineRoot = '', selfPid = 0 } = {}) {
  const at = new Date().toISOString()
  if (process.platform !== 'win32') {
    return { ok: false, platformOk: false, at, error: '이 기능은 Windows 에서만 동작합니다.', builds: [], workers: [], editors: [] }
  }

  const probe = await probeProcesses()
  if (!probe.ok) {
    return { ok: false, platformOk: true, at, error: probe.error, builds: [], workers: [], editors: [] }
  }

  const procs = probe.procs
  const byPid = new Map(procs.map((p) => [p.pid, p]))

  // UBT 인스턴스 = 빌드 한 건. dotnet 은 UnrealBuildTool.dll 을 물고 있을 때만 센다.
  const ubts = procs.filter(
    (p) =>
      p.matched &&
      (/^UnrealBuildTool\.exe$/i.test(p.name) || (/^dotnet\.exe$/i.test(p.name) && /UnrealBuildTool\.dll/i.test(p.cmd))),
  )

  const detected = guessEngineRoot(procs)
  const root = engineRoot || detected || ''

  const now = Date.now()
  const builds = ubts.map((p) => {
    const parsed = parseUbtCommand(p.cmd)
    return {
      pid: p.pid,
      startedAt: p.startMs ? new Date(p.startMs).toISOString() : null,
      elapsedMs: p.startMs ? now - p.startMs : null,
      targets: parsed.targets,
      fromMsBuild: parsed.fromMsBuild,
      hotReload: parsed.hotReload,
      liveCoding: parsed.liveCoding,
      origin: classifyOrigin(p, byPid, { selfPid }),
      commandLine: p.cmd,
    }
  })
  builds.sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0))

  // 일꾼 요약 — 이름별 개수. UBT 자신과 에디터는 뺀다.
  const counts = new Map()
  for (const p of procs) {
    if (!p.matched) continue
    if (/^UnrealEditor(-Cmd)?\.exe$/i.test(p.name)) continue
    if (/^dotnet\.exe$/i.test(p.name) || /^UnrealBuildTool\.exe$/i.test(p.name)) continue
    if (/^MSBuild\.exe$/i.test(p.name)) continue
    const label = WORKER_LABEL[p.name] || p.name.replace(/\.exe$/i, '')
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  const workers = [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)

  // 에디터가 떠 있으면 링크 단계에서 dll 을 못 덮어써 빌드가 깨진다 — 흔한 원인이라 따로 알린다
  const editors = procs
    .filter((p) => p.matched && /^UnrealEditor(-Cmd)?\.exe$/i.test(p.name))
    .map((p) => ({ pid: p.pid, name: p.name, startedAt: p.startMs ? new Date(p.startMs).toISOString() : null }))

  const log = readUbtLog(root)

  return {
    ok: true,
    platformOk: true,
    at,
    running: builds.length > 0,
    idle: !!probe.idle,
    engineRoot: root,
    engineRootDetected: detected || null,
    engineRootFromConfig: !!engineRoot,
    builds,
    workers,
    editors,
    log,
  }
}

module.exports = {
  snapshot,
  listEngines,
  probeProcesses,
  parseUbtCommand,
  parseLogTail,
  classifyOrigin,
  guessEngineRoot,
  readUbtLog,
  ubtLogPath,
  BUILD_NAMES,
}
