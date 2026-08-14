// 리뷰 결과 파일 보관소 — md 한 벌 = 리뷰 1회.
//
// 파일명에 시각이 들어간다 (`CL29580_20260814-153012.md`). 같은 CL 을 여러 번 리뷰해도
// 서로 덮어쓰지 않고, 목록을 이름만 보고도 시간순으로 세울 수 있다.
//
// Electron API 를 쓰지 않는 순수 Node 모듈이라 단독으로 테스트할 수 있다.

const fs = require('node:fs')
const path = require('node:path')

const { parseFrontMatter, stamp } = require('./review')

/** 파일명에 쓸 수 있게 CL 번호를 다듬는다 (경로 구분자 등 차단). */
function changeSlug(change) {
  const s = String(change || '').trim()
  if (!s || s === 'default') return 'default'
  const digits = s.replace(/[^\d]/g, '')
  return digits ? `CL${digits}` : 'CL'
}

/** 저장 파일명. 같은 초에 두 번 저장되면 뒤에 번호를 붙인다. */
function fileNameFor(dir, change, at = new Date()) {
  const base = `${changeSlug(change)}_${stamp(at)}`
  let name = `${base}.md`
  for (let i = 2; i < 100 && fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.md`
  return name
}

/** 파일명에서 CL 번호를 되읽는다 (프론트매터가 깨졌을 때의 폴백). */
function changeFromName(name) {
  const m = String(name).match(/^(default|CL(\d+))_/)
  if (!m) return ''
  return m[1] === 'default' ? 'default' : m[2]
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 바깥 경로로 새는 파일명을 막는다.
 * 렌더러(원격 페이지)가 넘겨준 이름을 그대로 fs 에 쓰면 안 된다.
 */
function safePath(dir, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\.md$/.test(name) || name.includes('..')) return null
  const p = path.join(dir, name)
  const rel = path.relative(path.resolve(dir), path.resolve(p))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return p
}

function save(dir, change, text, at = new Date()) {
  ensureDir(dir)
  const name = fileNameFor(dir, change, at)
  fs.writeFileSync(path.join(dir, name), text, 'utf8')
  return { file: name, path: path.join(dir, name) }
}

/** 목록. 앞부분만 읽어 프론트매터를 본다 (본문은 볼 때 읽는다). */
function list(dir, { change = null, limit = 300 } = {}) {
  let names
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }

  const out = []
  for (const name of names) {
    const p = path.join(dir, name)
    let head = ''
    let size = 0
    let mtime = null
    try {
      const st = fs.statSync(p)
      size = st.size
      mtime = st.mtime.toISOString()
      const fd = fs.openSync(p, 'r')
      const buf = Buffer.alloc(Math.min(2048, size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      head = buf.toString('utf8')
    } catch {
      continue
    }
    const meta = parseFrontMatter(head)
    const cl = String(meta.change || changeFromName(name) || '')
    if (change != null && String(change) !== cl) continue
    out.push({
      file: name,
      change: cl,
      createdAt: meta.createdAt || mtime,
      createdLocal: meta.createdLocal || '',
      title: meta.title || '',
      workspace: meta.workspace || '',
      fileCount: Number(meta.fileCount) || 0,
      reviewers: Array.isArray(meta.reviewers) ? meta.reviewers : [],
      ok: Number(meta.ok) || 0,
      failed: Number(meta.failed) || 0,
      size,
    })
  }

  // 최신이 위로
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.file.localeCompare(a.file))
  return out.slice(0, limit)
}

/** CL 별 리뷰 개수 — 목록 화면의 "리뷰 3" 배지에 쓴다. */
function counts(dir) {
  const out = {}
  for (const r of list(dir, { limit: 5000 })) out[r.change] = (out[r.change] || 0) + 1
  return out
}

function read(dir, name) {
  const p = safePath(dir, name)
  if (!p) return { ok: false, error: '잘못된 파일 이름입니다.' }
  try {
    const text = fs.readFileSync(p, 'utf8')
    return { ok: true, text, meta: parseFrontMatter(text), path: p }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function remove(dir, name) {
  const p = safePath(dir, name)
  if (!p) return { ok: false, error: '잘못된 파일 이름입니다.' }
  try {
    fs.rmSync(p, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

module.exports = { changeSlug, fileNameFor, changeFromName, ensureDir, safePath, save, list, counts, read, remove }
