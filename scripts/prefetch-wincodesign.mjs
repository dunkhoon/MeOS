// electron-builder 의 winCodeSign 캐시를 미리 채운다 (Windows 전용, 실패해도 빌드는 계속 진행).
//
// 왜 필요한가: winCodeSign 아카이브 안에는 macOS 용 .dylib 심볼릭 링크가 들어 있는데,
// Windows 는 개발자 모드/관리자 권한 없이는 심링크를 못 만든다. 그래서 압축 해제가 통째로
// 실패하고 빌드가 멈춘다 — 정작 Windows 빌드에 darwin/ 폴더는 쓰지도 않는데.
// 여기서 darwin/ 만 빼고 직접 풀어 캐시에 넣어두면 electron-builder 가 그대로 가져다 쓴다.
//
// (개발자 모드를 켠 PC 에서는 이 스크립트가 없어도 정상 동작한다.)

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'win32') {
  console.log('· Windows 가 아니라 건너뜁니다.')
  process.exit(0)
}

const cacheRoot =
  process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
const dir = path.join(cacheRoot, 'winCodeSign')
const sza = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const appBuilder = path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')

/** 이미 winCodeSign-<버전> 폴더가 있으면 할 일 없음. */
function existingVersionDir() {
  try {
    return readdirSync(dir).find((n) => n.startsWith('winCodeSign-') && statSync(path.join(dir, n)).isDirectory())
  } catch {
    return undefined
  }
}

const already = existingVersionDir()
if (already) {
  console.log(`✓ winCodeSign 캐시 준비됨 (${already})`)
  process.exit(0)
}

if (!existsSync(sza) || !existsSync(appBuilder)) {
  console.log('· 빌드 도구가 아직 설치되지 않아 건너뜁니다 (npm install 후 다시 시도).')
  process.exit(0)
}

// app-builder 가 아카이브를 내려받게 한다. 압축 해제는 심링크 때문에 실패하지만,
// 받아온 .7z 는 캐시에 남으므로 그걸 우리가 직접 푼다.
let out = ''
try {
  out = execFileSync(appBuilder, ['download-artifact', '--name', 'winCodeSign'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SZA_PATH: sza },
  })
} catch (e) {
  out = `${e.stdout || ''}${e.stderr || ''}`
}

// 개발자 모드가 켜져 있으면 여기서 이미 성공한다
const nowExists = existingVersionDir()
if (nowExists) {
  console.log(`✓ winCodeSign 캐시 준비됨 (${nowExists})`)
  process.exit(0)
}

// 다운로드 URL 에서 winCodeSign-<버전> 을 뽑는다 (버전 하드코딩 회피)
const m = out.match(/winCodeSign-([\d.]+)\.7z/)
if (!m) {
  console.log('· winCodeSign 버전을 알아내지 못해 건너뜁니다. electron-builder 기본 경로로 진행합니다.')
  process.exit(0)
}
const name = `winCodeSign-${m[1]}`

// 남아 있는 임시 .7z 중 가장 최근 것
let archive
try {
  archive = readdirSync(dir)
    .filter((n) => n.endsWith('.7z'))
    .map((n) => ({ n, t: statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.n
} catch {
  /* 캐시 폴더 자체가 없으면 아래에서 걸린다 */
}
if (!archive) {
  console.log('· 내려받은 아카이브를 찾지 못해 건너뜁니다.')
  process.exit(0)
}

try {
  execFileSync(sza, ['x', '-bd', '-y', `-o${path.join(dir, name)}`, path.join(dir, archive), '-x!darwin'], {
    stdio: 'ignore',
  })
} catch (e) {
  console.log('· 압축 해제 실패, 건너뜁니다:', e.message)
  process.exit(0)
}

// 실패한 임시 폴더/아카이브 청소
for (const n of readdirSync(dir)) {
  if (/^\d+(\.7z)?$/.test(n)) rmSync(path.join(dir, n), { recursive: true, force: true })
}

console.log(`✓ winCodeSign 캐시 준비됨 (${name}, darwin/ 제외)`)
