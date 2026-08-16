import dayjs from 'dayjs'
import { supabase } from './supabase'

// 음식 기록 — 내 음식 목록과 끼니별 일지.
//
// ⚠️ 단위 환산은 `scale()` 한 곳에서만 한다. 음식은 "기준 1회분"(base_amount + base_unit)의
//    영양소를 들고 있고, 일지는 거기에 배율만 곱한 값을 **박아서** 저장한다.
//    나중에 음식 성분을 고쳐도 그날 먹은 기록은 그대로여야 하기 때문이다.

/** 합계·표시에 쓰는 영양소 필드. 한 곳에 모아 두고 전부 이 목록을 돈다. */
export const NUTRIENTS = [
  'kcal',
  'carb_g',
  'sugar_g',
  'protein_g',
  'fat_g',
  'sat_fat_g',
  'trans_fat_g',
  'chol_mg',
  'fiber_g',
  'sodium_mg',
  'potassium_mg',
] as const
export type Nutrient = (typeof NUTRIENTS)[number]

export type Nutrition = { [K in Nutrient]?: number | null }

export const NUTRIENT_LABEL: Record<Nutrient, string> = {
  kcal: '칼로리',
  carb_g: '탄수화물',
  sugar_g: '당',
  protein_g: '단백질',
  fat_g: '지방',
  sat_fat_g: '포화지방',
  trans_fat_g: '트랜스지방',
  chol_mg: '콜레스테롤',
  fiber_g: '식이섬유',
  sodium_mg: '나트륨',
  potassium_mg: '칼륨',
}

export const NUTRIENT_UNIT: Record<Nutrient, string> = {
  kcal: 'kcal',
  carb_g: 'g',
  sugar_g: 'g',
  protein_g: 'g',
  fat_g: 'g',
  sat_fat_g: 'g',
  trans_fat_g: 'g',
  chol_mg: 'mg',
  fiber_g: 'g',
  sodium_mg: 'mg',
  potassium_mg: 'mg',
}

export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack'

export const MEALS: { key: Meal; label: string; color: string }[] = [
  { key: 'breakfast', label: '아침', color: 'var(--h-yellow)' },
  { key: 'lunch', label: '점심', color: 'var(--h-blue)' },
  { key: 'dinner', label: '저녁', color: 'var(--h-orange)' },
  { key: 'snack', label: '간식', color: 'var(--h-purple)' },
]
export const MEAL_LABEL = Object.fromEntries(MEALS.map((m) => [m.key, m.label])) as Record<Meal, string>

/** 흔한 단위 — 직접 입력도 되지만 고르는 게 빠르다 */
export const COMMON_UNITS = ['g', 'ml', '스쿱', '인분', '개', '컵', '조각']

export interface Food extends Nutrition {
  id: string
  name: string
  brand: string | null
  base_amount: number
  base_unit: string
  base_grams: number | null
  source: string
  note: string | null
  archived: boolean
  updated_at: string
}

export interface FoodEntry extends Nutrition {
  id: string
  day: string
  meal: Meal
  food_id: string | null
  name: string
  brand: string | null
  amount: number
  unit: string
  grams: number | null
}

const FOOD_COLS =
  'id, name, brand, base_amount, base_unit, base_grams, source, note, archived, updated_at, ' + NUTRIENTS.join(', ')
const ENTRY_COLS = 'id, day, meal, food_id, name, brand, amount, unit, grams, ' + NUTRIENTS.join(', ')

// ── 조회 / 저장 ──────────────────────────────────────────
export async function fetchFoods(): Promise<Food[]> {
  const { data, error } = await supabase.from('foods').select(FOOD_COLS).order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Food[]
}

export type FoodInput = Omit<Food, 'id' | 'archived' | 'updated_at'>

export async function saveFood(input: FoodInput, id?: string): Promise<Food> {
  const q = id
    ? supabase.from('foods').update(input).eq('id', id).select(FOOD_COLS).single()
    : supabase.from('foods').insert(input).select(FOOD_COLS).single()
  const { data, error } = await q
  if (error) throw error
  return data as unknown as Food
}

export async function archiveFood(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.from('foods').update({ archived }).eq('id', id)
  if (error) throw error
}

export async function fetchEntries(fromDay: string, toDay: string): Promise<FoodEntry[]> {
  const { data, error } = await supabase
    .from('food_entries')
    .select(ENTRY_COLS)
    .gte('day', fromDay)
    .lte('day', toDay)
    .order('day', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as FoodEntry[]
}

export async function addEntry(e: Omit<FoodEntry, 'id'>): Promise<void> {
  const { error } = await supabase.from('food_entries').insert(e)
  if (error) throw error
}

export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase.from('food_entries').delete().eq('id', id)
  if (error) throw error
}

// ── 환산 ─────────────────────────────────────────────────
/**
 * 이 음식을 `amount`만큼 `unit`으로 먹었을 때의 배율.
 *
 * - 기준 단위와 같으면  amount / base_amount
 * - g 로 적었고 그램 환산을 알면  amount / base_grams
 * - 그 외에는 알 수 없다(null) — 조용히 1 로 두면 합계가 틀린 채로 쌓인다.
 */
export function scale(food: Pick<Food, 'base_amount' | 'base_unit' | 'base_grams'>, amount: number, unit: string): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null
  if (unit === food.base_unit && food.base_amount > 0) return amount / food.base_amount
  if ((unit === 'g' || unit === 'ml') && food.base_grams && food.base_grams > 0) return amount / food.base_grams
  return null
}

/** 이 음식으로 적을 수 있는 단위들 */
export function unitsFor(food: Pick<Food, 'base_unit' | 'base_grams'>): string[] {
  const out = [food.base_unit]
  if (food.base_grams && food.base_unit !== 'g') out.push('g')
  return out
}

/** 기준 1회분 영양소 × 배율 */
export function scaled(food: Nutrition, k: number): Nutrition {
  const out: Nutrition = {}
  for (const n of NUTRIENTS) {
    const v = food[n]
    out[n] = v == null ? null : Math.round(v * k * 100) / 100
  }
  return out
}

/** 일지 항목 하나를 만든다 (영양소를 박아서) */
export function buildEntry(params: {
  food: Food
  day: string
  meal: Meal
  amount: number
  unit: string
}): Omit<FoodEntry, 'id'> | null {
  const k = scale(params.food, params.amount, params.unit)
  if (k == null) return null
  const grams =
    params.unit === 'g' || params.unit === 'ml'
      ? params.amount
      : params.food.base_grams
        ? Math.round(params.food.base_grams * k * 10) / 10
        : null
  return {
    day: params.day,
    meal: params.meal,
    food_id: params.food.id,
    name: params.food.name,
    brand: params.food.brand,
    amount: params.amount,
    unit: params.unit,
    grams,
    ...scaled(params.food, k),
  }
}

// ── 합계 ─────────────────────────────────────────────────
export function sumNutrition(rows: Nutrition[]): Nutrition {
  const out: Nutrition = {}
  for (const n of NUTRIENTS) {
    let any = false
    let t = 0
    for (const r of rows) {
      const v = r[n]
      if (v != null) {
        any = true
        t += v
      }
    }
    // 아무도 값을 안 가진 항목은 0 이 아니라 "모름" 이다
    out[n] = any ? Math.round(t * 10) / 10 : null
  }
  return out
}

export interface DayTotals {
  day: string
  total: Nutrition
  byMeal: Record<Meal, Nutrition>
  entries: FoodEntry[]
}

export function totalsForDay(entries: FoodEntry[], day: string): DayTotals {
  const rows = entries.filter((e) => e.day === day)
  const byMeal = Object.fromEntries(
    MEALS.map((m) => [m.key, sumNutrition(rows.filter((e) => e.meal === m.key))]),
  ) as Record<Meal, Nutrition>
  return { day, total: sumNutrition(rows), byMeal, entries: rows }
}

/** 탄·단·지 **칼로리** 비율 (그램 비율이 아니다 — 지방은 g 당 9kcal 이라 그램으로 재면 왜곡된다) */
export function macroSplit(n: Nutrition): { carb: number; protein: number; fat: number } | null {
  const c = (n.carb_g ?? 0) * 4
  const p = (n.protein_g ?? 0) * 4
  const f = (n.fat_g ?? 0) * 9
  const t = c + p + f
  if (t <= 0) return null
  return { carb: Math.round((c / t) * 100), protein: Math.round((p / t) * 100), fat: Math.round((f / t) * 100) }
}

/** 날짜별 칼로리 — 캘린더가 쓴다 */
export function kcalByDay(entries: FoodEntry[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const e of entries) {
    if (e.kcal == null) continue
    m.set(e.day, (m.get(e.day) ?? 0) + e.kcal)
  }
  for (const [k, v] of m) m.set(k, Math.round(v))
  return m
}

export const today = () => dayjs().format('YYYY-MM-DD')

/**
 * 코칭 엔진이 보는 일별 합계.
 *
 * `buildPlan` 은 `{day, kcal, protein_g}` 만 있으면 되므로 그 모양으로 줄여서 넘긴다.
 * (0011 의 `nutrition_logs` 를 대체한다 — 이제 합계는 실제 먹은 것에서 나온다)
 */
export function dailyLogs(entries: FoodEntry[]): { day: string; kcal: number | null; protein_g: number | null; note: null }[] {
  const days = [...new Set(entries.map((e) => e.day))].sort()
  return days.map((day) => {
    const t = sumNutrition(entries.filter((e) => e.day === day))
    return { day, kcal: t.kcal ?? null, protein_g: t.protein_g ?? null, note: null }
  })
}
