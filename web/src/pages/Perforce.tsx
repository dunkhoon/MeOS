import { useCallback, useEffect, useRef, useState } from 'react'
import { CollapsibleCard } from '../components/CollapsibleCard'

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
  const isDesktop = !!window.desktop?.isDesktop

  const [cfg, setCfg] = useState<P4Config | null>(null)
  const [changes, setChanges] = useState<P4Change[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 서밋 로그 모달
  const [logFor, setLogFor] = useState<P4Change | null>(null)

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
      setChanges(res.changes ?? [])
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isDesktop) void load()
  }, [isDesktop, load])

  const flash = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(null), 3500)
  }

  // ── 파일 드래그 이동 ───────────────────────────────────────
  const dragRef = useRef<{ file: string; from: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const dropTo = (toChange: string) => async (e: React.DragEvent) => {
    e.preventDefault()
    const d = dragRef.current
    dragRef.current = null
    setOver(null)
    if (!d || d.from === toChange) return

    // 화면에 먼저 반영하고, 실패하면 되돌린다
    const before = changes
    setChanges((prev) =>
      prev.map((c) => {
        if (c.change === d.from) return { ...c, files: c.files.filter((f) => f.depotFile !== d.file) }
        if (c.change === toChange) {
          const moved = before.find((x) => x.change === d.from)?.files.find((f) => f.depotFile === d.file)
          return moved ? { ...c, files: [...c.files, { ...moved, change: toChange }] } : c
        }
        return c
      }),
    )

    const res = await window.desktop?.p4.reopen([d.file], toChange)
    if (!res?.ok) {
      setChanges(before)
      setErr(`파일 이동 실패: ${res?.error ?? '알 수 없는 오류'}`)
    } else {
      flash(`${baseName(d.file)} → ${toChange === 'default' ? 'default' : `CL ${toChange}`}`)
      void load()
    }
  }

  // window.prompt 는 Electron 에서 동작하지 않아 모달을 쓴다
  const [newOpen, setNewOpen] = useState(false)

  if (!isDesktop) {
    return (
      <div className="page">
        <header className="page-head">
          <h2>
            Perforce <span className="tag">PC 전용</span>
          </h2>
          <p className="muted">Pending 체인지리스트 · 파일 이동 · 서밋 로그 작성</p>
        </header>
        <div className="card">
          Perforce 는 사내망과 로컬 워크스페이스가 필요해 데스크톱 앱에서만 사용할 수 있어요.
        </div>
      </div>
    )
  }

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
        파일을 다른 체인지리스트로 끌어다 놓으면 이동합니다 (<code>p4 reopen</code>). 총 {totalFiles}개 파일.
      </p>

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
              c.files.map((f) => (
                <div
                  key={f.depotFile}
                  className="p4-file"
                  draggable
                  onDragStart={() => {
                    dragRef.current = { file: f.depotFile, from: c.change }
                  }}
                  onDragEnd={() => {
                    dragRef.current = null
                    setOver(null)
                  }}
                  title={f.depotFile}
                >
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
          onClose={() => setNewOpen(false)}
          onCreated={(num) => {
            setNewOpen(false)
            flash(`CL ${num} 생성됨`)
            void load()
          }}
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
function NewChangeModal({ onClose, onCreated }: { onClose: () => void; onCreated: (change: string) => void }) {
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
          빈 체인지리스트를 만듭니다. 만든 뒤 파일을 끌어다 놓아 옮기세요.
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
