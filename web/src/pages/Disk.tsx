import { useEffect, useMemo, useRef, useState } from 'react'
import { CollapsibleCard } from '../components/CollapsibleCard'
import { fmtBytes, fmtWhen, groupCandidates, pathsOf, riskLabel, sortTree, totalOf, type CandRow } from '../lib/disk'

// 디스크 정리 — PC 전용.
//
// 스캔·판정은 Electron main(electron/disk.js)이 한다. 이 화면은 결과를 보여 주고
// 무엇을 지울지 고르게 하는 역할만 맡는다.
//
// 화면 순서가 곧 사용 순서다: 드라이브 고르기 → 스캔 → (무엇이 차지하는지 본다) →
// 정리 후보 확인 → AI 판단 → 고른 것만 휴지통으로.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 진행 중인 작업을 구분할 id. 취소할 때 이 값으로 찾는다. */
function newRunId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export default function Disk() {

  const [cfg, setCfg] = useState<DiskConfig | null>(null)
  const [root, setRoot] = useState('')
  const [maxDepth, setMaxDepth] = useState(3)
  const [skipSystem, setSkipSystem] = useState(true)

  const [scan, setScan] = useState<DiskScanResult | null>(null)
  const [busy, setBusy] = useState<null | 'scan' | 'dup' | 'judge' | 'trash'>(null)
  const [progress, setProgress] = useState<DiskProgress | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** 정리 후보 + (AI 가 판정한 뒤엔) 정체불명 폴더까지 한 목록으로 */
  const [items, setItems] = useState<DiskCandidate[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [judged, setJudged] = useState<{ model: string; count: number } | null>(null)

  const [dups, setDups] = useState<{ groups: DiskDupGroup[]; wastedTotal: number; groupCount: number } | null>(null)
  const [dupMinMB, setDupMinMB] = useState(8)

  /** 지난 스캔 목록. 지금 보고 있는 것이 어느 이력인지도 같이 들고 있는다. */
  const [history, setHistory] = useState<DiskHistoryItem[]>([])
  const [viewing, setViewing] = useState<DiskHistoryItem | null>(null)

  const runId = useRef<string>('')

  // 켤 때: 설정 + 지난 스캔 목록을 읽고, **가장 최근 스캔을 도로 펼친다.**
  // 스캔 한 번이 몇 분이라 탭을 옮겼다 왔다고 결과가 사라지면 안 된다.
  useEffect(() => {
    if (!window.desktop?.disk) return
    void (async () => {
      const c = await window.desktop!.disk.getConfig()
      setCfg(c)
      setMaxDepth(c.maxDepth)
      setSkipSystem(c.skipSystem)
      setRoot(c.lastRoot || (c.drives[0] ? `${c.drives[0].drive}\\` : ''))

      const h = await window.desktop!.disk.history()
      setHistory(h.items ?? [])
      if (h.items?.length) void openHistory(h.items[0].id, { silent: true })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 진행 상황 — 스캔이 도는 동안 main 이 흘려보낸다
  useEffect(() => {
    if (!window.desktop?.disk) return
    return window.desktop.disk.onProgress((m) => setProgress(m))
  }, [])

  const drive = useMemo(() => {
    if (!cfg || !root) return null
    const letter = root.slice(0, 2).toUpperCase()
    return cfg.drives.find((d) => d.drive.toUpperCase() === letter) ?? null
  }, [cfg, root])

  const pick = async () => {
    const r = await window.desktop?.disk.pickDir()
    if (r?.ok && r.dir) setRoot(r.dir)
  }

  /** 지난 스캔을 화면에 펼친다. silent 면 안내문을 띄우지 않는다(켤 때 자동 복원). */
  const openHistory = async (id: string, opts?: { silent?: boolean }) => {
    const r = await window.desktop?.disk.historyRead(id)
    if (!r?.ok || !r.scan) {
      if (!opts?.silent) setErr(r?.error ?? '이력을 읽지 못했습니다.')
      return
    }
    const s = r.scan
    setScan(s)
    setItems(s.candidates ?? [])
    setPicked(new Set())
    setJudged(null)
    setDups(null)
    if (s.root) setRoot(s.root)
    setHistory((prev) => {
      setViewing(prev.find((h) => h.id === id) ?? null)
      return prev
    })
    if (!opts?.silent) setNotice(null)
  }

  const removeHistory = async (id: string) => {
    await window.desktop?.disk.historyRemove(id)
    const h = await window.desktop?.disk.history()
    setHistory(h?.items ?? [])
    if (viewing?.id === id) {
      setViewing(null)
      setScan(null)
      setItems([])
      setPicked(new Set())
    }
  }

  const runScan = async () => {
    if (!root || busy) return
    setBusy('scan')
    setErr(null)
    setNotice(null)
    setScan(null)
    setItems([])
    setPicked(new Set())
    setJudged(null)
    setDups(null)
    setProgress(null)
    runId.current = newRunId()
    try {
      const r = await window.desktop!.disk.scan({ runId: runId.current, root, maxDepth, skipSystem })
      if (!r.ok) {
        if (!r.cancelled) setErr(r.error ?? '스캔에 실패했습니다.')
        else setNotice('스캔을 취소했습니다.')
        return
      }
      setScan(r)
      setItems(r.candidates ?? [])
      // 규칙이 안전하다고 본 것만 미리 체크한다. caution 은 사람이 직접 고르게 둔다.
      setPicked(new Set((r.candidates ?? []).filter((c) => c.risk === 'safe').map((c) => c.path)))
      void window.desktop!.disk.setConfig({ lastRoot: root, maxDepth, skipSystem })
      // 방금 스캔이 이력 맨 앞에 붙는다
      const h = await window.desktop!.disk.history()
      setHistory(h.items ?? [])
      setViewing(r.saved ?? h.items?.[0] ?? null)
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const runDup = async () => {
    if (!root || busy) return
    setBusy('dup')
    setErr(null)
    setDups(null)
    runId.current = newRunId()
    try {
      const r = await window.desktop!.disk.duplicates({ runId: runId.current, root, minMB: dupMinMB })
      if (!r.ok) {
        if (!r.cancelled) setErr(r.error ?? '중복 검사에 실패했습니다.')
        else setNotice('중복 검사를 취소했습니다.')
        return
      }
      setDups({ groups: r.groups ?? [], wastedTotal: r.wastedTotal ?? 0, groupCount: r.groupCount ?? 0 })
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const cancel = () => {
    if (runId.current) void window.desktop?.disk.cancel(runId.current)
  }

  const runJudge = async () => {
    if (!scan || busy) return
    setBusy('judge')
    setErr(null)
    try {
      const r = await window.desktop!.disk.judge({
        candidates: items.filter((i) => i.source === 'rule'),
        unknowns: scan.unknowns ?? [],
        projects: scan.projects ?? [],
        engines: scan.engines ?? [],
        drive,
      })
      if (!r.ok || !r.items) {
        setErr(r.error ?? 'AI 판정에 실패했습니다.')
        return
      }
      setItems(r.items)
      setJudged({ model: r.model ?? '', count: r.items.filter((i) => i.ai).length })
      // AI 가 조인 항목은 선택에서 뺀다 — 판정이 바뀌었는데 체크가 남아 있으면 안 된다
      setPicked((prev) => {
        const next = new Set(prev)
        for (const it of r.items!) if (it.risk !== 'safe') next.delete(it.path)
        return next
      })
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const pickedItems = items.filter((i) => picked.has(i.path))
  const pickedBytes = pickedItems.reduce((s, i) => s + i.size, 0)

  const runTrash = async () => {
    if (!pickedItems.length || busy) return
    const msg =
      `${pickedItems.length}개 항목(${fmtBytes(pickedBytes)})을 휴지통으로 보냅니다.\n\n` +
      pickedItems.slice(0, 8).map((i) => `· ${i.path}`).join('\n') +
      (pickedItems.length > 8 ? `\n… 외 ${pickedItems.length - 8}개` : '') +
      '\n\n휴지통이라 되돌릴 수 있습니다. 진행할까요?'
    if (!window.confirm(msg)) return

    setBusy('trash')
    setErr(null)
    try {
      const r = await window.desktop!.disk.trash(pickedItems.map((i) => ({ path: i.path, size: i.size })))
      const failed = (r.results ?? []).filter((x) => !x.ok)
      const okCount = (r.results ?? []).filter((x) => x.ok).length
      setNotice(
        `${okCount}개를 휴지통으로 보냈습니다 (${fmtBytes(r.freed ?? 0)} 확보)` +
          (failed.length ? ` · 실패 ${failed.length}개` : ''),
      )
      if (failed.length) {
        // 쓰는 중인 파일은 흔히 실패한다 — 무엇이 왜 실패했는지 그대로 보여 준다
        setErr(failed.slice(0, 5).map((f) => `${f.path} — ${f.error}`).join('\n'))
      }
      const gone = new Set((r.results ?? []).filter((x) => x.ok).map((x) => x.path))
      setItems((prev) => prev.filter((i) => !gone.has(i.path)))
      setPicked(new Set())
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  // 브라우저·모바일에는 이 화면으로 오는 길이 없다 (App.tsx 가 경로를 안 만든다).
  // 아래 "구 버전 exe" 가드는 다르다 — 그건 데스크톱에서 실제로 나는 상황이라 남긴다.

  // 데스크톱 셸은 배포된 웹을 띄운다 — 화면(웹)만 새로 배포되고 앱(exe)이 예전 것이면
  // preload 에 disk 브리지가 없다. 그때 그냥 터지지 않게 무엇을 해야 하는지 알려 준다.
  if (!window.desktop?.disk) {
    return (
      <div className="page">
        <header className="page-head">
          <h2>디스크 정리</h2>
        </header>
        <div className="card notice-card">
          이 기능은 <b>앱(exe)을 새로 빌드해야</b> 동작합니다. 화면은 배포된 웹을 그대로 띄우지만, 디스크를 읽는 부분은 앱
          안에 들어 있어서 지금 설치된 앱에는 아직 없습니다.
          <br />
          <span className="muted small">
            저장소에서 <code>npm run dist:win</code> 을 돌려 새 설치본을 만든 뒤 다시 설치하세요.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-head work-head">
        <h2>디스크 정리</h2>
        <span className="work-sub muted">용량 현황 · 무엇이 차지하는지 · 지워도 되는 것</span>
      </header>

      {err && <div className="sync-msg err dk-err">{err}</div>}
      {notice && <div className="sync-msg ok">{notice}</div>}

      {/* ── 드라이브 ── */}
      <div className="dk-drives">
        {(cfg?.drives ?? []).map((d) => {
          const used = d.total - d.free
          const pct = d.total ? (used / d.total) * 100 : 0
          return (
            <button
              key={d.drive}
              type="button"
              className={`dk-drive ${pct >= 90 ? 'full' : pct >= 75 ? 'warn' : ''} ${
                root.toUpperCase().startsWith(d.drive.toUpperCase()) ? 'on' : ''
              }`}
              onClick={() => setRoot(`${d.drive}\\`)}
              title={`${d.drive} 전체를 스캔하려면 누른 뒤 스캔`}
            >
              <div className="dk-drive-head">
                <b>{d.drive}</b>
                <span className="muted small">{d.label || d.fileSystem}</span>
              </div>
              <div className="dk-bar">
                <div className="dk-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="dk-drive-foot">
                <span>{fmtBytes(d.free)} 남음</span>
                <span className="muted">{fmtBytes(d.total)}</span>
              </div>
            </button>
          )
        })}
      </div>

      {/* ── 스캔 ── */}
      <div className="card dk-run">
        <div className="dk-run-row">
          <input
            className="em-input dk-path"
            value={root}
            placeholder="스캔할 폴더 (예: D:\Work\TT\Trunk\Client)"
            onChange={(e) => setRoot(e.target.value)}
          />
          <button className="ghost-btn" disabled={!!busy} onClick={() => void pick()}>
            폴더 고르기
          </button>
          <label className="dk-opt">
            트리 깊이
            <select className="st-select" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))}>
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}단계
                </option>
              ))}
            </select>
          </label>
          <DepthHelp root={root} depth={maxDepth} />
          <label className="dk-opt" title="C:\Windows·Program Files 는 건너뛴다 (정리 대상이 아니고, 스캔만 오래 걸린다)">
            <input type="checkbox" checked={skipSystem} onChange={(e) => setSkipSystem(e.target.checked)} />
            시스템 폴더 제외
          </label>
          {busy === 'scan' || busy === 'dup' ? (
            <button className="ghost-btn danger" onClick={cancel}>
              취소
            </button>
          ) : (
            <button className="sync-btn" disabled={!!busy || !root} onClick={() => void runScan()}>
              스캔
            </button>
          )}
        </div>

        {progress && (busy === 'scan' || busy === 'dup') && (
          <div className="dk-progress">
            <span className="spinner" />
            {busy === 'scan' ? (
              <span>
                폴더 {(progress.dirs ?? 0).toLocaleString()} · 파일 {(progress.files ?? 0).toLocaleString()} ·{' '}
                {fmtBytes(progress.bytes ?? 0)} · {Math.round((progress.elapsedMs ?? 0) / 1000)}초
              </span>
            ) : (
              <span>
                중복 검사 — 후보 {(progress.scanned ?? 0).toLocaleString()} · 비교 {(progress.hashed ?? 0).toLocaleString()} ·{' '}
                {Math.round((progress.elapsedMs ?? 0) / 1000)}초
              </span>
            )}
            <span className="muted small dk-cur">{progress.current}</span>
          </div>
        )}

        {scan?.stats && (
          <p className="muted small dk-stat">
            폴더 {scan.stats.dirs.toLocaleString()} · 파일 {scan.stats.files.toLocaleString()} ·{' '}
            {fmtBytes(scan.tree?.size ?? 0)} · {Math.round(scan.stats.elapsedMs / 1000)}초
            {scan.stats.denied > 0 && ` · 권한 없어 건너뜀 ${scan.stats.denied}`}
            {scan.projects?.length ? ` · UE 프로젝트 ${scan.projects.length}개` : ''}
            {viewing && ` · ${fmtWhen(viewing.at)} 스캔`}
          </p>
        )}
      </div>

      {/* ── 지난 스캔 ── */}
      {history.length > 0 && (
        <CollapsibleCard
          id="dk-history"
          title={
            <>
              <span className="sec-dot" /> 지난 스캔
            </>
          }
          actions={
            <>
              <span className="muted small">{history.length}건 보관</span>
              <button className="link-btn small" onClick={() => void window.desktop?.disk.historyOpenDir()}>
                폴더 열기
              </button>
            </>
          }
        >
          <p className="muted small">
            끝난 스캔은 자동으로 남습니다. 화면을 옮겼다 와도, 앱을 껐다 켜도 그대로 있습니다(최근 {20}건 보관).
          </p>
          <div className="dk-hist">
            {history.map((h) => (
              <div key={h.id} className={`dk-hist-row ${viewing?.id === h.id ? 'on' : ''}`}>
                <button type="button" className="dk-hist-main" onClick={() => void openHistory(h.id)}>
                  <span className="dk-hist-when">{fmtWhen(h.at)}</span>
                  <span className="dk-hist-root" title={h.root}>
                    {h.root}
                  </span>
                  <span className="dk-hist-size">{fmtBytes(h.totalBytes)}</span>
                  <span className="muted small dk-hist-meta">
                    파일 {h.files.toLocaleString()} · {Math.round(h.elapsedMs / 1000)}초
                  </span>
                  <span className="dk-hist-cand">
                    후보 {h.candidateCount}건 · <b>{fmtBytes(h.safeBytes)}</b> 안전
                  </span>
                </button>
                <button className="row-x" title="이 이력 지우기" onClick={() => void removeHistory(h.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </CollapsibleCard>
      )}

      {scan && (
        <>
          {/* ── 정리 후보 ── */}
          <CollapsibleCard
            id="dk-clean"
            title={
              <>
                <span className="sec-dot" /> 정리 후보
              </>
            }
            actions={
              <>
                <span className="muted small">
                  {items.length}건 · 고른 것 {pickedItems.length}개 {fmtBytes(pickedBytes)}
                </span>
                <button className="link-btn" disabled={!!busy || !cfg?.llmReady} onClick={() => void runJudge()}>
                  {busy === 'judge' ? 'AI 판단 중…' : 'AI 로 판단'}
                </button>
                <button className="sync-btn" disabled={!!busy || !pickedItems.length} onClick={() => void runTrash()}>
                  휴지통으로
                </button>
              </>
            }
          >
            {!cfg?.llmReady && (
              <p className="muted small">
                사내 LLM 접속 정보가 없어 AI 판단은 쓸 수 없습니다. Perforce 설정에서 LLM 주소·키를 먼저 넣으세요.
              </p>
            )}
            {judged && (
              <p className="muted small">
                {judged.model} 이(가) {judged.count}건을 판정했습니다. AI 는 판정을 <b>더 조이기만</b> 합니다 — 규칙이 위험하다고
                본 것을 안전으로 바꾸지는 못합니다.
              </p>
            )}
            <CandidateList
              items={items}
              picked={picked}
              onToggle={(paths, on) =>
                setPicked((prev) => {
                  const next = new Set(prev)
                  for (const p of paths) {
                    if (on) next.add(p)
                    else next.delete(p)
                  }
                  return next
                })
              }
              onPickAllSafe={() => setPicked(new Set(items.filter((i) => i.risk === 'safe').map((i) => i.path)))}
              onClear={() => setPicked(new Set())}
            />
          </CollapsibleCard>

          {/* ── 폴더 트리 ── */}
          <CollapsibleCard
            id="dk-tree"
            title={
              <>
                <span className="sec-dot" /> 폴더별 용량
              </>
            }
            actions={<span className="muted small">{fmtBytes(scan.tree?.size ?? 0)}</span>}
          >
            {scan.tree ? <TreeRow node={sortTree(scan.tree)} total={scan.tree.size} depth={0} /> : null}
          </CollapsibleCard>

          <div className="ex-grid">
            {/* ── 확장자별 ── */}
            <CollapsibleCard id="dk-ext" title="파일 종류별">
              <BarList
                rows={(scan.exts ?? []).slice(0, 15).map((e) => ({
                  key: e.ext,
                  label: e.ext,
                  meta: `${e.files.toLocaleString()}개`,
                  size: e.size,
                }))}
                total={totalOf(scan.exts ?? [])}
              />
            </CollapsibleCard>

            {/* ── 나이 ── */}
            <CollapsibleCard id="dk-age" title="마지막 수정 시점">
              <BarList
                rows={(scan.ages ?? []).map((a) => ({
                  key: a.key,
                  label: a.label,
                  meta: `${a.files.toLocaleString()}개`,
                  size: a.size,
                }))}
                total={totalOf(scan.ages ?? [])}
              />
              <p className="muted small">오래 안 건드린 쪽이 대개 정리 대상입니다.</p>
            </CollapsibleCard>
          </div>

          {/* ── 큰 파일 ── */}
          <CollapsibleCard id="dk-big" title={`가장 큰 파일 ${(scan.bigFiles ?? []).length}개`}>
            <FileList rows={scan.bigFiles ?? []} />
          </CollapsibleCard>

          {/* ── 오래된 폴더 ── */}
          {!!scan.oldDirs?.length && (
            <CollapsibleCard id="dk-old" title={`6개월 넘게 안 건드린 큰 폴더 ${scan.oldDirs.length}개`}>
              <FileList rows={scan.oldDirs} showDate />
              <p className="muted small">삭제 후보로 자동 선택하지 않습니다 — 안 건드렸다고 필요 없는 건 아닙니다.</p>
            </CollapsibleCard>
          )}

          {/* ── 중복 파일 ── */}
          <CollapsibleCard
            id="dk-dup"
            title={
              <>
                <span className="sec-dot" /> 중복 파일
              </>
            }
            actions={
              <>
                <label className="dk-opt">
                  최소
                  <select className="st-select" value={dupMinMB} onChange={(e) => setDupMinMB(Number(e.target.value))}>
                    {[1, 8, 50, 200].map((n) => (
                      <option key={n} value={n}>
                        {n}MB
                      </option>
                    ))}
                  </select>
                </label>
                <button className="link-btn" disabled={!!busy} onClick={() => void runDup()}>
                  {busy === 'dup' ? '검사 중…' : '중복 찾기'}
                </button>
              </>
            }
          >
            {!dups ? (
              <p className="muted small">
                같은 내용의 파일을 찾습니다. 크기 → 앞부분 → 전체 순으로 좁혀 가지만, 마지막 단계는 파일을 실제로 읽어
                <b> 스캔보다 훨씬 오래 걸립니다.</b> 최소 크기를 낮출수록 급격히 느려집니다.
              </p>
            ) : (
              <DupList
                groups={dups.groups}
                total={dups.wastedTotal}
                count={dups.groupCount}
                onReveal={(p) => void window.desktop?.disk.reveal(p)}
              />
            )}
          </CollapsibleCard>
        </>
      )}
    </div>
  )
}

// ── 트리 깊이 설명 ───────────────────────────────────────────
//
// "깊이" 를 스캔 범위로 오해하기 쉽다(깊이를 줄이면 덜 훑는 줄 안다). 실제로는 **언제나
// 끝까지 다 세고**, 이 값은 결과 트리를 몇 단계까지 펼쳐 보여줄지만 정한다. 그 오해를
// 푸는 게 이 도움말의 목적이다.
function DepthHelp({ root, depth }: { root: string; depth: number }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const base = (root || 'D:\\').replace(/\\+$/, '')
  const rows = [
    { n: 1, path: `${base}\\Work`, note: '루트 바로 아래 폴더까지' },
    { n: 2, path: `${base}\\Work\\TT`, note: '' },
    { n: 3, path: `${base}\\Work\\TT\\Trunk`, note: '기본값' },
    { n: 4, path: `${base}\\Work\\TT\\Trunk\\Client`, note: '' },
  ]

  return (
    <span className="dk-help">
      <button
        type="button"
        className="dk-help-btn"
        aria-label="트리 깊이 설명"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <>
          {/* 바깥을 누르면 닫힌다 */}
          <span className="dk-help-back" onClick={() => setOpen(false)} />
          <span className="dk-help-pop" role="dialog" aria-label="트리 깊이 설명">
            <b className="dk-help-title">트리 깊이</b>
            <p>
              <b>스캔은 언제나 끝까지 다 셉니다.</b> 이 값은 결과의 &lsquo;폴더별 용량&rsquo; 트리를 몇 단계까지 펼쳐
              보여줄지만 정합니다.
            </p>
            <p className="muted">
              스캔에 걸리는 시간, 용량 합계, 정리 후보 찾기에는 <b>영향이 없습니다.</b> 깊은 곳에 있는 Intermediate 도
              깊이 2로 스캔하든 6으로 하든 똑같이 찾아냅니다.
            </p>
            <div className="dk-help-rows">
              {rows.map((r) => (
                <div key={r.n} className={`dk-help-row ${r.n === depth ? 'on' : ''}`}>
                  <span className="dk-help-n">{r.n}단계</span>
                  <code>{r.path}</code>
                  {r.note && <span className="muted small">{r.note}</span>}
                </div>
              ))}
              <div className="dk-help-row muted small">5·6단계 — 더 깊이까지 펼쳐 봅니다</div>
            </div>
            <p className="muted small">
              깊을수록 트리가 커져 화면이 무거워집니다(한 단계마다 최대 12배). 우선 3단계로 보고, 특정 폴더 안을 더 들여다볼
              때 올리세요.
            </p>
          </span>
        </>
      )}
    </span>
  )
}

// ── 정리 후보 목록 ───────────────────────────────────────────

function CandidateList({
  items,
  picked,
  onToggle,
  onPickAllSafe,
  onClear,
}: {
  items: DiskCandidate[]
  picked: Set<string>
  onToggle: (paths: string[], on: boolean) => void
  onPickAllSafe: () => void
  onClear: () => void
}) {
  const rows = useMemo(() => groupCandidates(items), [items])
  if (!items.length) return <p className="muted small">정리할 만한 것을 찾지 못했습니다.</p>
  return (
    <>
      <div className="dk-pickbar">
        <button className="link-btn small" onClick={onPickAllSafe}>
          안전한 것 모두 선택
        </button>
        <button className="link-btn small" onClick={onClear}>
          선택 해제
        </button>
        <span className="muted small">안전 = 도구가 자동으로 다시 만든다 · 주의 = 다시 만들 수 있으나 값이 크다</span>
      </div>
      <div className="dk-cands">
        {rows.map((r) =>
          r.type === 'item' ? (
            <CandRowItem key={r.key} item={r.item} picked={picked} onToggle={onToggle} />
          ) : (
            <CandRowGroup key={r.key} row={r} picked={picked} onToggle={onToggle} />
          ),
        )}
      </div>
    </>
  )
}

function CandRowItem({
  item,
  picked,
  onToggle,
  nested,
}: {
  item: DiskCandidate
  picked: Set<string>
  onToggle: (paths: string[], on: boolean) => void
  nested?: boolean
}) {
  const on = picked.has(item.path)
  const locked = item.risk === 'keep'
  return (
    <div className={`dk-cand risk-${item.risk} ${on ? 'on' : ''} ${nested ? 'nested' : ''}`}>
      <input
        type="checkbox"
        className="dk-cb"
        checked={on}
        disabled={locked}
        onChange={() => onToggle([item.path], !on)}
        aria-label={item.path}
      />
      <div className="dk-cand-main">
        <div className="dk-cand-head">
          <span className={`chip dk-risk ${item.risk}`}>{riskLabel(item.risk)}</span>
          <span className="dk-cand-kind muted small">{item.kind || '정체 불명'}</span>
          <b className="dk-cand-size">{fmtBytes(item.size)}</b>
          <span className="muted small">{item.files.toLocaleString()}개</span>
        </div>
        <div className="dk-cand-path" title={item.path}>
          {item.path}
        </div>
        {!nested && item.why && <div className="muted small dk-cand-why">{item.why}</div>}
        {!nested && item.cost && <div className="muted small dk-cand-cost">지우면: {item.cost}</div>}
        {item.ai && (
          <div className="dk-cand-ai">
            <span className={`chip dk-risk ${item.ai.risk}`}>AI {riskLabel(item.ai.risk)}</span>
            <span className="small">{item.ai.reason}</span>
            {item.ai.cost && <span className="muted small"> · {item.ai.cost}</span>}
          </div>
        )}
      </div>
      <button className="row-icon" title="탐색기에서 열기" onClick={() => void window.desktop?.disk.reveal(item.path)}>
        ↗
      </button>
    </div>
  )
}

/** 같은 종류가 여러 곳(플러그인마다 Intermediate …) — 한 줄로 접고 체크도 한 번에 한다. */
function CandRowGroup({
  row,
  picked,
  onToggle,
}: {
  row: Extract<CandRow, { type: 'group' }>
  picked: Set<string>
  onToggle: (paths: string[], on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const paths = pathsOf(row)
  const onCount = paths.filter((p) => picked.has(p)).length
  const all = onCount === paths.length
  const locked = row.risk === 'keep'
  const first = row.items[0]

  return (
    <div className={`dk-cand group risk-${row.risk} ${onCount ? 'on' : ''}`}>
      <input
        type="checkbox"
        className="dk-cb"
        checked={all}
        // 일부만 선택된 상태를 체크박스로 보여 준다 — 안 그러면 몇 개가 선택됐는지 알 수 없다
        ref={(el) => {
          if (el) el.indeterminate = onCount > 0 && !all
        }}
        disabled={locked}
        onChange={() => onToggle(paths, !all)}
        aria-label={row.label}
      />
      <div className="dk-cand-main">
        <div className="dk-cand-head">
          <span className={`chip dk-risk ${row.risk}`}>{riskLabel(row.risk)}</span>
          <span className="dk-cand-kind muted small">{row.label}</span>
          <b className="dk-cand-size">{fmtBytes(row.size)}</b>
          {onCount > 0 && !all && <span className="muted small">{onCount}개 선택</span>}
          <button className="link-btn small" onClick={() => setOpen((v) => !v)}>
            {open ? '접기' : '펼치기'}
          </button>
        </div>
        {first?.why && <div className="muted small dk-cand-why">{first.why}</div>}
        {open && (
          <div className="dk-cand-kids">
            {row.items.map((it) => (
              <CandRowItem key={it.path} item={it} picked={picked} onToggle={onToggle} nested />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 폴더 트리 ────────────────────────────────────────────────

function TreeRow({ node, total, depth }: { node: DiskNode; total: number; depth: number }) {
  // 두 단계까지만 펼쳐 둔다 — 다 펼치면 첫 화면이 수백 줄이 된다
  const [open, setOpen] = useState(depth < 1)
  const pct = total ? (node.size / total) * 100 : 0
  const hasKids = node.children.length > 0

  return (
    <div className="dk-tree-node" style={{ marginLeft: depth ? 14 : 0 }}>
      <div className={`dk-tree-row ${hasKids ? 'has' : ''}`} onClick={() => hasKids && setOpen((v) => !v)}>
        <span className="dk-tree-caret">{hasKids ? (open ? '▾' : '▸') : ''}</span>
        <span className="dk-tree-name" title={node.path || node.name}>
          {node.name}
        </span>
        <span className="dk-tree-bar">
          <span className="dk-tree-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
        <span className="dk-tree-pct muted small">{pct.toFixed(1)}%</span>
        <b className="dk-tree-size">{fmtBytes(node.size)}</b>
        <span className="muted small dk-tree-files">{node.files.toLocaleString()}개</span>
      </div>
      {open && hasKids && (
        <div className="dk-tree-kids">
          {node.children.map((c, i) => (
            <TreeRow key={c.path || `rest-${i}`} node={c} total={total} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── 막대 목록 (확장자·나이) ──────────────────────────────────

function BarList({
  rows,
  total,
}: {
  rows: { key: string; label: string; meta: string; size: number }[]
  total: number
}) {
  if (!rows.length) return <p className="muted small">데이터 없음</p>
  const max = Math.max(...rows.map((r) => r.size), 1)
  return (
    <div className="type-list">
      {rows.map((r) => (
        <div key={r.key} className="type-row">
          <span className="type-name">
            <span className="type-name-text">{r.label}</span>
          </span>
          <div className="type-bar">
            <div className="type-bar-fill" style={{ width: `${(r.size / max) * 100}%` }} />
          </div>
          <span className="type-meta">
            {fmtBytes(r.size)}
            {total > 0 && <span className="muted"> · {((r.size / total) * 100).toFixed(0)}%</span>} · {r.meta}
          </span>
        </div>
      ))}
    </div>
  )
}

function FileList({ rows, showDate }: { rows: DiskFileRow[]; showDate?: boolean }) {
  if (!rows.length) return <p className="muted small">데이터 없음</p>
  return (
    <div className="dk-files">
      {rows.map((f) => (
        <div key={f.path} className="dk-file">
          <b className="dk-file-size">{fmtBytes(f.size)}</b>
          {showDate && <span className="muted small dk-file-date">{new Date(f.mtime).toISOString().slice(0, 10)}</span>}
          <span className="dk-file-path" title={f.path}>
            {f.path}
          </span>
          <button className="row-icon" title="탐색기에서 열기" onClick={() => void window.desktop?.disk.reveal(f.path)}>
            ↗
          </button>
        </div>
      ))}
    </div>
  )
}

function DupList({
  groups,
  total,
  count,
  onReveal,
}: {
  groups: DiskDupGroup[]
  total: number
  count: number
  onReveal: (p: string) => void
}) {
  if (!groups.length) return <p className="muted small">같은 내용의 파일을 찾지 못했습니다.</p>
  return (
    <>
      <p className="muted small">
        {count.toLocaleString()}묶음 · 하나씩만 남기면 <b>{fmtBytes(total)}</b> 를 비웁니다.
        {groups.length < count && ` (큰 순으로 ${groups.length}묶음만 표시)`}
      </p>
      <div className="dk-dups">
        {groups.map((g, i) => (
          <div key={`${g.size}-${i}`} className="dk-dup">
            <div className="dk-dup-head">
              <b>{fmtBytes(g.size)}</b> × {g.count}개 <span className="muted small">· {fmtBytes(g.wasted)} 낭비</span>
            </div>
            {g.files.map((f) => (
              <div key={f} className="dk-dup-file">
                <span title={f}>{f}</span>
                <button className="row-icon" title="탐색기에서 열기" onClick={() => onReveal(f)}>
                  ↗
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="muted small">
        중복은 자동으로 지우지 않습니다 — 어느 쪽이 원본인지는 사람이 알아야 합니다(빌드가 참조하는 사본일 수 있습니다).
      </p>
    </>
  )
}
