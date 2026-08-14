import { useCallback, useEffect, useRef, useState } from 'react'
import { Markdown } from '../../lib/markdown'

// CL AI 코드 리뷰 — 실행 모달과 기록 모달.
//
// 실행은 Electron main 이 한다 (codex/claude CLI + 사내 LLM). 여기서는 진행 상황을 받아 보여주고,
// 끝나면 저장된 md 를 그대로 렌더링한다.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function newRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

export function clLabel(change: string): string {
  return change === 'default' ? 'default' : `CL ${change}`
}

function secs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`
}

/** 리뷰 본문 + 그 아래 도구 모음 (실행 결과와 기록 보기가 같은 걸 쓴다). */
function ReviewBody({ text, file, onDeleted }: { text: string; file: string; onDeleted?: () => void }) {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div className="rv-doc">
        <Markdown text={text} />
      </div>
      <div className="rv-doc-tools">
        <code className="rv-file">{file}</code>
        <button className="link-btn" onClick={() => void copy()}>
          {copied ? '복사됨' : '복사'}
        </button>
        <button className="link-btn" onClick={() => void window.desktop?.review.openFile(file)}>
          파일 열기
        </button>
        {onDeleted &&
          (confirming ? (
            <>
              <span className="muted small">지울까요?</span>
              <button
                className="link-btn danger"
                onClick={async () => {
                  await window.desktop?.review.remove(file)
                  setConfirming(false)
                  onDeleted()
                }}
              >
                삭제
              </button>
              <button className="link-btn" onClick={() => setConfirming(false)}>
                취소
              </button>
            </>
          ) : (
            <button className="link-btn danger" onClick={() => setConfirming(true)}>
              삭제
            </button>
          ))}
      </div>
    </>
  )
}

// ── 리뷰 실행 ────────────────────────────────────────────────

type RowState = { id: string; label: string; kind: ReviewKind; status: 'wait' | 'run' | 'ok' | 'fail'; ms?: number; error?: string | null }

export function ReviewRunModal({
  change,
  onClose,
  onSaved,
}: {
  change: P4Change
  onClose: () => void
  onSaved: () => void
}) {
  const [cfg, setCfg] = useState<ReviewConfig | null>(null)
  const [rows, setRows] = useState<RowState[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ReviewRunResult | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const runIdRef = useRef<string>('')
  // 리뷰 도중에 화면을 떠나면 진행 구독이 남는다 — 언마운트 때 떼어낸다
  const offRef = useRef<(() => void) | null>(null)
  useEffect(() => () => offRef.current?.(), [])

  useEffect(() => {
    window.desktop?.review.getConfig().then(setCfg)
  }, [])

  // 진행 중에만 시계를 돌린다
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [busy])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, busy])

  const enabled = (cfg?.reviewers ?? []).filter((r) => r.enabled)
  const external = enabled.filter((r) => cfg?.kinds[r.kind]?.external)

  const start = useCallback(async () => {
    if (!cfg) return
    const runId = newRunId()
    runIdRef.current = runId
    setErr(null)
    setResult(null)
    setBusy(true)
    setStartedAt(Date.now())
    setRows(
      enabled.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: `${cfg.kinds[r.kind]?.label ?? r.kind}${r.model || r.effort ? ` (${[r.model, r.effort].filter(Boolean).join(' · ')})` : ''}`,
        status: 'wait',
      })),
    )

    offRef.current?.()
    const off = window.desktop?.review.onProgress((msg) => {
      if (msg.runId !== runId || !msg.id) return
      setRows((prev) =>
        prev.map((row) =>
          row.id === msg.id
            ? {
                ...row,
                label: msg.label ?? row.label,
                status: msg.phase === 'running' ? 'run' : msg.phase === 'done' ? 'ok' : msg.phase === 'error' ? 'fail' : row.status,
                ms: msg.ms,
                error: msg.error ?? null,
              }
            : row,
        ),
      )
    })
    offRef.current = off ?? null

    try {
      const res = await window.desktop?.review.run({ runId, change: change.change })
      if (!res) return
      if (res.ok) {
        setResult(res)
        onSaved()
      } else {
        setErr(res.error ?? '리뷰 실패')
      }
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      off?.()
      offRef.current = null
      setBusy(false)
    }
  }, [cfg, enabled, change.change, onSaved])

  const cancel = async () => {
    if (runIdRef.current) await window.desktop?.review.cancel(runIdRef.current)
  }

  const elapsed = startedAt ? now - startedAt : 0

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>AI 코드 리뷰 — {clLabel(change.change)}</h3>
        <p className="muted small">
          파일 {change.files.length}개 · 변경 내용(diff)과 새로 추가한 파일 본문을 리뷰 모델에게 보냅니다.
          결과는 <b>md 파일</b>로 이 PC에 저장됩니다.
        </p>

        {!cfg ? (
          <p className="muted small">설정을 불러오는 중…</p>
        ) : !cfg.platformOk ? (
          <p className="error small">이 기능은 Windows 에서만 동작합니다.</p>
        ) : enabled.length === 0 ? (
          <p className="error small">설정 → AI 코드 리뷰 에서 리뷰 모델을 하나 이상 켜세요.</p>
        ) : (
          <>
            {!result && (
              <div className="rv-plan">
                {enabled.map((r) => {
                  const k = cfg.kinds[r.kind]
                  return (
                    <div key={r.id} className="rv-plan-row">
                      <span className={`chip ${k?.external ? 'rv-ext' : 'rv-int'}`}>{k?.external ? '사외' : '사내'}</span>
                      <b>{k?.label ?? r.kind}</b>
                      <span className="muted small">
                        {[r.model || (r.kind === 'local' ? cfg.localModel : '기본 모델'), r.effort].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {external.length > 0 && !result && (
              <p className="rv-warn small">
                ⚠ {external.map((r) => cfg.kinds[r.kind]?.label).join(', ')} 은(는) <b>사외 서비스</b>입니다. 이 CL 의
                코드가 회사 밖으로 전송됩니다.
              </p>
            )}

            {rows.length > 0 && (
              <div className="rv-rows">
                {rows.map((row) => (
                  <div key={row.id} className={`rv-row st-${row.status}`}>
                    <span className="rv-st">
                      {row.status === 'run' ? <span className="spinner" /> : row.status === 'ok' ? '✓' : row.status === 'fail' ? '✕' : '·'}
                    </span>
                    <b>{row.label}</b>
                    <span className="muted small rv-row-note">
                      {row.status === 'wait' && '대기'}
                      {row.status === 'run' && '리뷰 중…'}
                      {row.status === 'ok' && secs(row.ms ?? 0)}
                      {row.status === 'fail' && (row.error || '실패')}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {busy && (
              <p className="muted small">
                {secs(elapsed)} 경과 · 모델과 diff 크기에 따라 몇 분 걸릴 수 있어요. 이 창을 닫지 마세요.
              </p>
            )}

            {err && <p className="error small rv-err">{err}</p>}

            {result?.ok && (
              <>
                <p className="muted small">
                  저장됨 · {result.entries?.filter((e) => e.ok).length}/{result.entries?.length} 성공
                  {result.diffChars ? ` · diff ${Math.round(result.diffChars / 1000)}K자` : ''}
                  {result.diffTruncated ? ' (일부 생략)' : ''}
                  {result.newFileCount ? ` · 신규 파일 ${result.newFileCount}개 포함` : ''}
                </p>
                <ReviewBody text={result.text ?? ''} file={result.file ?? ''} />
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          {busy ? (
            <button className="btn-secondary" onClick={() => void cancel()}>
              취소
            </button>
          ) : (
            <>
              <button className="btn-secondary" onClick={onClose}>
                닫기
              </button>
              {cfg?.platformOk && enabled.length > 0 && (
                <button onClick={() => void start()}>{result ? '다시 리뷰' : '리뷰 시작'}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 리뷰 기록 ────────────────────────────────────────────────

export function ReviewHistoryModal({
  change,
  onClose,
  onChanged,
}: {
  /** null 이면 모든 CL 의 기록 */
  change: P4Change | null
  onClose: () => void
  onChanged: () => void
}) {
  const [all, setAll] = useState(!change)
  const [list, setList] = useState<ReviewFile[]>([])
  const [dir, setDir] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    const r = await window.desktop?.review.list(all || !change ? null : change.change)
    setLoading(false)
    if (!r) return
    setDir(r.dir)
    setList(r.reviews)
    // 고르고 있던 파일이 사라졌으면(삭제) 첫 항목으로
    setSel((cur) => (cur && r.reviews.some((x) => x.file === cur) ? cur : (r.reviews[0]?.file ?? null)))
  }, [all, change])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!sel) {
      setText('')
      return
    }
    let alive = true
    window.desktop?.review.read(sel).then((r) => {
      if (!alive) return
      if (r?.ok) {
        setText(r.text ?? '')
        setErr(null)
      } else {
        setText('')
        setErr(r?.error ?? '읽기 실패')
      }
    })
    return () => {
      alive = false
    }
  }, [sel])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide rv-hist" onClick={(e) => e.stopPropagation()}>
        <h3>리뷰 기록{change && !all ? ` — ${clLabel(change.change)}` : ''}</h3>
        <div className="rv-hist-head">
          <span className="muted small">
            {list.length}건 · <code>{dir}</code>
          </span>
          <div className="rv-hist-actions">
            {change && (
              <label className="chk-line">
                <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                <span>모든 CL</span>
              </label>
            )}
            <button className="link-btn" onClick={() => void window.desktop?.review.openDir()}>
              폴더 열기
            </button>
          </div>
        </div>

        {loading ? (
          <p className="muted small">불러오는 중…</p>
        ) : list.length === 0 ? (
          <p className="muted small">저장된 리뷰가 없어요. CL 의 “AI 리뷰” 를 눌러 보세요.</p>
        ) : (
          <div className="rv-hist-body">
            <div className="rv-hist-list">
              {list.map((r) => (
                <button
                  key={r.file}
                  type="button"
                  className={`rv-hist-item ${sel === r.file ? 'active' : ''}`}
                  onClick={() => setSel(r.file)}
                  // 목록이 좁아 제목·리뷰어가 잘린다 — 전체는 툴팁으로
                  title={[r.file, r.title, r.reviewers.join(' · ')].filter(Boolean).join('\n')}
                >
                  <span className="rv-hist-top">
                    <b>{clLabel(r.change)}</b>
                    <span className="muted small">{r.createdLocal || r.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  </span>
                  {r.title && <span className="rv-hist-title">{r.title}</span>}
                  <span className="muted small rv-hist-meta">
                    {r.reviewers.join(' · ') || '리뷰어 정보 없음'}
                    {r.failed > 0 && <span className="rv-fail"> · 실패 {r.failed}</span>}
                  </span>
                </button>
              ))}
            </div>

            <div className="rv-hist-view">
              {err && <p className="error small">{err}</p>}
              {sel && text ? (
                <ReviewBody
                  text={text}
                  file={sel}
                  onDeleted={() => {
                    void reload()
                    onChanged()
                  }}
                />
              ) : (
                !err && <p className="muted small">왼쪽에서 리뷰를 고르세요.</p>
              )}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
