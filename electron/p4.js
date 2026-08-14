// Perforce CLI 래퍼 — p4 명령을 spawn 해서 -ztag 출력을 파싱한다.
// Electron API 를 쓰지 않는 순수 Node 모듈이라 단독으로 테스트할 수 있다.
//
// 주의 1: 이 사내 서버는 P4USER 가 공용 계정(`client`)이라 사용자 구분이 안 된다.
//         실제 사용자 = 워크스페이스(client) 이므로 모든 조회를 워크스페이스로 건다.
// 주의 2: P4CHARSET=utf8 을 주지 않으면 한글 설명이 깨진다.

const { spawn } = require('node:child_process')
const fs = require('node:fs')

const DEFAULT_TIMEOUT = 60000

/**
 * 서버에 닿기도 전에(연결 단계에서) 실패한 경우인지.
 *
 * 이 PC 는 임시 포트(ephemeral port) 범위가 좁은데다 다른 프로그램이 포트를 대량 점유해서
 * 빈 포트가 없는 순간에 걸리면 WSAEADDRINUSE 로 실패한다. 잠깐 뒤엔 대개 성공한다.
 *
 * 연결 단계 실패는 요청이 서버에 도달하지 않았다는 뜻이므로 쓰기 작업(change -i 등)도
 * 재시도가 안전하다. 연결된 뒤의 실패는 재시도하지 않는다(중복 생성 위험).
 */
function isConnectFailure(msg) {
  return /WSAEADDRINUSE|Connect to server failed|TCP connect to .* failed|WSAECONNREFUSED|WSAETIMEDOUT/i.test(
    msg || '',
  )
}

const PORT_EXHAUSTED_HINT =
  '사내망 연결에 실패했습니다. 이 PC의 임시 포트(ephemeral port)가 일시적으로 고갈된 상태일 수 있습니다.\n' +
  '잠시 후 다시 시도해 보시고, 계속되면 포트를 과도하게 점유하는 프로그램이 있는지 확인하거나 PC를 재시작하세요.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * p4 실행. 실패하면 stderr 를 담아 throw 한다.
 *
 * port/user 를 주면 `-p`/`-u` 전역 옵션으로 붙인다. PC 에 설정된 P4PORT 와
 * 실제 쓰는 서버가 다를 수 있어(프록시/지사 서버) 앱에서 직접 지정할 수 있게 했다.
 */
/** 연결 단계 실패면 잠깐 쉬었다 다시 시도한다 (기본 3회). */
async function p4(args, opts = {}) {
  const tries = opts.retries ?? 3
  const backoff = [400, 1200, 2600]
  let last

  for (let i = 0; i < tries; i++) {
    try {
      return await p4Once(args, opts)
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      if (!isConnectFailure(msg) || i === tries - 1) break
      await sleep(backoff[Math.min(i, backoff.length - 1)])
    }
  }

  const msg = last instanceof Error ? last.message : String(last)
  if (isConnectFailure(msg)) {
    const err = new Error(`${PORT_EXHAUSTED_HINT}\n\n(원본 오류: ${msg.split('\n').filter(Boolean).slice(-1)[0]})`)
    err.cause = last
    throw err
  }
  throw last
}

function p4Once(args, { input, cwd, timeoutMs = DEFAULT_TIMEOUT, p4Path = 'p4', port, user } = {}) {
  return new Promise((resolve, reject) => {
    const globals = []
    if (port) globals.push('-p', String(port))
    if (user) globals.push('-u', String(user))
    const child = spawn(p4Path, [...globals, ...args], {
      cwd: cwd || undefined,
      windowsHide: true,
      env: { ...process.env, P4CHARSET: 'utf8' },
    })

    const out = []
    const err = []
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill()
      reject(new Error(`p4 ${args[0] ?? ''} 응답 시간 초과`))
    }, timeoutMs)

    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? 'p4 실행 파일을 찾을 수 없습니다. Perforce 클라이언트 설치를 확인하세요.' : e.message))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8').trim()

      // p4 는 연결 실패에도 exit 0 으로 끝나는 경우가 있어 출력 내용까지 확인한다
      const combined = `${stderr}\n${stdout}`
      if (isConnectFailure(combined)) {
        reject(new Error(combined.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')))
        return
      }
      if (code !== 0) {
        reject(new Error(stderr || `p4 ${args[0] ?? ''} 실패 (exit ${code})`))
        return
      }
      resolve(stdout)
    })

    if (input != null) child.stdin.end(input, 'utf8')
    else child.stdin.end()
  })
}

/**
 * `p4 -ztag` 출력 파서.
 * 레코드는 `... <startKey>` 로 시작한다고 보고 자른다 (설명에 빈 줄이 섞여도 안전).
 * `... ` 없는 줄은 직전 필드의 이어지는 줄(여러 줄 설명)로 붙인다.
 */
function parseZtag(text, startKey) {
  const records = []
  let cur = null
  let lastKey = null

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\.\.\. (\S+)(?: ([\s\S]*))?$/)
    if (m && m[1] === startKey) {
      if (cur) records.push(cur)
      cur = {}
      lastKey = m[1]
      cur[lastKey] = m[2] ?? ''
    } else if (m) {
      if (!cur) continue
      lastKey = m[1]
      cur[lastKey] = m[2] ?? ''
    } else if (cur && lastKey != null) {
      cur[lastKey] += `\n${line}`
    }
  }
  if (cur) records.push(cur)

  // 이어붙이며 생긴 끝쪽 빈 줄 정리
  for (const r of records) for (const k of Object.keys(r)) r[k] = r[k].replace(/\s+$/, '')
  return records
}

/** 접속 정보 확인 (서버 주소·사용자). 연결 테스트용. */
async function info(opts = {}) {
  const recs = parseZtag(await p4(['-ztag', 'info'], opts), 'userName')
  const r = recs[0] || {}
  return {
    user: r.userName || '',
    serverAddress: r.serverAddress || '',
    clientName: r.clientName || '',
    clientRoot: r.clientRoot || '',
  }
}

/**
 * 이 계정이 쓸 수 있는 워크스페이스 목록. 이 서버는 공용 계정이라 개수가 많다(90+).
 *
 * Perforce 워크스페이스는 Host 로 잠글 수 있어, 다른 PC 것을 고르면
 * "Client 'X' can only be used from host 'Y'" 로 실패한다.
 * 그래서 이 PC에서 실제로 쓸 수 있는 것(`usable`)을 표시해 준다.
 */
async function listWorkspaces(user, opts = {}) {
  const thisHost = (opts.hostname || require('node:os').hostname() || '').toLowerCase()
  const args = ['-ztag', 'clients']
  if (user) args.push('-u', user)
  const recs = parseZtag(await p4(args, opts), 'client')

  return recs
    .map((r) => {
      const host = (r.Host || r.host || '').trim()
      return {
        client: r.client,
        root: r.Root || r.root || '',
        host,
        // Host 가 비어 있으면 아무 PC에서나 쓸 수 있다
        usable: !host || host.toLowerCase() === thisHost,
        description: (r.Description || '').trim(),
      }
    })
    .sort((a, b) => Number(b.usable) - Number(a.usable) || a.client.localeCompare(b.client))
}

/** 이 PC의 호스트명 (워크스페이스 Host 잠금과 비교하는 값). */
function hostname() {
  return require('node:os').hostname() || ''
}

// 워크스페이스 루트는 잘 안 바뀌므로 캐시한다 — p4 호출 수를 줄이면 포트 고갈에 덜 걸린다
const rootCache = new Map()

/** 워크스페이스의 루트 경로 (p4 diff 를 그 안에서 실행해야 한다). */
async function clientRoot(client, opts = {}) {
  if (rootCache.has(client)) return rootCache.get(client)
  const recs = parseZtag(await p4(['-ztag', 'client', '-o', client], opts), 'Client')
  const root = (recs[0] && (recs[0].Root || recs[0].root)) || ''
  if (root) rootCache.set(client, root)
  return root
}

/**
 * 워크스페이스의 pending 체인지리스트 + 열린 파일.
 * 번호 없는 default 체인지리스트는 `p4 changes` 에 안 나오므로 열린 파일에서 만들어 낸다.
 */
async function pending(client, opts = {}) {
  // 순차 실행 — 동시에 여러 연결을 열면 사내망에서 로컬 포트가 고갈될 수 있다(WSAEADDRINUSE)
  const changesOut = await p4(['-c', client, '-ztag', 'changes', '-s', 'pending', '-c', client, '-l'], opts)

  // 열린 파일이 하나도 없으면 p4 는 "File(s) not opened on this client." 를 에러로 낸다.
  // 그건 정상 상태이므로 빈 목록으로 처리하고, 그 외 에러(연결 실패 등)는 그대로 올린다.
  let openedOut = ''
  try {
    openedOut = await p4(['-c', client, '-ztag', 'opened'], opts)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/not opened on this client|no such file|file\(s\) not opened/i.test(msg)) throw e
  }

  const files = parseZtag(openedOut, 'depotFile').map((r) => ({
    depotFile: r.depotFile,
    action: r.action || '',
    change: r.change || 'default',
    type: r.type || '',
    rev: r.rev || '',
    // 이 PC 안의 실제 경로. 새로 추가한 파일은 서버에 없어 diff 가 안 나오므로
    // 코드 리뷰에서는 이 경로로 파일을 직접 읽는다.
    clientFile: r.clientFile || '',
  }))

  const byChange = new Map()
  for (const f of files) {
    const arr = byChange.get(f.change) || []
    arr.push(f)
    byChange.set(f.change, arr)
  }

  const changes = parseZtag(changesOut, 'change').map((r) => ({
    change: r.change,
    description: (r.desc || '').trim(),
    time: r.time ? new Date(Number(r.time) * 1000).toISOString() : null,
    shelved: Object.prototype.hasOwnProperty.call(r, 'shelved'),
    files: byChange.get(r.change) || [],
  }))

  // default 체인지리스트는 열린 파일이 있을 때만 보여준다
  const defaultFiles = byChange.get('default') || []
  if (defaultFiles.length) {
    changes.unshift({ change: 'default', description: '', time: null, shelved: false, files: defaultFiles })
  }

  return { changes, fileCount: files.length }
}

/** 파일을 다른 체인지리스트로 옮긴다 (쓰기 작업). toChange 는 번호 또는 'default'. */
async function reopen(client, depotFiles, toChange, opts = {}) {
  if (!depotFiles || !depotFiles.length) return { moved: 0 }
  // 명령줄 길이 제한이 있어 나눠서 실행한다
  const BATCH = 40
  let moved = 0
  for (let i = 0; i < depotFiles.length; i += BATCH) {
    const batch = depotFiles.slice(i, i + BATCH)
    await p4(['-c', client, 'reopen', '-c', String(toChange), ...batch], opts)
    moved += batch.length
  }
  return { moved }
}

/** 빈 체인지리스트 생성 → 번호 반환. */
async function createChange(client, description, opts = {}) {
  const spec = [
    'Change: new',
    `Client: ${client}`,
    'Status: new',
    'Description:',
    ...String(description || '(설명 없음)').split(/\r?\n/).map((l) => `\t${l}`),
    '',
  ].join('\n')
  const out = await p4(['-c', client, 'change', '-i'], { ...opts, input: spec })
  const m = out.match(/Change (\d+) created/i)
  if (!m) throw new Error(`체인지리스트 번호를 읽지 못했습니다: ${out.trim().slice(0, 120)}`)
  return m[1]
}

/** 체인지리스트 설명 저장 (기존 스펙을 읽어 Description 만 교체). */
async function setDescription(client, change, description, opts = {}) {
  if (change === 'default') throw new Error('default 체인지리스트에는 설명을 저장할 수 없습니다. 새 체인지리스트로 옮기세요.')
  const spec = await p4(['-c', client, 'change', '-o', String(change)], opts)

  const lines = spec.split(/\r?\n/)
  const start = lines.findIndex((l) => /^Description:/.test(l))
  if (start < 0) throw new Error('체인지리스트 스펙에서 Description 을 찾지 못했습니다.')
  // Description 블록은 다음 최상위 필드(줄 첫 칸이 공백이 아닌 줄)까지
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^[\t ]/.test(lines[end]))) end++

  const body = String(description || '').split(/\r?\n/).map((l) => `\t${l}`)
  const next = [...lines.slice(0, start), 'Description:', ...body, ...lines.slice(end)].join('\n')

  await p4(['-c', client, 'change', '-i'], { ...opts, input: next })
  return { ok: true }
}

/**
 * 이 파일들을 건드린 최근 서밋 이력.
 * 서밋 로그의 [컨텐츠명] 과 작업번호(#12345)를 내 이전 서밋에서 따오기 위해 쓴다.
 * (P4USER 가 공용 계정이라 "내 것" 구분은 설명의 [이름] 접두어로 한다.)
 */
async function fileHistory(client, depotFiles, { max = 20, maxFiles = 20, ...opts } = {}) {
  // 새로 추가하는 파일(add)은 이력이 없다 — 나머지만 조회
  const targets = (depotFiles || []).slice(0, maxFiles)
  if (!targets.length) return []
  try {
    const out = await p4(['-c', client, '-ztag', 'changes', '-m', String(max), '-l', ...targets], opts)
    return parseZtag(out, 'change').map((r) => ({
      change: r.change,
      description: (r.desc || '').trim(),
      time: r.time ? new Date(Number(r.time) * 1000).toISOString() : null,
      client: r.client || '',
    }))
  } catch {
    // 신규 파일뿐이거나 경로가 뷰에 없으면 이력이 없다 — 로그는 이력 없이도 쓸 수 있다
    return []
  }
}

/**
 * 체인지리스트의 diff. edit 계열만 실제 diff 를 뜨고, add/delete 는 목록으로만 알린다.
 * maxChars 를 넘으면 잘라내고 truncated 를 표시한다 (로컬 LLM 컨텍스트 보호).
 */
async function diffForChange(client, change, files, { maxChars = 60000, root, ...opts } = {}) {
  // 바이너리(.uasset/.umap 등)는 diff 를 떠도 의미가 없다 — 목록으로만 넘긴다
  const editable = files
    .filter((f) => /edit|integrate|branch/i.test(f.action) && !isBinary(f))
    .map((f) => f.depotFile)
  const binary = files.filter(isBinary).map((f) => f.depotFile)
  const added = files.filter((f) => /add/i.test(f.action)).map((f) => f.depotFile)
  const deleted = files.filter((f) => /delete/i.test(f.action)).map((f) => f.depotFile)

  let diff = ''
  let error = null
  if (editable.length) {
    const cwd = root || (await clientRoot(client, opts).catch(() => ''))
    const BATCH = 30
    for (let i = 0; i < editable.length && diff.length < maxChars; i += BATCH) {
      try {
        diff += await p4(['-c', client, 'diff', '-du', ...editable.slice(i, i + BATCH)], { ...opts, cwd: cwd || undefined })
      } catch (e) {
        // 워크스페이스가 이 PC에 없거나 파일이 없을 수 있다 — 목록만으로도 로그는 쓸 수 있다
        error = e instanceof Error ? e.message : String(e)
        break
      }
    }
  }

  const truncated = diff.length > maxChars
  if (truncated) diff = `${diff.slice(0, maxChars)}\n… (diff 가 길어 잘림)`
  return { diff, added, deleted, binary, truncated, error }
}

/**
 * 새로 추가한 파일(add)의 본문을 워크스페이스에서 직접 읽는다.
 *
 * `p4 diff` 는 서버에 이미 있는 리비전과 비교하는 명령이라 add 파일에는 아무것도 내놓지 않는다.
 * 서밋 로그라면 파일 이름만으로 충분하지만 **코드 리뷰에서는 신규 파일이 오히려 핵심**이라
 * `p4 opened` 가 알려준 로컬 경로(clientFile)로 읽어 넘긴다.
 */
function readNewFiles(files, { maxFiles = 25, maxChars = 60000, maxPerFile = 12000 } = {}) {
  const out = []
  let used = 0
  for (const f of files || []) {
    if (!/add|branch/i.test(f.action || '') || isBinary(f)) continue
    if (out.length >= maxFiles || used >= maxChars) break
    if (!f.clientFile) {
      out.push({ depotFile: f.depotFile, text: '', skipped: '로컬 경로를 알 수 없어 읽지 못했습니다.' })
      continue
    }
    try {
      const st = fs.statSync(f.clientFile)
      if (!st.isFile()) continue
      if (st.size > maxPerFile * 8) {
        out.push({ depotFile: f.depotFile, text: '', skipped: `파일이 너무 큽니다 (${Math.round(st.size / 1024)}KB).` })
        continue
      }
      let text = fs.readFileSync(f.clientFile, 'utf8')
      // 텍스트가 아니면(널 바이트) 넘긴다 — type 만으로는 다 못 거른다
      if (text.includes('\u0000')) {
        out.push({ depotFile: f.depotFile, text: '', skipped: '텍스트 파일이 아닙니다.' })
        continue
      }
      const room = Math.min(maxPerFile, maxChars - used)
      const truncated = text.length > room
      if (truncated) text = text.slice(0, room)
      used += text.length
      out.push({ depotFile: f.depotFile, text, truncated })
    } catch (e) {
      out.push({ depotFile: f.depotFile, text: '', skipped: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** diff 가 의미 없는 파일인지 (언리얼 에셋·이미지·사운드 등). */
function isBinary(f) {
  if (/binary|apple|resource|symlink/i.test(f.type || '')) return true
  return /\.(uasset|umap|ubulk|uexp|png|jpg|jpeg|tga|bmp|psd|fbx|wav|ogg|mp3|dll|exe|lib|pdb|pak|bin|zip)$/i.test(
    f.depotFile || '',
  )
}

module.exports = {
  p4,
  parseZtag,
  info,
  hostname,
  listWorkspaces,
  clientRoot,
  pending,
  reopen,
  createChange,
  setDescription,
  fileHistory,
  diffForChange,
  readNewFiles,
  isBinary,
}
