// 관리자 권한 — 지금 권한 확인 · 승격해서 다시 열기 · "항상 관리자로" 설정.
//
// 디스크 정리 때문에 생긴 모듈이다. 관리자가 아니면 두 군데서 조용히 막힌다:
// 스캔은 남의 폴더를 못 읽어 그냥 건너뛰고(결과가 모자란 줄도 모른다), 삭제는
// "Failed to perform delete operation" 한 줄만 남기고 실패한다.
//
// 설계에서 두 가지가 중요하다.
//
// 1) **UAC 를 먼저, 종료는 나중.** 앱을 먼저 닫고 승격 실행을 걸면, 사용자가 UAC 를
//    취소했을 때 앱만 사라진다. 그래서 순서를 뒤집었다 — 승격 프로세스를 먼저 띄우고
//    (취소하면 아무 일도 안 일어난다), 성공했을 때만 이쪽이 물러난다.
//    새 인스턴스는 `--pp-wait-pid=<pid>` 로 이쪽이 죽기를 기다린다(main.js 맨 위).
//    단일 인스턴스 잠금 때문이다 — 안 기다리면 새 인스턴스가 그대로 죽는다.
//
// 2) **항상 관리자로 = 레지스트리 Layers.** exe 매니페스트를 requireAdministrator 로
//    바꾸면 되돌리려고 재빌드를 해야 하고, 개발 모드(electron.exe)에는 아예 못 건다.
//    AppCompatFlags\Layers 는 사용자별 설정이라 관리자 권한 없이 켜고 끌 수 있다.

const { execFile } = require('node:child_process')

const isWin = process.platform === 'win32'

/** PowerShell 한 줄 실행. 실패해도 던지지 않는다 — 코드와 출력을 그대로 돌려준다. */
function ps(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          spawnError: err && typeof err.code === 'string' ? err.code : null,
          out: String(stdout || '').trim(),
          err: String(stderr || '').trim(),
        })
      },
    )
  })
}

/** PowerShell 문자열 리터럴. 경로에 작은따옴표가 들어가는 일은 드물지만 값을 그대로 넘기면 안 된다. */
function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// ── 지금 관리자인가 ────────────────────────────────────────

let elevatedCache = null

/**
 * 관리자 권한으로 돌고 있는지.
 *
 * fltmc 로 본다 — 관리자가 아니면 종료 코드가 0 이 아니다. Vista 부터 늘 있고 30ms 면 끝난다
 * (PowerShell 을 띄우면 300ms 다). fltmc 가 없거나 이상하게 끝나면 PowerShell 로 되짚는다.
 * 세션 안에서 권한이 바뀌는 일은 없으니 한 번만 재고 캐시한다.
 */
function isElevated() {
  if (!isWin) return Promise.resolve(false)
  if (elevatedCache) return elevatedCache
  elevatedCache = new Promise((resolve) => {
    execFile('fltmc.exe', [], { windowsHide: true, timeout: 8000 }, (err) => {
      if (!err) return resolve(true)
      // 종료 코드로 실패한 것이면 "관리자 아님" 이 확실하다.
      if (typeof err.code === 'number' && !err.killed) return resolve(false)
      // 실행 자체가 안 됐다(ENOENT·타임아웃) — 다른 방법으로 다시 묻는다.
      resolve(psIsElevated())
    })
  })
  return elevatedCache
}

async function psIsElevated() {
  const r = await ps(
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    10000,
  )
  return /^true$/i.test(r.out)
}

// ── 승격해서 다시 열기 ─────────────────────────────────────

const WAIT_FLAG = '--pp-wait-pid='

/**
 * 지금 앱을 관리자 권한으로 다시 띄운다. **이 함수는 지금 앱을 닫지 않는다** —
 * 성공을 확인한 쪽(main.js)이 닫는다. UAC 를 취소하면 아무 일도 없었던 것이 된다.
 *
 * 돌려주는 값: { ok } · { ok:false, cancelled:true } (UAC 거부) · { ok:false, error }
 */
async function relaunchElevated() {
  if (!isWin) return { ok: false, error: 'Windows 에서만 됩니다.' }

  // 개발 모드에서는 execPath 가 electron.exe 고 argv[1] 이 앱 폴더('.')다 — 그대로 넘긴다.
  const args = process.argv.slice(1).filter((a) => !a.startsWith(WAIT_FLAG))
  args.push(`${WAIT_FLAG}${process.pid}`)

  const script =
    `$ErrorActionPreference='Stop'; try { Start-Process -FilePath ${q(process.execPath)} ` +
    `-ArgumentList @(${args.map(q).join(',')}) -WorkingDirectory ${q(process.cwd())} -Verb RunAs | Out-Null; exit 0 } ` +
    `catch { exit 5 }`

  const r = await ps(script, 120000) // UAC 창을 사람이 볼 시간을 준다
  if (r.code === 0) return { ok: true }
  if (r.code === 5) return { ok: false, cancelled: true }
  return { ok: false, error: r.err || `승격 실행 실패 (코드 ${r.code})` }
}

// ── "항상 관리자로 실행" (AppCompatFlags\Layers) ───────────

const LAYERS = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'

/**
 * 이 exe 에 걸려 있는 호환성 레이어 값. 없으면 빈 문자열.
 * 키 전체를 JSON 으로 받아 Node 에서 찾는다 — 값 이름이 경로라서 -Name 으로 집으면 따옴표가 지저분해진다.
 */
async function readLayers(exePath) {
  const r = await ps(
    `if (Test-Path ${q(LAYERS)}) { Get-ItemProperty -Path ${q(LAYERS)} | ConvertTo-Json -Compress -Depth 2 } else { '{}' }`,
    15000,
  )
  if (r.code !== 0) return { ok: false, value: '', error: r.err || '레지스트리를 읽지 못했습니다.' }
  let json = null
  try {
    json = JSON.parse(r.out || '{}')
  } catch {
    return { ok: false, value: '', error: '레지스트리 응답을 읽지 못했습니다.' }
  }
  const want = String(exePath).toLowerCase()
  for (const [k, v] of Object.entries(json || {})) {
    if (k.toLowerCase() === want) return { ok: true, value: String(v ?? '') }
  }
  return { ok: true, value: '' }
}

/** 항상 관리자로 실행하도록 설정돼 있는지. */
async function getAlwaysAdmin(exePath) {
  if (!isWin) return { ok: true, on: false }
  const r = await readLayers(exePath)
  if (!r.ok) return { ok: false, on: false, error: r.error }
  return { ok: true, on: /\bRUNASADMIN\b/i.test(r.value) }
}

/**
 * 항상 관리자로 실행 설정을 켜고 끈다.
 *
 * ⚠️ 같은 값에 다른 레이어(HIGHDPIAWARE 등)가 같이 들어 있을 수 있다. 통째로 덮어쓰면
 *    남의 설정을 지운다 — 토큰 단위로 RUNASADMIN 만 넣고 뺀다.
 */
async function setAlwaysAdmin(exePath, on) {
  if (!isWin) return { ok: false, error: 'Windows 에서만 됩니다.' }
  const cur = await readLayers(exePath)
  if (!cur.ok) return { ok: false, error: cur.error }

  const tokens = cur.value.split(/\s+/).filter((t) => t && t !== '~' && !/^RUNASADMIN$/i.test(t))
  if (on) tokens.push('RUNASADMIN')

  const script = tokens.length
    ? `New-Item -Path ${q(LAYERS)} -Force | Out-Null; ` +
      `Set-ItemProperty -Path ${q(LAYERS)} -Name ${q(exePath)} -Value ${q(`~ ${tokens.join(' ')}`)}`
    : `if (Test-Path ${q(LAYERS)}) { Remove-ItemProperty -Path ${q(LAYERS)} -Name ${q(exePath)} -ErrorAction SilentlyContinue }`

  const r = await ps(script, 15000)
  if (r.code !== 0) return { ok: false, error: r.err || '설정을 저장하지 못했습니다.' }
  return { ok: true, on: !!on }
}

module.exports = {
  WAIT_FLAG,
  isElevated,
  relaunchElevated,
  getAlwaysAdmin,
  setAlwaysAdmin,
}
