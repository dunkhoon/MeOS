import { supabase } from './supabase'

// 어시스턴트 대화.
//
// 앱은 질문을 넣기만 하고, 답이 달렸는지는 **폴링해서** 확인한다.
// Realtime 구독을 쓰면 publication 설정이 따로 필요한데, 답이 오기까지 보통 수십 초라
// 기다리는 동안만 2초로 훑는 편이 설정도 없고 어디서나 똑같이 동작한다.

export type ChatRole = 'user' | 'assistant'
export type ChatStatus = 'pending' | 'taken' | 'done' | 'error'

export interface ChatMessage {
  id: string
  thread_id: string
  role: ChatRole
  content: string
  status: ChatStatus
  error: string | null
  model: string | null
  created_at: string
}

export interface ChatThread {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

export async function fetchThreads(): Promise<ChatThread[]> {
  const { data, error } = await supabase
    .from('chat_threads')
    .select('id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as ChatThread[]
}

export async function createThread(title?: string): Promise<ChatThread> {
  const { data, error } = await supabase
    .from('chat_threads')
    .insert({ title: title?.slice(0, 120) ?? null })
    .select('id, title, created_at, updated_at')
    .single()
  if (error) throw error
  return data as ChatThread
}

export async function deleteThread(id: string): Promise<void> {
  const { error } = await supabase.from('chat_threads').delete().eq('id', id)
  if (error) throw error
}

export async function fetchMessages(threadId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, thread_id, role, content, status, error, model, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as ChatMessage[]
}

/**
 * 질문을 넣는다. 대화가 없으면 만들고, 제목은 첫 질문에서 딴다.
 * `context` 는 '물어보기' 버튼이 실어 보내는 화면 맥락이다.
 */
export async function askQuestion(params: {
  threadId?: string | null
  content: string
  context?: unknown
}): Promise<{ threadId: string; messageId: string }> {
  let threadId = params.threadId ?? null
  if (!threadId) {
    const t = await createThread(params.content.trim().slice(0, 60))
    threadId = t.id
  }
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      thread_id: threadId,
      role: 'user',
      content: params.content.trim(),
      status: 'pending',
      context: params.context ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  return { threadId, messageId: (data as { id: string }).id }
}

/** 아직 답을 기다리는 질문이 있나 — 있으면 화면이 계속 훑는다. */
export function isWaiting(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && (m.status === 'pending' || m.status === 'taken'))
}
