import { useRef, useState } from 'react'
import { loadShortcuts, saveShortcuts, trashShortcut, type Shortcut } from '../lib/shortcuts'

// PC 전용 바로가기 독(dock) — 최좌측 세로 바 (Electron에서만 표시). 저장은 로컬(localStorage).
// 삭제하면 사라지지 않고 휴지통으로 옮겨진다 (휴지통 화면에서 복원 가능).

const EMOJIS = [
  '🌐', '💻', '🖥️', '📱', '⌨️', '🖱️', '📁', '🗂️',
  '📂', '📝', '📄', '📊', '📈', '📉', '📅', '📆',
  '⏰', '⏱️', '🔧', '🔨', '🛠️', '⚙️', '🧰', '🧪',
  '🔬', '🚀', '⭐', '🌟', '🔥', '💡', '🔔', '📌',
  '📎', '🔗', '🔒', '🔑', '💬', '📧', '✉️', '📮',
  '🎮', '🕹️', '🎵', '🎧', '🎬', '📷', '🎨', '🖌️',
  '🐙', '🐳', '🐍', '☁️', '🗄️', '💾', '📚', '📖',
  '🏦', '💰', '💳', '📞', '🏃', '⚽', '🏆', '🎯',
]
const COLORS = ['#ff6b35', '#3fb0ff', '#3fb950', '#a78bfa', '#facc15', '#ff6b9d', '#22d3ee', '#fb923c', '#f472b6', '#34d399']

export function Shortcuts() {
  const [list, setList] = useState<Shortcut[]>(loadShortcuts)
  const [dialog, setDialog] = useState<{ sc?: Shortcut } | null>(null)
  const [menu, setMenu] = useState<{ sc: Shortcut; x: number; y: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null)
  const dragIdx = useRef<number | null>(null)

  // PC 전용 — 브라우저/모바일에서는 표시하지 않음
  if (!window.desktop?.isDesktop) return null

  const update = (next: Shortcut[]) => {
    setList(next)
    saveShortcuts(next)
  }
  // 삭제 = 휴지통으로 이동
  const remove = (id: string) => {
    trashShortcut(id)
    setList(loadShortcuts())
  }
  const upsert = (s: Shortcut) => {
    update(list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s])
  }
  const open = async (s: Shortcut) => {
    const r = await window.desktop?.openShortcut(s.target)
    if (r && !r.ok) {
      setErr(`실행 실패: ${s.name}${r.error ? ` (${r.error})` : ''}`)
      window.setTimeout(() => setErr(null), 4000)
    }
  }

  const onDragEnter = (i: number) => {
    const from = dragIdx.current
    if (from === null || from === i) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(i, 0, moved)
    dragIdx.current = i
    update(next)
  }

  return (
    <div className="dock">
      <div className="dock-list">
        {list.map((s, i) => (
          <div
            key={s.id}
            className={`dock-item ${draggingId === s.id ? 'dragging' : ''}`}
            draggable
            onDragStart={() => {
              dragIdx.current = i
              setDraggingId(s.id)
              setTip(null)
            }}
            onDragEnter={() => onDragEnter(i)}
            onDragOver={(e) => e.preventDefault()}
            onDragEnd={() => {
              dragIdx.current = null
              setDraggingId(null)
            }}
          >
            <button
              className="dock-btn"
              style={s.emoji ? undefined : { background: s.color ?? '#666' }}
              onClick={() => void open(s)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ sc: s, x: e.clientX, y: e.clientY })
              }}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setTip({ name: s.name, x: r.right + 8, y: r.top + r.height / 2 })
              }}
              onMouseLeave={() => setTip(null)}
            >
              {s.emoji ?? s.name.slice(0, 1).toUpperCase()}
            </button>
          </div>
        ))}
      </div>

      <button className="dock-add" title="바로가기 추가" onClick={() => setDialog({})}>
        ＋
      </button>

      {tip && (
        <div className="dock-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.name}
        </div>
      )}

      {err && <div className="dock-toast">{err}</div>}

      {menu && (
        <>
          <div
            className="menu-overlay"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              onClick={() => {
                setDialog({ sc: menu.sc })
                setMenu(null)
              }}
            >
              수정
            </button>
            <button
              className="danger"
              onClick={() => {
                remove(menu.sc.id)
                setMenu(null)
              }}
            >
              삭제
            </button>
          </div>
        </>
      )}

      {dialog && (
        <ShortcutDialog
          initial={dialog.sc}
          onClose={() => setDialog(null)}
          onSave={(s) => {
            upsert(s)
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}

function ShortcutDialog({
  initial,
  onClose,
  onSave,
}: {
  initial?: Shortcut
  onClose: () => void
  onSave: (s: Shortcut) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [target, setTarget] = useState(initial?.target ?? '')
  const [emoji, setEmoji] = useState<string | null>(initial?.emoji ?? null)

  const valid = name.trim().length > 0 && target.trim().length > 0
  const submit = () => {
    if (!valid) return
    // 이모지 없으면 색상: 편집 시 기존 색 유지, 신규는 랜덤
    const color = emoji ? null : initial && !initial.emoji ? initial.color : COLORS[Math.floor(Math.random() * COLORS.length)]
    onSave({ id: initial?.id ?? crypto.randomUUID(), name: name.trim(), target: target.trim(), emoji, color })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? '바로가기 수정' : '바로가기 추가'}</h3>

        <label>이름</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 회사 위키" autoFocus />

        <label>대상 (웹주소 또는 파일 경로)</label>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="https://...  또는  C:\Tools\app.exe"
        />

        <label>아이콘 (선택 안 하면 색상 박스)</label>
        <div className="emoji-grid">
          <button
            type="button"
            className={`emoji-opt ${emoji === null ? 'active' : ''}`}
            onClick={() => setEmoji(null)}
            title="없음 (색상 박스)"
          >
            ∅
          </button>
          {EMOJIS.map((e) => (
            <button
              type="button"
              key={e}
              className={`emoji-opt ${emoji === e ? 'active' : ''}`}
              onClick={() => setEmoji(e)}
            >
              {e}
            </button>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            취소
          </button>
          <button onClick={submit} disabled={!valid}>
            {initial ? '저장' : '추가'}
          </button>
        </div>
      </div>
    </div>
  )
}
