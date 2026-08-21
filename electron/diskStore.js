// 디스크 스캔 결과 보관소 — 스캔 1회 = 파일 한 벌.
//
// 스캔은 D:\ 기준 6분이 걸린다. 화면을 잠깐 옮겼다고 그 결과가 사라지면 다시 6분을 쓴다.
// 그래서 끝난 스캔은 무조건 여기 저장하고, 화면은 켤 때 **가장 최근 것**을 도로 읽어 온다.
// 지난 스캔도 목록에서 골라 다시 볼 수 있다 — "지난주엔 얼마였지" 를 비교할 수 있어야 한다.
//
// 파일이 둘인 이유: 목록을 그릴 때 본문(수 MB)까지 읽으면 느리다.
//   <id>.json       — 스캔 결과 전체 (트리·후보·큰 파일 …)
//   <id>.meta.json  — 목록용 요약 몇 줄 (경로·시각·용량·후보 수)
//
// Electron API 를 쓰지 않는 순수 Node 모듈이라 단독으로 테스트할 수 있다.

const fs = require('node:fs')
const path = require('node:path')

/** 한 폴더에 남겨 두는 스캔 개수. 하나가 수백 KB~수 MB 라 무한정 쌓지 않는다. */
const KEEP = 20

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 2026-08-21 17:52:03 → 20260821-175203 */
function stamp(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  )
}

/** 'D:\\Work\\TT' → 'D_Work_TT' (파일명에 쓸 수 있게) */
function rootSlug(root) {
  return String(root || '')
    .replace(/[\\/:]+/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'scan'
}

/**
 * 바깥 경로로 새는 id 를 막는다.
 * 렌더러(원격 페이지)가 넘겨준 값을 그대로 fs 에 쓰면 안 된다.
 */
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_.-]+$/.test(id) && !id.includes('..') ? id : null
}

function idFor(dir, root, at = new Date()) {
  const base = `${rootSlug(root)}_${stamp(at)}`
  let id = base
  for (let i = 2; i < 100 && fs.existsSync(path.join(dir, `${id}.json`)); i++) id = `${base}-${i}`
  return id
}

/** 목록에 쓸 요약. 본문에서 뽑아 따로 저장한다. */
function metaOf(id, result, at) {
  const cands = result.candidates || []
  return {
    id,
    root: result.root || '',
    at: at.toISOString(),
    totalBytes: (result.tree && result.tree.size) || 0,
    files: (result.stats && result.stats.files) || 0,
    dirs: (result.stats && result.stats.dirs) || 0,
    elapsedMs: (result.stats && result.stats.elapsedMs) || 0,
    projects: (result.projects || []).length,
    candidateCount: cands.length,
    candidateBytes: cands.reduce((s, c) => s + (c.size || 0), 0),
    /** 안전으로 판정된 것만 따로 — 목록에서 "바로 비울 수 있는 양" 이 제일 궁금하다 */
    safeBytes: cands.filter((c) => c.risk === 'safe').reduce((s, c) => s + (c.size || 0), 0),
  }
}

function save(dir, result, at = new Date()) {
  ensureDir(dir)
  const id = idFor(dir, result.root, at)
  const meta = metaOf(id, result, at)
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...result, id, at: meta.at }))
  fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta))
  prune(dir)
  return meta
}

/** 목록 — 최근 것이 앞. meta 파일만 읽는다(본문은 안 읽는다). */
function list(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
    } catch {
      /* 깨진 것은 목록에서 뺀다 — 하나 때문에 이력 전체가 안 보이면 안 된다 */
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

function read(dir, id) {
  const safe = safeId(id)
  if (!safe) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${safe}.json`), 'utf8'))
  } catch {
    return null
  }
}

function remove(dir, id) {
  const safe = safeId(id)
  if (!safe) return false
  let gone = false
  for (const suffix of ['.json', '.meta.json']) {
    try {
      fs.unlinkSync(path.join(dir, `${safe}${suffix}`))
      gone = true
    } catch {
      /* 이미 없으면 그만 */
    }
  }
  return gone
}

/** 오래된 것부터 지워 KEEP 개만 남긴다. */
function prune(dir, keep = KEEP) {
  const all = list(dir)
  for (const m of all.slice(keep)) remove(dir, m.id)
}

module.exports = { save, list, read, remove, prune, ensureDir, stamp, rootSlug, safeId, metaOf, KEEP }
