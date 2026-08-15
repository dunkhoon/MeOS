import { useState } from 'react'
import { CollapsibleCard } from '../CollapsibleCard'
import { errMsg } from '../../lib/exercise'
import {
  CATEGORIES,
  CATEGORY_COLOR,
  addExercise,
  archiveExercise,
  renameExercise,
  type StrengthExercise,
} from '../../lib/strength'

// 종목 라벨 관리. 지우는 대신 감추는 게 기본이다 —
// 과거 세트가 이 종목을 가리키고 있어서, 지우면 그때 뭘 했는지 알 수 없게 된다.
// (세트에는 이름을 복사해 두므로 기록 자체는 남지만, 종목별 통계에서 갈라진다)

export function ExerciseManager({
  exercises,
  onChanged,
}: {
  exercises: StrengthExercise[]
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState<string>('chest')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const visible = exercises.filter((e) => showArchived || !e.archived)
  const archivedCount = exercises.filter((e) => e.archived).length

  return (
    <CollapsibleCard
      id="ex-strength-manage"
      title="종목 관리"
      actions={
        archivedCount > 0 ? (
          <button className="link-btn small" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '감춘 것 숨기기' : `감춘 것 ${archivedCount}개 보기`}
          </button>
        ) : undefined
      }
    >
      {error && <p className="error small">{error}</p>}

      <form
        className="em-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim() || busy) return
          void run(async () => {
            await addExercise(name, cat)
            setName('')
          })
        }}
      >
        <input
          className="em-input"
          placeholder="종목 이름 (예: 바벨 프레스)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select className="st-select" value={cat} onChange={(e) => setCat(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="ghost-btn" type="submit" disabled={busy || !name.trim()}>
          추가
        </button>
      </form>

      {visible.length === 0 ? (
        <p className="muted small">종목이 없습니다.</p>
      ) : (
        <div className="em-list">
          {CATEGORIES.map((c) => {
            const list = visible.filter((e) => (e.category ?? 'other') === c.key)
            if (!list.length) return null
            return (
              <div key={c.key} className="em-group">
                <div className="st-cat-name">
                  <i style={{ background: CATEGORY_COLOR[c.key] }} />
                  {c.label}
                </div>
                {list.map((e) =>
                  editing === e.id ? (
                    <EditRow
                      key={e.id}
                      ex={e}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={(n, k) =>
                        void run(async () => {
                          await renameExercise(e.id, n, k)
                          setEditing(null)
                        })
                      }
                    />
                  ) : (
                    <div key={e.id} className={`em-row ${e.archived ? 'archived' : ''}`}>
                      <span className="em-name">{e.name}</span>
                      {e.archived && <span className="muted small">감춤</span>}
                      <button className="link-btn small" disabled={busy} onClick={() => setEditing(e.id)}>
                        수정
                      </button>
                      <button
                        className="link-btn small"
                        disabled={busy}
                        onClick={() => void run(() => archiveExercise(e.id, !e.archived))}
                      >
                        {e.archived ? '되살리기' : '감추기'}
                      </button>
                    </div>
                  ),
                )}
              </div>
            )
          })}
        </div>
      )}
    </CollapsibleCard>
  )
}

function EditRow({
  ex,
  busy,
  onCancel,
  onSave,
}: {
  ex: StrengthExercise
  busy: boolean
  onCancel: () => void
  onSave: (name: string, category: string) => void
}) {
  const [n, setN] = useState(ex.name)
  const [k, setK] = useState(ex.category ?? 'other')
  return (
    <div className="em-row editing">
      <input className="em-input" value={n} onChange={(e) => setN(e.target.value)} />
      <select className="st-select" value={k} onChange={(e) => setK(e.target.value)}>
        {CATEGORIES.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <button className="ghost-btn" disabled={busy || !n.trim()} onClick={() => onSave(n, k)}>
        저장
      </button>
      <button className="link-btn small" disabled={busy} onClick={onCancel}>
        취소
      </button>
    </div>
  )
}
