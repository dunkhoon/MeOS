import { supabase } from './supabase'

// 업무 모듈 데이터 접근 — 진행 중인 업무 / 할 일 / 루틴.
// 모두 Supabase 저장(클라우드) → PC·모바일 공용. 삭제는 soft delete(휴지통)로 처리한다.

export type WorkList = 'progress' | 'todo'
export type WorkStatus = 'wait' | 'doing' | 'done'
export type WorkOrigin = 'manual' | 'bts'

export const STATUSES: WorkStatus[] = ['wait', 'doing', 'done']
export const STATUS_LABEL: Record<WorkStatus, string> = { wait: '대기', doing: '진행', done: '완료' }

export interface WorkItem {
  id: string
  list: WorkList
  status: WorkStatus
  title: string
  url: string | null
  /** 항목에 붙여 둔 여러 줄 메모. 비어 있으면 null (빈 문자열로 두지 않는다 — 있는지 없는지로 화면이 갈린다) */
  note: string | null
  done: boolean
  sort: number
  origin: WorkOrigin
  btsSystem: 'redmine' | 'jira' | null
  btsIssueId: string | null
  btsTracker: string | null
  btsVersion: string | null
  deletedAt: string | null
  updatedAt: string
}

export interface Routine {
  id: string
  title: string
  sort: number
  lastDoneOn: string | null
  deletedAt: string | null
  updatedAt: string
}

interface WorkRow {
  id: string
  list: string
  status: string
  title: string
  url: string | null
  note: string | null
  done: boolean
  sort: number
  origin: string
  bts_system: string | null
  bts_issue_id: string | null
  bts_tracker: string | null
  bts_version: string | null
  deleted_at: string | null
  updated_at: string
}

interface RoutineRow {
  id: string
  title: string
  sort: number
  last_done_on: string | null
  deleted_at: string | null
  updated_at: string
}

const WORK_COLS =
  'id,list,status,title,url,note,done,sort,origin,bts_system,bts_issue_id,bts_tracker,bts_version,deleted_at,updated_at'
const ROUTINE_COLS = 'id,title,sort,last_done_on,deleted_at,updated_at'

function toItem(r: WorkRow): WorkItem {
  return {
    id: r.id,
    list: r.list === 'todo' ? 'todo' : 'progress',
    status: (STATUSES as string[]).includes(r.status) ? (r.status as WorkStatus) : 'wait',
    title: r.title,
    url: r.url,
    note: r.note,
    done: r.done,
    sort: r.sort,
    origin: r.origin === 'bts' ? 'bts' : 'manual',
    btsSystem: r.bts_system === 'redmine' || r.bts_system === 'jira' ? r.bts_system : null,
    btsIssueId: r.bts_issue_id,
    btsTracker: r.bts_tracker,
    btsVersion: r.bts_version,
    deletedAt: r.deleted_at,
    updatedAt: r.updated_at,
  }
}

function toRoutine(r: RoutineRow): Routine {
  return {
    id: r.id,
    title: r.title,
    sort: r.sort,
    lastDoneOn: r.last_done_on,
    deletedAt: r.deleted_at,
    updatedAt: r.updated_at,
  }
}

/** 로컬 기준 오늘 날짜 (YYYY-MM-DD). 루틴의 "하루 지나면 리셋" 판정 기준. */
export function todayStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 마이그레이션 미적용(테이블·컬럼 없음)을 알아보기 쉬운 메시지로 바꿔준다. */
function wrap(error: { message: string; code?: string } | null, what: string): void {
  if (!error) return
  if (error.code === '42P01' || /relation .* does not exist/i.test(error.message)) {
    throw new Error(
      `${what} 테이블이 없습니다. Supabase SQL 편집기에서 supabase/migrations/0005_work.sql 을 실행하세요.`,
    )
  }
  // 컬럼이 없다 = 나중에 추가된 마이그레이션을 아직 안 돌렸다.
  // 여기서 안 잡으면 "column work_items.note does not exist" 만 뜨고, 목록 전체가 안 보인다.
  if (error.code === '42703' || /column .* does not exist/i.test(error.message)) {
    const file = /note/.test(error.message) ? '0016_work_notes.sql' : '최신 마이그레이션'
    throw new Error(`${what} 에 없는 컬럼입니다 (${error.message}). Supabase SQL 편집기에서 ${file} 을 실행하세요.`)
  }
  throw new Error(error.message)
}

// ── 진행 중인 업무 / 할 일 ──────────────────────────────────

export async function fetchWorkItems(): Promise<WorkItem[]> {
  const { data, error } = await supabase
    .from('work_items')
    .select(WORK_COLS)
    .is('deleted_at', null)
    .order('sort', { ascending: true })
    .order('updated_at', { ascending: false })
  wrap(error, 'work_items')
  return ((data ?? []) as WorkRow[]).map(toItem)
}

export interface NewWorkItem {
  list: WorkList
  status?: WorkStatus
  title: string
  url?: string | null
  origin?: WorkOrigin
  btsSystem?: 'redmine' | 'jira' | null
  btsIssueId?: string | null
  btsTracker?: string | null
  btsVersion?: string | null
}

export async function addWorkItem(input: NewWorkItem): Promise<WorkItem> {
  const { data, error } = await supabase
    .from('work_items')
    .insert({
      list: input.list,
      status: input.status ?? 'wait',
      title: input.title,
      url: input.url ?? null,
      sort: Date.now(),
      origin: input.origin ?? 'manual',
      bts_system: input.btsSystem ?? null,
      bts_issue_id: input.btsIssueId ?? null,
      bts_tracker: input.btsTracker ?? null,
      bts_version: input.btsVersion ?? null,
    })
    .select(WORK_COLS)
    .single()
  wrap(error, 'work_items')
  return toItem(data as WorkRow)
}

export async function updateWorkItem(
  id: string,
  patch: Partial<Pick<WorkItem, 'list' | 'status' | 'title' | 'url' | 'note' | 'done' | 'sort'>>,
): Promise<void> {
  const { error } = await supabase.from('work_items').update(patch).eq('id', id)
  wrap(error, 'work_items')
}

/** 삭제 = 휴지통으로 이동 (soft delete). */
export async function trashWorkItem(id: string): Promise<void> {
  const { error } = await supabase.from('work_items').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  wrap(error, 'work_items')
}

export async function restoreWorkItem(id: string): Promise<void> {
  const { error } = await supabase.from('work_items').update({ deleted_at: null }).eq('id', id)
  // 같은 BTS 이슈가 이미 목록에 살아있으면 유니크 제약에 걸린다 → 사람이 읽을 수 있는 메시지로
  if (error && error.code === '23505') {
    throw new Error('같은 BTS 이슈가 이미 목록에 있어 복원할 수 없습니다. 기존 항목을 지운 뒤 다시 시도하세요.')
  }
  wrap(error, 'work_items')
}

export async function purgeWorkItem(id: string): Promise<void> {
  const { error } = await supabase.from('work_items').delete().eq('id', id)
  wrap(error, 'work_items')
}

// ── 목록 순서 저장 ──────────────────────────────────────────
// 순서 계산은 ./reorder 의 computeReorder (순수 함수) 가 맡는다.

export async function saveWorkOrder(changes: { id: string; sort: number }[]): Promise<void> {
  await Promise.all(changes.map((c) => updateWorkItem(c.id, { sort: c.sort })))
}

export async function saveRoutineOrder(changes: { id: string; sort: number }[]): Promise<void> {
  await Promise.all(changes.map((c) => updateRoutine(c.id, { sort: c.sort })))
}

export async function fetchTrashedWorkItems(): Promise<WorkItem[]> {
  const { data, error } = await supabase
    .from('work_items')
    .select(WORK_COLS)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  wrap(error, 'work_items')
  return ((data ?? []) as WorkRow[]).map(toItem)
}

// ── 루틴 ────────────────────────────────────────────────────

export async function fetchRoutines(): Promise<Routine[]> {
  const { data, error } = await supabase
    .from('routines')
    .select(ROUTINE_COLS)
    .is('deleted_at', null)
    .order('sort', { ascending: true })
  wrap(error, 'routines')
  return ((data ?? []) as RoutineRow[]).map(toRoutine)
}

export async function addRoutine(title: string): Promise<Routine> {
  const { data, error } = await supabase
    .from('routines')
    .insert({ title, sort: Date.now() })
    .select(ROUTINE_COLS)
    .single()
  wrap(error, 'routines')
  return toRoutine(data as RoutineRow)
}

export async function updateRoutine(id: string, patch: Partial<Pick<Routine, 'title' | 'sort'>>): Promise<void> {
  const { error } = await supabase.from('routines').update(patch).eq('id', id)
  wrap(error, 'routines')
}

/** 체크/해제 — 체크하면 오늘 날짜를 남기고, 해제하면 지운다. 날짜가 바뀌면 자동으로 풀린다. */
export async function setRoutineDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase
    .from('routines')
    .update({ last_done_on: done ? todayStr() : null })
    .eq('id', id)
  wrap(error, 'routines')
}

export async function trashRoutine(id: string): Promise<void> {
  const { error } = await supabase.from('routines').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  wrap(error, 'routines')
}

export async function restoreRoutine(id: string): Promise<void> {
  const { error } = await supabase.from('routines').update({ deleted_at: null }).eq('id', id)
  wrap(error, 'routines')
}

export async function purgeRoutine(id: string): Promise<void> {
  const { error } = await supabase.from('routines').delete().eq('id', id)
  wrap(error, 'routines')
}

export async function fetchTrashedRoutines(): Promise<Routine[]> {
  const { data, error } = await supabase
    .from('routines')
    .select(ROUTINE_COLS)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  wrap(error, 'routines')
  return ((data ?? []) as RoutineRow[]).map(toRoutine)
}

/** 루틴이 오늘 완료되었는지. */
export function isRoutineDone(r: Routine, today = todayStr()): boolean {
  return r.lastDoneOn === today
}
