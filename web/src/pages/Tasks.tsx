import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../components/CollapsibleCard'
import {
  STATUSES,
  STATUS_LABEL,
  addRoutine,
  addWorkItem,
  fetchRoutines,
  fetchWorkItems,
  isRoutineDone,
  saveRoutineOrder,
  saveWorkOrder,
  setRoutineDone,
  todayStr,
  trashRoutine,
  trashWorkItem,
  updateWorkItem,
  type Routine,
  type WorkItem,
  type WorkList,
  type WorkStatus,
} from '../lib/work'
import { issueNo, normalizeUrl, splitTitleAndUrl, workCopyText } from '../lib/workText'
import { computeReorder } from '../lib/reorder'

/** 상태 칩을 누르면 한 단계씩 진행 → 완료 다음엔 다시 대기로 돈다. */
const NEXT_STATUS: Record<WorkStatus, WorkStatus> = { wait: 'doing', doing: 'done', done: 'wait' }

const bySort = (a: { sort: number }, b: { sort: number }) => a.sort - b.sort

// 드래그 중인 대상. dragover 시점에는 dataTransfer 를 읽을 수 없어 ref 로 들고 다닌다.
type DragData = { kind: 'item'; id: string } | { kind: 'bts'; issue: BtsIssue }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function openLink(url: string) {
  if (window.desktop?.isDesktop) void window.desktop.openShortcut(url)
  else window.open(url, '_blank', 'noopener')
}

function sysLabel(s: 'redmine' | 'jira' | null): string {
  return s === 'jira' ? 'JIRA' : 'Redmine'
}

export default function Tasks() {
  const isDesktop = !!window.desktop?.isDesktop

  const [items, setItems] = useState<WorkItem[]>([])
  const [routines, setRoutines] = useState<Routine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // 자정을 넘겨 앱을 켜둔 경우에도 루틴 체크가 저절로 풀리도록 오늘 날짜를 주기적으로 갱신
  const [today, setToday] = useState(todayStr)
  useEffect(() => {
    const t = window.setInterval(() => setToday(todayStr()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const reload = useCallback(async () => {
    try {
      const [w, r] = await Promise.all([fetchWorkItems(), fetchRoutines()])
      setItems(w)
      setRoutines(r)
      setErr(null)
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // ── 드래그 상태 ────────────────────────────────────────────
  const dragRef = useRef<DragData | null>(null)
  const routineDragRef = useRef<string | null>(null) // 루틴은 업무 드롭 영역과 섞이지 않게 따로 둔다
  const [over, setOver] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // 드래그로 바꾼 순서는 화면에 즉시 반영하고, 드래그가 끝날 때 한 번에 저장한다
  const pendingWorkOrder = useRef(new Map<string, number>())
  const pendingRoutineOrder = useRef(new Map<string, number>())

  const flushOrder = () => {
    const work = [...pendingWorkOrder.current].map(([id, sort]) => ({ id, sort }))
    const rt = [...pendingRoutineOrder.current].map(([id, sort]) => ({ id, sort }))
    pendingWorkOrder.current.clear()
    pendingRoutineOrder.current.clear()
    if (work.length) saveWorkOrder(work).catch((e) => { setErr(errMsg(e)); void reload() })
    if (rt.length) saveRoutineOrder(rt).catch((e) => { setErr(errMsg(e)); void reload() })
  }

  const startDrag = (e: React.DragEvent, data: DragData) => {
    dragRef.current = data
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', data.kind === 'item' ? data.id : data.issue.key)
  }
  const endDrag = () => {
    dragRef.current = null
    routineDragRef.current = null
    setDraggingId(null)
    setOver(null)
    flushOrder()
  }
  const allowDrop = (zone: string) => (e: React.DragEvent) => {
    if (!dragRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOver(zone)
  }
  // 영역 안 자식(행) 사이를 지날 때도 dragleave 가 뜨므로, 진짜로 벗어났을 때만 강조를 푼다
  const leaveDrop = (zone: string) => (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setOver((o) => (o === zone ? null : o))
  }

  /** 드롭 → 해당 리스트/상태로 이동하거나, BTS 이슈면 새 항목으로 등록한다. */
  const dropTo = (list: WorkList, status: WorkStatus) => async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const d = dragRef.current
    endDrag()
    if (!d) return

    if (d.kind === 'item') {
      const it = items.find((x) => x.id === d.id)
      if (!it || (it.list === list && it.status === status)) return
      setItems((prev) => prev.map((x) => (x.id === d.id ? { ...x, list, status } : x)))
      try {
        await updateWorkItem(d.id, { list, status })
      } catch (e2) {
        setErr(errMsg(e2))
        void reload()
      }
      return
    }

    // BTS 이슈 → 이미 끌어다 놓은 적이 있으면 상태만 바꾸고 중복 생성하지 않는다
    const issue = d.issue
    const exist = items.find(
      (x) => x.origin === 'bts' && x.btsSystem === issue.system && x.btsIssueId === issue.issueId,
    )
    if (exist) {
      setItems((prev) => prev.map((x) => (x.id === exist.id ? { ...x, list, status } : x)))
      try {
        await updateWorkItem(exist.id, { list, status })
      } catch (e2) {
        setErr(errMsg(e2))
        void reload()
      }
      return
    }

    try {
      const created = await addWorkItem({
        list,
        status,
        title: issue.title,
        url: issue.url,
        origin: 'bts',
        btsSystem: issue.system,
        btsIssueId: issue.issueId,
        btsTracker: issue.tracker,
        btsVersion: issue.version,
      })
      setItems((prev) => [...prev, created])
    } catch (e2) {
      setErr(errMsg(e2))
      void reload()
    }
  }

  // ── 항목 조작 ──────────────────────────────────────────────
  const progress = items.filter((i) => i.list === 'progress').sort(bySort)
  const todos = items.filter((i) => i.list === 'todo').sort(bySort)

  /** 할 일 목록 안에서 순서 바꾸기 — 지나가는 행 위로 실시간 반영. */
  const reorderTodo = (targetId: string) => () => {
    const d = dragRef.current
    if (!d || d.kind !== 'item' || d.id === targetId) return
    const from = todos.findIndex((x) => x.id === d.id)
    const to = todos.findIndex((x) => x.id === targetId)
    if (from < 0 || to < 0) return // 다른 목록에서 끌어온 항목은 드롭 때 처리한다
    const changes = computeReorder(todos, from, to)
    if (!changes.length) return
    changes.forEach((c) => pendingWorkOrder.current.set(c.id, c.sort))
    const map = new Map(changes.map((c) => [c.id, c.sort]))
    setItems((prev) => prev.map((x) => (map.has(x.id) ? { ...x, sort: map.get(x.id)! } : x)))
  }

  /** 상태 칩 클릭 — 대기 → 진행 → 완료 → (다시) 대기. */
  const cycleStatus = async (it: WorkItem) => {
    const next = NEXT_STATUS[it.status]
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, status: next } : x)))
    try {
      await updateWorkItem(it.id, { status: next })
    } catch (e) {
      setErr(errMsg(e))
      void reload()
    }
  }

  const addTo = async (list: WorkList, status: WorkStatus, text: string, urlInput?: string) => {
    // URL 칸을 따로 채웠으면 그걸 쓰고, 비었으면 "제목 https://…" 붙여넣기 규칙으로 떼어낸다
    const parsed = urlInput ? { title: text.trim(), url: normalizeUrl(urlInput) } : splitTitleAndUrl(text)
    const { title, url } = parsed
    if (!title) return
    try {
      const created = await addWorkItem({ list, status, title, url })
      setItems((prev) => [...prev, created])
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const trashItem = async (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    try {
      await trashWorkItem(id)
    } catch (e) {
      setErr(errMsg(e))
      void reload()
    }
  }

  const toggleDone = async (it: WorkItem) => {
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))
    try {
      await updateWorkItem(it.id, { done: !it.done })
    } catch (e) {
      setErr(errMsg(e))
      void reload()
    }
  }

  // ── 등록한 뒤 수정 (제목 · 링크) ────────────────────────────
  // 제목과 URL 은 따로 고친다 — 한 칸에 섞으면 제목에 공백이 들어간 링크나
  // 링크만 지우고 싶은 경우를 다루기 어렵다.
  const [editing, setEditing] = useState<{ id: string; field: 'title' | 'url' } | null>(null)
  const editingTitleId = editing?.field === 'title' ? editing.id : null

  const applyPatch = async (it: WorkItem, patch: Partial<Pick<WorkItem, 'title' | 'url'>>) => {
    setEditing(null)
    if ((patch.title ?? it.title) === it.title && (patch.url ?? it.url) === it.url) return
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, ...patch } : x)))
    try {
      await updateWorkItem(it.id, patch)
    } catch (e) {
      setErr(errMsg(e))
      void reload()
    }
  }

  const saveEdit = async (it: WorkItem, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setEditing(null)
      return // 제목을 비우는 건 삭제가 아니므로 무시
    }
    // BTS 항목은 원본 이슈 링크를 유지하고 제목만 고친다.
    // 직접 입력 항목은 "제목 https://…" 를 붙여넣는 습관을 계속 지원한다.
    if (it.origin === 'bts') {
      await applyPatch(it, { title: trimmed })
      return
    }
    const next = splitTitleAndUrl(trimmed)
    // URL 을 안 적었으면 기존 링크는 그대로 둔다 (URL 은 URL 버튼으로 따로 고친다)
    await applyPatch(it, next.url ? next : { title: next.title })
  }

  const saveUrl = async (it: WorkItem, text: string) => {
    await applyPatch(it, { url: normalizeUrl(text) })
  }

  // ── 루틴 ───────────────────────────────────────────────────
  const sortedRoutines = [...routines].sort(bySort)
  const routineDone = routines.filter((r) => isRoutineDone(r, today)).length

  const reorderRoutine = (targetId: string) => () => {
    const movedId = routineDragRef.current
    if (!movedId || movedId === targetId) return
    const from = sortedRoutines.findIndex((x) => x.id === movedId)
    const to = sortedRoutines.findIndex((x) => x.id === targetId)
    const changes = computeReorder(sortedRoutines, from, to)
    if (!changes.length) return
    changes.forEach((c) => pendingRoutineOrder.current.set(c.id, c.sort))
    const map = new Map(changes.map((c) => [c.id, c.sort]))
    setRoutines((prev) => prev.map((x) => (map.has(x.id) ? { ...x, sort: map.get(x.id)! } : x)))
  }

  const toggleRoutine = async (r: Routine) => {
    const next = !isRoutineDone(r, today)
    setRoutines((prev) => prev.map((x) => (x.id === r.id ? { ...x, lastDoneOn: next ? today : null } : x)))
    try {
      await setRoutineDone(r.id, next)
    } catch (e) {
      setErr(errMsg(e))
      void reload()
    }
  }

  const addRoutineItem = async (title: string) => {
    try {
      const created = await addRoutine(title)
      setRoutines((prev) => [...prev, created])
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const removeRoutine = async (id: string) => {
    setRoutines((prev) => prev.filter((x) => x.id !== id))
    try {
      await trashRoutine(id)
    } catch (e) {
      setErr(errMsg(e))
      void reload()
    }
  }

  // 진행 중인 업무에 이미 올라간 BTS 이슈 → BTS 목록에서 강조 표시
  const trackedByKey = useMemo(() => {
    const m = new Map<string, WorkItem>()
    for (const i of items) {
      if (i.origin === 'bts' && i.btsSystem && i.btsIssueId) m.set(`${i.btsSystem}:${i.btsIssueId}`, i)
    }
    return m
  }, [items])

  const progressInput = useRef<HTMLInputElement>(null)

  return (
    <div className="page">
      <header className="page-head work-head">
        <h2>업무</h2>
        <span className="work-sub muted">BTS · 이슈 · 루틴 · 도구 — 하루 업무의 중심</span>
      </header>

      {err && <div className="sync-msg err">{err}</div>}
      {loading && <p className="muted small">불러오는 중…</p>}

      {/* ── 진행 중인 업무 ─────────────────────────── */}
      <CollapsibleCard
        id="work-progress"
        title={
          <>
            <span className="sec-dot" /> 진행 중인 업무
          </>
        }
        actions={
          <>
            <span className="muted small">{progress.filter((i) => i.status === 'doing').length} 진행</span>
            <button type="button" className="link-btn" onClick={() => progressInput.current?.focus()}>
              + 이슈 등록
            </button>
          </>
        }
      >
        <div className="wp-groups">
          {STATUSES.map((st) => {
            const group = progress.filter((i) => i.status === st)
            const zone = `progress:${st}`
            return (
              <div
                key={st}
                className={`wp-group st-${st} ${over === zone ? 'over' : ''}`}
                onDragOver={allowDrop(zone)}
                onDragLeave={leaveDrop(zone)}
                onDrop={dropTo('progress', st)}
              >
                {group.length === 0 ? (
                  <div className="wp-row empty">
                    <span className={`chip st-${st}`}>{STATUS_LABEL[st]}</span>
                  </div>
                ) : (
                  group.map((it) => (
                    <WorkRow
                      key={it.id}
                      item={it}
                      dragging={draggingId === it.id}
                      editing={editingTitleId === it.id}
                      editingUrl={editing?.id === it.id && editing.field === 'url'}
                      onStartEdit={() => setEditing({ id: it.id, field: 'title' })}
                      onStartEditUrl={() => setEditing({ id: it.id, field: 'url' })}
                      onSaveEdit={(text) => void saveEdit(it, text)}
                      onSaveUrl={(text) => void saveUrl(it, text)}
                      onCancelEdit={() => setEditing(null)}
                      onCycleStatus={() => void cycleStatus(it)}
                      onDragStart={(e, d) => {
                        setDraggingId(it.id)
                        startDrag(e, d)
                      }}
                      onDragEnd={endDrag}
                      onTrash={trashItem}
                    />
                  ))
                )}
              </div>
            )
          })}
        </div>

        <AddForm
          inputRef={progressInput}
          placeholder="진행 중인 업무 직접 추가 (대기로)"
          withUrl
          onAdd={(t, u) => void addTo('progress', 'wait', t, u)}
        />
      </CollapsibleCard>

      {/* ── BTS (Redmine / JIRA) ───────────────────── */}
      <BtsSection
        isDesktop={isDesktop}
        trackedByKey={trackedByKey}
        onDragStart={startDrag}
        onDragEnd={endDrag}
      />

      {/* ── 할 일 + 루틴 ───────────────────────────── */}
      <div className="work-bottom">
        <CollapsibleCard
          id="work-todo"
          title={
            <>
              <span className="sec-dot" /> 할 일 (BTS 외)
            </>
          }
          actions={<span className="muted small">{todos.filter((t) => !t.done).length} 남음</span>}
        >
          <div
            className={`todo-drop ${over === 'todo' ? 'over' : ''}`}
            onDragOver={allowDrop('todo')}
            onDragLeave={leaveDrop('todo')}
            onDrop={dropTo('todo', 'wait')}
          >
            {todos.length === 0 ? (
              <p className="muted small todo-empty">BTS 와 무관한 할 일을 추가하세요. (드래그해 진행 중으로 이동 가능)</p>
            ) : (
              todos.map((it) => (
                <div
                  key={it.id}
                  className={`todo-row ${it.done ? 'done' : ''} ${draggingId === it.id ? 'dragging' : ''}`}
                  draggable={editing?.id !== it.id}
                  onDragStart={(e) => {
                    setDraggingId(it.id)
                    startDrag(e, { kind: 'item', id: it.id })
                  }}
                  onDragEnter={reorderTodo(it.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnd={endDrag}
                >
                  <button
                    type="button"
                    className={`cbx ${it.done ? 'on' : ''}`}
                    aria-label="완료"
                    onClick={() => void toggleDone(it)}
                  />
                  {it.origin === 'bts' && it.btsSystem && (
                    <>
                      <span className={`chip sys-${it.btsSystem}`}>{sysLabel(it.btsSystem)}</span>
                      <span className="wp-id">{issueNo(it.btsSystem, it.btsIssueId ?? '')}</span>
                    </>
                  )}
                  {editing?.id === it.id && editing.field === 'url' ? (
                    <UrlEdit item={it} onSave={(text) => void saveUrl(it, text)} onCancel={() => setEditing(null)} />
                  ) : (
                    <RowTitle
                      item={it}
                      cls="todo-title"
                      editing={editingTitleId === it.id}
                      onStartEdit={() => setEditing({ id: it.id, field: 'title' })}
                      onSave={(text) => void saveEdit(it, text)}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                  {editing?.id !== it.id && (
                    <span className="wp-right">
                      <RowActions
                        item={it}
                        onEditTitle={() => setEditing({ id: it.id, field: 'title' })}
                        onEditUrl={() => setEditing({ id: it.id, field: 'url' })}
                        onTrash={() => void trashItem(it.id)}
                      />
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
          <AddForm placeholder="할 일 추가" withUrl onAdd={(t, u) => void addTo('todo', 'wait', t, u)} />
        </CollapsibleCard>

        <CollapsibleCard
          id="work-routine"
          title={
            <>
              <span className="sec-dot" /> 루틴 (매일 리셋)
            </>
          }
          actions={
            <span className="muted small">
              {routineDone}/{routines.length}
            </span>
          }
        >
          <div className="rt-list">
            {routines.length === 0 && <p className="muted small">매일 반복하는 항목을 추가하세요. 날짜가 바뀌면 자동으로 리셋됩니다.</p>}
            {sortedRoutines.map((r) => {
              const done = isRoutineDone(r, today)
              return (
                <div
                  key={r.id}
                  className={`rt-row ${done ? 'done' : ''} ${draggingId === r.id ? 'dragging' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    routineDragRef.current = r.id
                    setDraggingId(r.id)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', r.id)
                  }}
                  onDragEnter={reorderRoutine(r.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnd={endDrag}
                >
                  <button
                    type="button"
                    className={`cbx ${done ? 'on' : ''}`}
                    aria-label={r.title}
                    onClick={() => void toggleRoutine(r)}
                  />
                  <span className="rt-title" onClick={() => void toggleRoutine(r)}>
                    {r.title}
                  </span>
                  <button type="button" className="row-x" title="휴지통으로" onClick={() => void removeRoutine(r.id)}>
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
          <AddForm placeholder="루틴 항목 추가" onAdd={(t) => void addRoutineItem(t)} />
        </CollapsibleCard>
      </div>
    </div>
  )
}

// ── 행 안에서 제목 고치기 ────────────────────────────────────
// 링크가 있는 항목은 제목 클릭이 "열기"이므로, 더블클릭 편집은 링크가 없을 때만 걸어
// 클릭이 겹치지 않게 한다. 연필 버튼은 항상 쓸 수 있다.
function RowTitle({
  item,
  cls,
  editing,
  onStartEdit,
  onSave,
  onCancel,
}: {
  item: WorkItem
  cls: string
  editing: boolean
  onStartEdit: () => void
  onSave: (text: string) => void
  onCancel: () => void
}) {
  if (editing) {
    // 수정할 땐 add 입력과 같은 규칙 — "제목 https://…" 로 링크까지 한 줄에 고친다
    const initial = item.origin === 'bts' ? item.title : [item.title, item.url].filter(Boolean).join(' ')
    return <EditInput initial={initial} onSave={onSave} onCancel={onCancel} />
  }
  return (
    <span
      className={`${cls} ${item.url ? 'link' : ''}`}
      title={item.url ? item.url : '더블클릭해서 수정'}
      onClick={() => item.url && openLink(item.url)}
      onDoubleClick={() => !item.url && onStartEdit()}
    >
      {item.title}
    </span>
  )
}

function EditInput({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string
  placeholder?: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const cancelled = useRef(false)

  return (
    <input
      className="row-edit"
      value={text}
      placeholder={placeholder}
      autoFocus
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onSave(text)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelled.current = true
          onCancel()
        }
      }}
      // 포커스를 잃으면 저장 (Esc 로 취소한 경우는 제외)
      onBlur={() => {
        if (!cancelled.current) onSave(text)
      }}
    />
  )
}

const EditIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

const LinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </svg>
)

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

/** 항목 내용을 클립보드로. BTS 항목은 이슈번호가 앞에 붙는다 (workCopyText). */
function CopyButton({ item }: { item: WorkItem }) {
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const copy = async () => {
    const text = workCopyText(item)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return // 클립보드 권한이 없으면 조용히 넘어간다 (표시도 하지 않는다)
    }
    setDone(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setDone(false), 1200)
  }

  return (
    <button
      type="button"
      className={`row-icon copy-btn ${done ? 'copied' : ''}`}
      title={done ? '복사됨' : `복사: ${workCopyText(item)}`}
      onClick={() => void copy()}
    >
      {done ? '✓' : <CopyIcon />}
    </button>
  )
}

/** 열기 / URL 수정 / 제목 수정 / 삭제 — 두 목록이 같은 버튼을 쓴다. */
function RowActions({
  item,
  onEditTitle,
  onEditUrl,
  onTrash,
}: {
  item: WorkItem
  onEditTitle: () => void
  onEditUrl: () => void
  onTrash: () => void
}) {
  return (
    <>
      <CopyButton item={item} />
      {item.url && (
        <button type="button" className="row-icon" title="열기" onClick={() => openLink(item.url!)}>
          <LinkIcon />
        </button>
      )}
      {/* BTS 항목의 링크는 원본 이슈 주소라 손대지 않는다 */}
      {item.origin !== 'bts' && (
        <button
          type="button"
          className="row-icon url-btn edit-btn"
          title={item.url ? `URL 수정: ${item.url}` : 'URL 지정'}
          onClick={onEditUrl}
        >
          URL
        </button>
      )}
      <button type="button" className="row-icon edit-btn" title="제목 수정" onClick={onEditTitle}>
        <EditIcon />
      </button>
      <button type="button" className="row-x" title="휴지통으로" onClick={onTrash}>
        ✕
      </button>
    </>
  )
}

// ── 진행 중인 업무 한 줄 ─────────────────────────────────────
function WorkRow({
  item,
  dragging,
  editing,
  editingUrl,
  onStartEdit,
  onStartEditUrl,
  onSaveEdit,
  onSaveUrl,
  onCancelEdit,
  onCycleStatus,
  onDragStart,
  onDragEnd,
  onTrash,
}: {
  item: WorkItem
  dragging: boolean
  editing: boolean
  editingUrl: boolean
  onStartEdit: () => void
  onStartEditUrl: () => void
  onSaveEdit: (text: string) => void
  onSaveUrl: (text: string) => void
  onCancelEdit: () => void
  onCycleStatus: () => void
  onDragStart: (e: React.DragEvent, d: DragData) => void
  onDragEnd: () => void
  onTrash: (id: string) => void
}) {
  return (
    <div
      className={`wp-row ${dragging ? 'dragging' : ''}`}
      // 수정 중엔 입력칸에서 글자를 드래그 선택할 수 있어야 하므로 드래그를 끈다
      draggable={!editing && !editingUrl}
      onDragStart={(e) => onDragStart(e, { kind: 'item', id: item.id })}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className={`chip st-${item.status} chip-btn`}
        title={`눌러서 ${STATUS_LABEL[NEXT_STATUS[item.status]]}(으)로 — 대기 → 진행 → 완료`}
        onClick={onCycleStatus}
      >
        {STATUS_LABEL[item.status]}
      </button>
      {item.origin === 'bts' && item.btsSystem && (
        <>
          <span className={`chip sys-${item.btsSystem}`}>{sysLabel(item.btsSystem)}</span>
          <span className="wp-id">{issueNo(item.btsSystem, item.btsIssueId ?? '')}</span>
        </>
      )}
      {editingUrl ? (
        <UrlEdit item={item} onSave={onSaveUrl} onCancel={onCancelEdit} />
      ) : (
        <RowTitle
          item={item}
          cls="wp-title"
          editing={editing}
          onStartEdit={onStartEdit}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      )}
      {!editing && !editingUrl && (
        <span className="wp-right">
          {item.btsVersion && <span className={`chip ver ${/^\d/.test(item.btsVersion) ? 'build' : ''}`}>{item.btsVersion}</span>}
          <RowActions
            item={item}
            onEditTitle={onStartEdit}
            onEditUrl={onStartEditUrl}
            onTrash={() => onTrash(item.id)}
          />
        </span>
      )}
    </div>
  )
}

/** URL 만 고치는 입력칸. 비우고 저장하면 링크가 사라진다. */
function UrlEdit({
  item,
  onSave,
  onCancel,
}: {
  item: WorkItem
  onSave: (text: string) => void
  onCancel: () => void
}) {
  return (
    <span className="row-urledit">
      <span className="chip url-tag">URL</span>
      <EditInput
        initial={item.url ?? ''}
        placeholder="https://…  (비우면 링크 제거)"
        onSave={onSave}
        onCancel={onCancel}
      />
    </span>
  )
}

// ── 공통 추가 입력줄 ─────────────────────────────────────────
function AddForm({
  placeholder,
  onAdd,
  inputRef,
  /** URL 칸 제공 여부 — 루틴에는 링크가 없다 */
  withUrl = false,
}: {
  placeholder: string
  onAdd: (text: string, url?: string) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  withUrl?: boolean
}) {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    onAdd(t, url.trim() || undefined)
    setText('')
    setUrl('')
  }

  return (
    <form className={`wp-add ${withUrl ? 'with-url' : ''}`} onSubmit={submit}>
      <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
      {withUrl && (
        <input
          className="wp-add-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL (선택)"
          spellCheck={false}
        />
      )}
      <button type="submit" disabled={!text.trim()}>
        추가
      </button>
    </form>
  )
}

// ── BTS 섹션 ────────────────────────────────────────────────
function BtsSection({
  isDesktop,
  trackedByKey,
  onDragStart,
  onDragEnd,
}: {
  isDesktop: boolean
  trackedByKey: Map<string, WorkItem>
  onDragStart: (e: React.DragEvent, d: DragData) => void
  onDragEnd: () => void
}) {
  const [result, setResult] = useState<BtsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tracker, setTracker] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [byVersion, setByVersion] = useState(false)

  const load = useCallback(async () => {
    if (!window.desktop?.bts) return
    setLoading(true)
    setErr(null)
    try {
      setResult(await window.desktop.bts.fetch())
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isDesktop) void load()
  }, [isDesktop, load])

  const issues = result?.issues ?? []

  // 트래커 탭 (개발 / 버그 …) — 실제 데이터에서 뽑는다
  const trackers = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of issues) m.set(i.tracker, (m.get(i.tracker) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'))
  }, [issues])

  const activeTracker = tracker && trackers.some(([t]) => t === tracker) ? tracker : trackers[0]?.[0] ?? null
  const inTracker = useMemo(
    () => issues.filter((i) => !activeTracker || i.tracker === activeTracker),
    [issues, activeTracker],
  )

  const versions = useMemo(() => {
    const s = new Set<string>()
    for (const i of inTracker) if (i.version) s.add(i.version)
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'))
  }, [inTracker])

  const rows = useMemo(() => {
    const list = version ? inTracker.filter((i) => i.version === version) : inTracker
    const sorted = [...list]
    if (byVersion) {
      sorted.sort(
        (a, b) =>
          (a.version ?? '￿').localeCompare(b.version ?? '￿', 'ko') ||
          String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
      )
    } else {
      sorted.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    }
    return sorted
  }, [inTracker, version, byVersion])

  const src = result?.sources

  return (
    <CollapsibleCard
      id="work-bts"
      title={
        <>
          <span className="sec-dot" /> BTS — 버그 트래커 (Redmine / JIRA)
        </>
      }
      actions={
        isDesktop ? (
          <>
            <span className="muted small">{issues.length}</span>
            <button type="button" className="link-btn" onClick={() => void load()} disabled={loading}>
              {loading ? '불러오는 중…' : '새로고침'}
            </button>
            <button type="button" className="link-btn" onClick={() => void window.desktop?.bts.openNew('redmine')}>
              + 등록
            </button>
          </>
        ) : (
          <span className="tag">PC 전용</span>
        )
      }
    >
      {!isDesktop ? (
        <p className="muted small">
          BTS 목록은 사내망에 연결된 PC(데스크톱 앱)에서만 실시간으로 조회합니다. 진행 중인 업무 · 할 일 · 루틴은 이
          화면에서 그대로 사용할 수 있어요.
        </p>
      ) : (
        <>
          <div className="bts-src">
            {src?.redmine.configured && (
              <span className={`chip sys-redmine ${src.redmine.error ? 'bad' : ''}`}>
                Redmine {src.redmine.error ? '오류' : `${src.redmine.count}건`}
              </span>
            )}
            {src?.jira.configured && (
              <span className={`chip sys-jira ${src.jira.error ? 'bad' : ''}`}>
                JIRA {src.jira.error ? '오류' : `${src.jira.count}건`}
              </span>
            )}
            {src && !src.redmine.configured && !src.jira.configured && (
              <span className="muted small">
                설정 → “BTS 연결 (Redmine / JIRA)” 에서 접속 정보를 입력하면 내 담당 이슈가 표시됩니다.
              </span>
            )}
          </div>

          {err && <p className="error small">{err}</p>}
          {src?.redmine.error && <p className="error small">Redmine: {src.redmine.error}</p>}
          {src?.jira.error && <p className="error small">JIRA: {src.jira.error}</p>}

          <p className="bts-hint muted small">
            행을 위 ‘진행 중인 업무’로 끌어다 놓으면 진행 중으로 표시됩니다. (BTS 목록엔 그대로 남습니다)
          </p>

          {trackers.length > 0 && (
            <div className="bts-tabs">
              {trackers.map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  className={`bts-tab ${t === activeTracker ? 'active' : ''}`}
                  onClick={() => {
                    setTracker(t)
                    setVersion(null)
                  }}
                >
                  {t} <span className="muted">{n}</span>
                </button>
              ))}
            </div>
          )}

          {versions.length > 0 && (
            <div className="bts-filter">
              <span className="muted small">목표버전</span>
              <button type="button" className={`vf-btn ${version === null ? 'active' : ''}`} onClick={() => setVersion(null)}>
                전체
              </button>
              {versions.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`vf-btn ${version === v ? 'active' : ''}`}
                  onClick={() => setVersion(v)}
                >
                  {v}
                </button>
              ))}
              <button
                type="button"
                className={`ghost-btn bts-sort ${byVersion ? 'active' : ''}`}
                onClick={() => setByVersion((b) => !b)}
              >
                버전순 정렬
              </button>
            </div>
          )}

          <div className="bts-rows">
            {rows.length === 0 && !loading && <p className="muted small">표시할 이슈가 없어요.</p>}
            {rows.map((i) => {
              const tracked = trackedByKey.get(`${i.system}:${i.issueId}`)
              return (
                <div
                  key={i.key}
                  className={`bts-row ${tracked ? 'tracked' : ''}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, { kind: 'bts', issue: i })}
                  onDragEnd={onDragEnd}
                  title="끌어서 ‘진행 중인 업무’로 이동"
                >
                  <span className={`chip sys-${i.system}`}>{sysLabel(i.system)}</span>
                  <span className="chip trk">{i.tracker}</span>
                  <span className="bts-id">{issueNo(i.system, i.issueId)}</span>
                  <span className="bts-title link" onClick={() => openLink(i.url)}>
                    {i.title}
                  </span>
                  <span className="bts-right">
                    {tracked && <span className={`chip st-${tracked.status}`}>{STATUS_LABEL[tracked.status]}</span>}
                    <span className="muted small bts-status">{i.status}</span>
                    {i.version && <span className={`chip ver ${/^\d/.test(i.version) ? 'build' : ''}`}>{i.version}</span>}
                    <span className="muted small bts-date">
                      {i.updatedAt ? dayjs(i.updatedAt).format('YYYY-MM-DD HH:mm') : ''}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </CollapsibleCard>
  )
}
