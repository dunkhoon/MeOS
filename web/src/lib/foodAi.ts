import { supabase } from './supabase'
import { askQuestion, fetchMessages, type ChatMessage } from './assistant'
import { imageExt, isImageType } from './clipboardImage'
import { NUTRIENTS, type FoodInput } from './food'

// 영양정보표 사진이나 글 설명 → 음식 정보.
//
// 읽는 건 집 PC 의 OpenClaw 다 (`meos` 채널). 앱은 질문을 넣고 답을 기다린다.
// 사진은 비공개 버킷에 올리고 **서명 URL** 만 넘긴다 — 에이전트에는 사람 세션이 없어서
// RLS 로는 못 읽는다.
//
// ⚠️ 답은 사람이 쓰는 글이 아니라 **JSON** 이어야 한다. 그래서 프롬프트에 형식을 박고,
//    받는 쪽에서도 관대하게 판다(코드펜스·앞뒤 설명이 붙어 와도 건진다).

const BUCKET = 'food-photos'
const SIGNED_URL_TTL = 60 * 30 // 30분이면 에이전트가 읽고도 남는다

/**
 * 사진을 비공개 버킷에 올리고 서명 URL 을 돌려준다.
 *
 * File 이 아니라 **Blob** 을 받는다 — 클립보드에서 온 이미지는 파일명이 없다.
 * 그래서 확장자·contentType 은 이름이 아니라 **MIME** 에서 뽑는다.
 */
export async function uploadLabelPhoto(file: Blob): Promise<{ path: string; signedUrl: string }> {
  const { data: s } = await supabase.auth.getSession()
  const uid = s.session?.user.id
  if (!uid) throw new Error('로그인이 필요합니다')

  const type = (file.type || '').toLowerCase()
  // MIME 을 먼저 믿는다. 파일명은 확장자가 **실제로 있을 때만** 본다 —
  // `split('.').pop()` 은 점이 없는 이름("photo")을 그대로 확장자로 내놓는다.
  const named = file instanceof File ? file.name : ''
  const fromName = named.includes('.') ? (named.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  const ext = isImageType(type) ? imageExt(type) : fromName || 'png'
  // 경로 첫 칸이 user_id 여야 정책을 통과한다 (0014 참고)
  const path = `${uid}/${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: type || 'image/png' })
  if (error) throw error

  const { data, error: e2 } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL)
  if (e2) throw e2
  return { path, signedUrl: data.signedUrl }
}

/** 에이전트가 돌려줘야 하는 형식. 프롬프트와 파서가 같은 목록을 본다. */
const SHAPE = `{
  "name": "음식 이름 (필수)",
  "brand": "브랜드 (없으면 null)",
  "base_amount": 기준 수량 숫자,
  "base_unit": "g | ml | 스쿱 | 인분 | 개 | 컵 | 조각",
  "base_grams": 기준 1회분의 그램수 (모르면 null),
  "kcal": 숫자, "carb_g": 숫자, "sugar_g": 숫자, "protein_g": 숫자,
  "fat_g": 숫자, "sat_fat_g": 숫자, "trans_fat_g": 숫자,
  "chol_mg": 숫자, "fiber_g": 숫자, "sodium_mg": 숫자, "potassium_mg": 숫자
}`

const RULES = [
  '영양소는 **기준 1회분(base_amount + base_unit) 기준**으로 적어라. 100g 으로 환산하지 마라.',
  '표에 없는 항목은 0 이 아니라 **null** 로 둬라. 0 으로 적으면 합계가 조용히 틀어진다.',
  'kJ 만 있으면 kcal 로 바꿔 적어라 (1 kcal = 4.184 kJ).',
  '설명·인사·단위 문자열을 넣지 말고 **JSON 객체 하나만** 출력해라. 코드펜스도 붙이지 마라.',
]

export function photoPrompt(signedUrl: string): { question: string; context: unknown } {
  return {
    question:
      '이 영양정보표 사진을 읽고 아래 JSON 형식으로만 답해줘. 러닝·훈련 분석이 아니라 **영양정보표 판독**이다.\n' +
      `사진: ${signedUrl}\n\n` +
      `형식:\n${SHAPE}\n\n규칙:\n- ${RULES.join('\n- ')}`,
    context: { kind: 'food-parse', mode: 'photo', imageUrl: signedUrl },
  }
}

export function textPrompt(text: string): { question: string; context: unknown } {
  return {
    question:
      '먹은 음식 설명을 듣고 영양 정보를 추정해서 아래 JSON 형식으로만 답해줘. ' +
      '러닝·훈련 분석이 아니라 **음식 영양 추정**이다.\n' +
      `설명: ${text}\n\n` +
      `형식:\n${SHAPE}\n\n규칙:\n- ${RULES.join('\n- ')}\n` +
      '- 흔한 조리법·분량을 가정해서 추정하되, 가정한 분량을 base_amount/base_unit 에 반영해라.',
    context: { kind: 'food-parse', mode: 'text', text },
  }
}

/** 질문을 넣고 messageId 를 돌려준다. 답은 폴링으로 기다린다. */
export async function askFoodParse(p: { question: string; context: unknown }): Promise<{ threadId: string; messageId: string }> {
  return askQuestion({ threadId: null, content: p.question, context: p.context })
}

export interface ParseResult {
  ok: boolean
  food?: Partial<FoodInput>
  error?: string
  /** 에이전트가 실제로 뭐라고 했는지 — 파싱 실패 시 보여 준다 */
  raw?: string
}

/**
 * 답에서 JSON 을 건진다.
 *
 * 형식을 박아 놨어도 모델은 종종 코드펜스나 한 줄 설명을 덧붙인다.
 * 첫 `{` 부터 마지막 `}` 까지 잘라서 시도한다.
 */
export function parseFoodReply(content: string): ParseResult {
  const raw = content.trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'JSON 을 찾지 못했습니다.', raw }

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'JSON 형식이 아닙니다.', raw }
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name) return { ok: false, error: '음식 이름이 없습니다.', raw }

  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }

  const food: Partial<FoodInput> = {
    name,
    brand: typeof obj.brand === 'string' && obj.brand.trim() ? obj.brand.trim() : null,
    base_amount: num(obj.base_amount) ?? 100,
    base_unit: typeof obj.base_unit === 'string' && obj.base_unit.trim() ? obj.base_unit.trim() : 'g',
    base_grams: num(obj.base_grams),
    note: null,
  }
  for (const n of NUTRIENTS) food[n] = num(obj[n])
  return { ok: true, food, raw }
}

/** 그 질문에 달린 답을 찾는다. 없으면 아직 오는 중. */
export function findReply(messages: ChatMessage[], askedId: string): ChatMessage | null {
  const asked = messages.find((m) => m.id === askedId)
  if (!asked) return null
  const after = messages.filter((m) => m.role === 'assistant' && m.created_at >= asked.created_at)
  return after[0] ?? null
}

export async function pollReply(threadId: string, askedId: string): Promise<{ done: boolean; reply?: ChatMessage; failed?: string }> {
  const msgs = await fetchMessages(threadId)
  const asked = msgs.find((m) => m.id === askedId)
  if (asked?.status === 'error') return { done: true, failed: asked.error ?? '분석에 실패했습니다.' }
  const reply = findReply(msgs, askedId)
  return reply ? { done: true, reply } : { done: false }
}
