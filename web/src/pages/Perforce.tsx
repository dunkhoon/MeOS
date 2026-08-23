import { useCallback, useEffect, useRef, useState } from 'react'
import { CollapsibleCard } from '../components/CollapsibleCard'
import { ReviewHistoryModal, ReviewRunModal } from '../components/p4/Review'
import { applyClick, planMove, toggleAll } from '../lib/p4move'
import { isDesktop } from '../lib/desktop'

// Perforce — PC 전용. p4 CLI 는 Electron main 에서 실행한다.
// 서밋 로그는 사내 로컬 LLM(llm.aquatree.games)으로 작성하므로 diff 가 회사 밖으로 나가지 않는다.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** //depot/a/b/c.cpp → c.cpp (파일명만) */
function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}
/** 파일명 앞의 디렉터리 부분 */
function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i + 1)
}

function actionClass(action: string): string {
  if (/add/i.test(action)) return 'act-add'
  if (/delete/i.test(action)) return 'act-delete'
  if (/integrate|branch/i.test(action)) return 'act-integrate'
  return 'act-edit'
}

export default function Perforce() {
  const desktop = isDesktop()

  const [cfg, setCfg] = useState<P4Config | null>(null)
  const [changes, setChanges] = useState<P4Change[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 서밋 로그 모달
  const [logFor, setLogFor] = useState<P4Change | null>(null)

  // AI 코드 리뷰 — 실행 모달 / 기록 모달(change 가 null 이면 전체 기록)
  const [reviewFor, setReviewFor] = useState<P4Change | null>(null)
  const [histFor, setHistFor] = useState<{ change: P4Change | null } | null>(null)
  /** CL 번호 → 저장된 리뷰 개수. "리뷰 3" 배지에 쓴다. */
  const [reviewCounts, setReviewCounts] = useState<Record<string, number>>({})

  const loadCounts = useCallback(async () => {
    const r = await window.desktop?.review?.counts()
    if (r?.ok) setReviewCounts(r.counts)
  }, [])

  const load = useCallback(async () => {
    if (!window.desktop?.p4) return
    setLoading(true)
    setErr(null)
    try {
      const c = await window.desktop.p4.getConfig()
      setCfg(c)
      if (!c.workspace) {
        setChanges([])
        setErr('워크스페이스가 선택되지 않았습니다. 설정 → Perforce 에서 고르세요.')
        return
      }
      const res = await window.desktop.p4.pending()
      if (!res.ok) {
        setChanges([])
        setErr(res.error ?? '조회 실패')
        return
      }
      const list = res.changes ?? []
      setChanges(list)
      // 새로고침 사이에 사라진 파일(revert 등)이 선택에 남아 개수만 부풀지 않게 정리한다
      const alive = new Set(list.flatMap((c) => c.files.map((f) => f.depotFile)))
      setSelected((prev) => {
        const next = new Set([...prev].filter((p) => alive.has(p)))
        return next.size === prev.size ? prev : next
      })
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (desktop) {
      void load()
      void loadCounts()
    }
  }, [desktop, load, loadCounts])

  const flash = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(null), 3500)
  }

  // ── 선택 ──────────────────────────────────────────────────
  // 파일을 하나씩만 끌어 옮기는 건 개수가 늘면 금방 고역이라, 체크로 여러 개를 골라
  // 한 번에 옮길 수 있게 한다. 선택은 체인지리스트를 넘나들 수 있다 (p4 reopen 이 한 번에 받는다).
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Shift 범위 선택 기준점 — 같은 체인지리스트 안에서만 의미가 있다
  const anchorRef = useRef<{ change: string; index: number } | null>(null)

  const clearSelection = () => {
    setSelected(new Set())
    anchorRef.current = null
  }

  /** 행 클릭 = 토글, Shift+클릭 = 기준점부터 범위 (탐색기와 달리 클릭이 기존 선택을 지우지 않는다) */
  const clickFile = (c: P4Change, index: number, e: React.MouseEvent) => {
    const anchor = anchorRef.current
    setSelected((prev) =>
      applyClick(prev, c.files, index, {
        shift: e.shiftKey,
        // 기준점은 같은 체인지리스트 안에서만 의미가 있다
        anchor: anchor && anchor.change === c.change ? anchor.index : null,
      }),
    )
    anchorRef.current = { change: c.change, index }
  }

  const toggleAllIn = (c: P4Change) => {
    setSelected((prev) => toggleAll(prev, c.files))
    anchorRef.current = null
  }

  // ── 이동 ──────────────────────────────────────────────────
  const clLabel = (change: string) => (change === 'default' ? 'default' : `CL ${change}`)

  /**
   * 여러 파일을 한 체인지리스트로 옮긴다. 화면에 먼저 반영하고 실패하면 되돌린다.
   * `newCl` 은 방금 만들어 아직 목록에 없는 체인지리스트 (거기로 바로 옮길 때).
   */
  const moveFiles = async (paths: string[], toChange: string, newCl?: P4Change) => {
    const { moving, next, before } = planMove(changes, paths, toChange, newCl)
    if (!moving.length) {
      if (newCl) setChanges(before) // 옮길 게 없어도 새로 만든 CL 은 보여준다
      clearSelection()
      return
    }

    setChanges(next)
    clearSelection()

    const res = await window.desktop?.p4.reopen(moving, toChange)
    if (!res?.ok) {
      setChanges(before)
      setErr(`파일 이동 실패: ${res?.error ?? '알 수 없는 오류'}`)
    } else {
      flash(
        moving.length === 1
          ? `${baseName(moving[0])} → ${clLabel(toChange)}`
          : `${moving.length}개 파일 → ${clLabel(toChange)}`,
      )
      void load()
    }
  }

  // ── 드래그 ────────────────────────────────────────────────
  // 선택된 행을 끌면 선택 전체가 따라온다. 선택 안 된 행을 끌면 그것 하나만 (선택은 건드리지 않는다).
  const dragRef = useRef<string[] | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const startDrag = (path: string) => {
    dragRef.current = selected.has(path) ? [...selected] : [path]
  }

  const dropTo = (toChange: string) => async (e: React.DragEvent) => {
    e.preventDefault()
    const paths = dragRef.current
    dragRef.current = null
    setOver(null)
    if (paths?.length) await moveFiles(paths, toChange)
  }

  // window.prompt 는 Electron 에서 동작하지 않아 모달을 쓴다
  const [newOpen, setNewOpen] = useState(false)
  // 새 체인지리스트를 만든 뒤 선택한 파일을 바로 그리로 옮길지
  const [newThenMove, setNewThenMove] = useState<string[] | null>(null)

  // 브라우저·모바일에는 이 화면으로 오는 길이 없다 (App.tsx 가 경로를 안 만들고 사이드바에도 없다).
  // 예전엔 여기서 "PC 전용" 안내를 띄웠는데, 이제 도달할 수 없어 걷어냈다.

  const totalFiles = changes.reduce((n, c) => n + c.files.length, 0)

  return (
    <div className="page">
      <header className="page-head p4-head">
        <div>
          <h2>
            Perforce <span className="tag">PC 전용</span>
          </h2>
          <p className="muted">
            {cfg?.workspace ? (
              <>
                워크스페이스 <code>{cfg.workspace}</code>
                {cfg.port && <> · {cfg.port}</>} · 내 체인지리스트만 표시됩니다
              </>
            ) : (
              '워크스페이스를 설정에서 선택하세요'
            )}
          </p>
        </div>
        <div className="p4-actions">
          <button className="ghost-btn" onClick={() => setHistFor({ change: null })}>
            리뷰 기록
          </button>
          <button className="ghost-btn" onClick={() => setNewOpen(true)}>
            ＋ 새 체인지리스트
          </button>
          <button className="sync-btn" onClick={() => void load()} disabled={loading}>
            {loading && <span className="spinner" />}
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
        </div>
      </header>

      {err && <div className="sync-msg err">{err}</div>}
      {notice && <div className="sync-msg p4-ok">{notice}</div>}

      {!loading && changes.length === 0 && !err && (
        <div className="card muted">진행 중인 체인지리스트가 없어요.</div>
      )}

      <p className="muted small p4-hint">
        파일을 눌러 고르고(Shift+클릭 = 범위) 아래에서 한 번에 옮기거나, 끌어다 놓으면 이동합니다
        (<code>p4 reopen</code>). 총 {totalFiles}개 파일.
      </p>

      {selected.size > 0 && (
        <div className="p4-selbar">
          <span className="p4-selcount">
            <b>{selected.size}개</b> 선택됨
          </span>
          <label className="p4-moveto">
            이동:
            <select
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (!v) return
                const paths = [...selected]
                if (v === '__new') {
                  setNewThenMove(paths)
                  setNewOpen(true)
                } else {
                  void moveFiles(paths, v)
                }
              }}
            >
              <option value="">체인지리스트 고르기…</option>
              {changes.map((c) => (
                <option key={c.change} value={c.change}>
                  {clLabel(c.change)}
                  {c.description ? ` — ${c.description.split('\n')[0].slice(0, 40)}` : ''}
                </option>
              ))}
              <option value="__new">＋ 새 체인지리스트로…</option>
            </select>
          </label>
          <button className="link-btn" onClick={clearSelection}>
            선택 해제
          </button>
        </div>
      )}

      {changes.map((c) => (
        <CollapsibleCard
          key={c.change}
          id={`p4-cl-${c.change}`}
          title={
            <>
              <span className="sec-dot" />
              {c.change === 'default' ? (
                <span className="p4-cl-num">default</span>
              ) : (
                <span className="p4-cl-num">CL {c.change}</span>
              )}
              <span className="p4-cl-desc">{c.description || <span className="muted">(설명 없음)</span>}</span>
              {c.shelved && <span className="chip trk">shelved</span>}
            </>
          }
          actions={
            <>
              {c.files.length > 0 && (
                <label className="p4-selall" title="이 체인지리스트 전체 선택">
                  <input
                    type="checkbox"
                    checked={c.files.every((f) => selected.has(f.depotFile))}
                    ref={(el) => {
                      if (!el) return
                      const n = c.files.filter((f) => selected.has(f.depotFile)).length
                      el.indeterminate = n > 0 && n < c.files.length
                    }}
                    onChange={() => toggleAllIn(c)}
                  />
                </label>
              )}
              <span className="muted small">{c.files.length}개</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => setLogFor(c)}
                disabled={c.files.length === 0}
                title={c.files.length === 0 ? '파일이 없어 로그를 쓸 수 없어요' : '사내 LLM 으로 서밋 로그 작성'}
              >
                서밋 로그 작성
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => setReviewFor(c)}
                disabled={c.files.length === 0}
                title={c.files.length === 0 ? '파일이 없어 리뷰할 게 없어요' : '설정에 켜 둔 모델들에게 코드 리뷰를 맡깁니다'}
              >
                AI 리뷰
              </button>
              {(reviewCounts[c.change] ?? 0) > 0 && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setHistFor({ change: c })}
                  title="이 체인지리스트의 지난 리뷰 보기"
                >
                  리뷰 보기 <span className="rv-badge">{reviewCounts[c.change]}</span>
                </button>
              )}
            </>
          }
        >
          <div
            className={`p4-files ${over === c.change ? 'over' : ''}`}
            onDragOver={(e) => {
              if (!dragRef.current) return
              e.preventDefault()
              setOver(c.change)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              setOver((o) => (o === c.change ? null : o))
            }}
            onDrop={dropTo(c.change)}
          >
            {c.files.length === 0 ? (
              <p className="muted small p4-empty">파일 없음 — 여기로 끌어다 놓으면 이 체인지리스트로 옮겨집니다.</p>
            ) : (
              c.files.map((f, i) => (
                <div
                  key={f.depotFile}
                  className={`p4-file${selected.has(f.depotFile) ? ' sel' : ''}`}
                  draggable
                  onDragStart={() => startDrag(f.depotFile)}
                  onDragEnd={() => {
                    dragRef.current = null
                    setOver(null)
                  }}
                  onClick={(e) => clickFile(c, i, e)}
                  title={f.depotFile}
                >
                  {/* 체크박스는 표시 겸 클릭 대상 — 실제 토글은 행 onClick 이 처리한다 */}
                  <input type="checkbox" checked={selected.has(f.depotFile)} readOnly tabIndex={-1} />
                  <span className={`chip ${actionClass(f.action)}`}>{f.action}</span>
                  <span className="p4-path">
                    <span className="muted">{dirName(f.depotFile)}</span>
                    <b>{baseName(f.depotFile)}</b>
                  </span>
                  {f.rev && <span className="muted small p4-rev">#{f.rev}</span>}
                </div>
              ))
            )}
          </div>
        </CollapsibleCard>
      ))}

      {newOpen && (
        <NewChangeModal
          moveCount={newThenMove?.length ?? 0}
          onClose={() => {
            setNewOpen(false)
            setNewThenMove(null)
          }}
          onCreated={(num) => {
            setNewOpen(false)
            const paths = newThenMove
            setNewThenMove(null)
            if (paths?.length) {
              // 방금 만든 CL 은 아직 목록에 없으므로 빈 항목으로 넘겨준다
              void moveFiles(paths, num, { change: num, description: '', time: null, shelved: false, files: [] })
            } else {
              flash(`CL ${num} 생성됨`)
              void load()
            }
          }}
        />
      )}

      {reviewFor && (
        <ReviewRunModal
          change={reviewFor}
          onClose={() => setReviewFor(null)}
          onSaved={() => void loadCounts()}
        />
      )}

      {histFor && (
        <ReviewHistoryModal
          change={histFor.change}
          onClose={() => setHistFor(null)}
          onChanged={() => void loadCounts()}
        />
      )}

      {logFor && (
        <SubmitLogModal
          change={logFor}
          defaultSendDiff={cfg?.sendDiff !== false}
          model={cfg?.model ?? ''}
          onClose={() => setLogFor(null)}
          onSaved={() => {
            setLogFor(null)
            flash('체인지리스트 설명에 저장했습니다.')
            void load()
          }}
        />
      )}
    </div>
  )
}

// ── 새 체인지리스트 만들기 ───────────────────────────────────
function NewChangeModal({
  moveCount = 0,
  onClose,
  onCreated,
}: {
  /** 만든 뒤 바로 옮길 파일 수 (0 이면 빈 체인지리스트만 만든다) */
  moveCount?: number
  onClose: () => void
  onCreated: (change: string) => void
}) {
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const create = async () => {
    const text = desc.trim()
    if (!text) return
    setBusy(true)
    setErr(null)
    const res = await window.desktop?.p4.createChange(text)
    setBusy(false)
    if (res?.ok && res.change) onCreated(res.change)
    else setErr(res?.error ?? '생성 실패')
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, busy])

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>새 체인지리스트</h3>
        <p className="muted small">
          {moveCount > 0
            ? `만든 뒤 선택한 ${moveCount}개 파일을 이리로 옮깁니다.`
            : '빈 체인지리스트를 만듭니다. 만든 뒤 파일을 끌어다 놓아 옮기세요.'}
        </p>

        <label>설명</label>
        <textarea
          className="p4-log"
          value={desc}
          autoFocus
          rows={4}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+Enter 로 바로 만들기 (Enter 는 줄바꿈 — P4 설명은 여러 줄이 가능하다)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void create()
            }
          }}
          placeholder="예: [김건훈] 오파즈 획득 시스템 수정"
        />

        {err && <p className="error small">{err}</p>}

        <div className="modal-actions">
          <span className="muted small" style={{ marginRight: 'auto' }}>
            Ctrl+Enter 로 만들기
          </span>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button onClick={() => void create()} disabled={!desc.trim() || busy}>
            {busy ? '만드는 중…' : '만들기'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 서밋 로그 작성 모달 ──────────────────────────────────────
function SubmitLogModal({
  change,
  defaultSendDiff,
  model,
  onClose,
  onSaved,
}: {
  change: P4Change
  defaultSendDiff: boolean
  model: string
  onClose: () => void
  onSaved: () => void
}) {
  const [sendDiff, setSendDiff] = useState(defaultSendDiff)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [meta, setMeta] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !saving) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, busy, saving])

  const generate = async () => {
    setBusy(true)
    setErr(null)
    setMeta(null)
    try {
      const res = await window.desktop?.llm.submitLog({
        change: change.change,
        files: change.files,
        description: change.description,
        sendDiff,
      })
      if (!res?.ok) {
        setErr(res?.error ?? '작성 실패')
        return
      }
      setText(res.text ?? '')
      const bits: string[] = []
      if (res.model) bits.push(res.model)
      bits.push(res.diffUsed ? 'diff 포함' : 'diff 없이 파일 목록만')
      if (res.binaryCount) bits.push(`바이너리 ${res.binaryCount}개`)
      if (res.historyCount) bits.push(`내 과거 서밋 ${res.historyCount}건 참고`)
      if (res.diffTruncated) bits.push('diff 일부 생략')
      if (res.usage?.total_tokens) bits.push(`${res.usage.total_tokens} 토큰`)
      setMeta(bits.join(' · '))

      const warn: string[] = []
      if (res.diffError) warn.push(`diff 를 못 읽어 파일 목록만 사용했습니다: ${res.diffError}`)
      if (res.issueDropped) warn.push('이력에 없는 작업번호가 나와서 제외했습니다. 필요하면 직접 적어주세요.')
      if (!res.historyCount) warn.push('이 파일들에 대한 내 과거 서밋을 못 찾아 컨텐츠명·작업번호를 확인하지 못했습니다.')
      if (warn.length) setErr(warn.join('\n'))
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setErr(null)
    const res = await window.desktop?.p4.setDescription(change.change, text)
    setSaving(false)
    if (res?.ok) onSaved()
    else setErr(res?.error ?? '저장 실패')
  }

  const isDefault = change.change === 'default'

  return (
    <div className="modal-overlay" onClick={() => !busy && !saving && onClose()}>
      <div className="modal p4-modal" onClick={(e) => e.stopPropagation()}>
        <h3>서밋 로그 작성 — {isDefault ? 'default' : `CL ${change.change}`}</h3>
        <p className="muted small">
          파일 {change.files.length}개 · 사내 LLM({model || '기본 모델'})으로 작성합니다. 사내망 안에서 처리되어 코드가
          회사 밖으로 나가지 않습니다.
        </p>

        <label className="chk-line p4-diff-toggle">
          <input type="checkbox" checked={sendDiff} onChange={(e) => setSendDiff(e.target.checked)} disabled={busy} />
          <span>변경 내용(diff)까지 보내기 — 끄면 파일 경로만 보고 씁니다</span>
        </label>

        <div className="modal-actions p4-gen-row">
          <button onClick={() => void generate()} disabled={busy}>
            {busy ? '작성 중…' : text ? '다시 작성' : '작성'}
          </button>
          {meta && <span className="muted small">{meta}</span>}
        </div>

        {err && <p className="error small">{err}</p>}

        <label>서밋 로그 (직접 고칠 수 있어요)</label>
        <textarea
          className="p4-log"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          placeholder="[작성] 버튼을 누르면 여기에 채워집니다."
        />

        <div className="modal-actions">
          <button
            className="btn-secondary"
            onClick={() => void navigator.clipboard.writeText(text)}
            disabled={!text.trim()}
            style={{ marginRight: 'auto' }}
          >
            복사
          </button>
          <button className="btn-secondary" onClick={onClose} disabled={busy || saving}>
            닫기
          </button>
          <button
            onClick={() => void save()}
            disabled={!text.trim() || busy || saving || isDefault}
            title={isDefault ? 'default 에는 설명을 저장할 수 없어요. 새 체인지리스트로 옮기세요.' : undefined}
          >
            {saving ? '저장 중…' : 'CL 설명에 저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
