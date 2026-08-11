// 바로가기(dock) 저장 — PC 로컬(localStorage). 삭제하면 휴지통으로 옮긴다.

export interface Shortcut {
  id: string
  name: string
  target: string
  emoji: string | null
  color: string | null
  /** 휴지통으로 옮겨진 시각 (ISO). 살아있는 목록에는 없음. */
  deletedAt?: string
}

const KEY = 'pp:shortcuts'
const TRASH_KEY = 'pp:shortcuts:trash'

function read(key: string): Shortcut[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(v) ? (v as Shortcut[]) : []
  } catch {
    return []
  }
}
function write(key: string, list: Shortcut[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* localStorage 불가 시 무시 */
  }
}

export function loadShortcuts(): Shortcut[] {
  return read(KEY)
}
export function saveShortcuts(list: Shortcut[]) {
  write(KEY, list)
}

export function loadShortcutTrash(): Shortcut[] {
  return read(TRASH_KEY)
}

/** 삭제 = 휴지통으로 이동. */
export function trashShortcut(id: string) {
  const list = read(KEY)
  const sc = list.find((x) => x.id === id)
  if (!sc) return
  write(KEY, list.filter((x) => x.id !== id))
  write(TRASH_KEY, [{ ...sc, deletedAt: new Date().toISOString() }, ...read(TRASH_KEY)])
}

export function restoreShortcut(id: string) {
  const trash = read(TRASH_KEY)
  const sc = trash.find((x) => x.id === id)
  if (!sc) return
  write(TRASH_KEY, trash.filter((x) => x.id !== id))
  const { deletedAt: _drop, ...clean } = sc
  write(KEY, [...read(KEY), clean])
}

export function purgeShortcut(id: string) {
  write(TRASH_KEY, read(TRASH_KEY).filter((x) => x.id !== id))
}
