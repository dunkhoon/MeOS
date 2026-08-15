// InBody 앱에서 내보낸 CSV 를 읽는다.
//
// 실제 파일(reference/InBody-20260814.csv)로 확인한 것들:
//  - UTF-8 **BOM** 으로 시작한다. 안 벗기면 첫 열 이름이 '﻿날짜' 가 돼서 안 잡힌다.
//  - 안 잰 항목은 빈칸이 아니라 **'-'** 다. 270S 는 45열 중 27열이 '-' 였다.
//  - 날짜는 `20260610062851` (YYYYMMDDHHmmss) — 구분자가 없다.
//  - 열 이름에 단위가 붙어 있다: `체중(kg)`, `BMI(kg/m²)`, `내장지방레벨(Level)`.
//  - `세포외수분비` 는 부위별로 5개 + 전신 1개, 총 6번 나온다. 열 이름 전체로 맞춰야 한다.
//
// 모르는 열은 버리지 않고 raw 에 담아 둔다 — 기기를 바꾸면 열이 늘어난다.

/** 열 이름 → DB 컬럼. 키는 단위를 벗긴 이름이다. */
const COLUMN_MAP: Record<string, string> = {
  측정장비: 'device',
  체중: 'weight_kg',
  골격근량: 'skeletal_muscle_kg',
  근육량: 'muscle_kg',
  체지방량: 'body_fat_kg',
  BMI: 'bmi',
  체지방률: 'body_fat_pct',
  기초대사량: 'bmr_kcal',
  인바디나이: 'inbody_age',
  인바디점수: 'inbody_score',
  '오른팔 근육량': 'arm_r_muscle_kg',
  '왼팔 근육량': 'arm_l_muscle_kg',
  '몸통 근육량': 'trunk_muscle_kg',
  '오른다리 근육량': 'leg_r_muscle_kg',
  '왼다리 근육량': 'leg_l_muscle_kg',
  '오른팔 체지방': 'arm_r_fat_kg',
  '왼팔 체지방': 'arm_l_fat_kg',
  '몸통 체지방': 'trunk_fat_kg',
  '오른다리 체지방': 'leg_r_fat_kg',
  '왼다리 체지방': 'leg_l_fat_kg',
  복부지방률: 'whr',
  허리둘레: 'waist_cm',
  내장지방단면적: 'visceral_fat_area',
  내장지방레벨: 'visceral_fat_level',
  체수분: 'body_water_l',
  세포내수분: 'icw_l',
  세포외수분: 'ecw_l',
  세포외수분비: 'ecw_ratio',
  단백질: 'protein_kg',
  무기질: 'mineral_kg',
  골무기질량: 'bone_mineral_kg',
  체세포량: 'bcm_kg',
  다리근육량: 'leg_muscle_kg',
  다리근육레벨: 'leg_muscle_level',
  SMI: 'smi',
  전신위상각: 'phase_angle',
}

/** 숫자가 아니라 문자열로 남겨야 하는 컬럼 */
const TEXT_COLUMNS = new Set(['device'])

/** DB 가 integer 인 컬럼. 기기가 '1675.4' 처럼 주면 insert 가 통째로 실패한다. */
const INT_COLUMNS = new Set(['bmr_kcal', 'inbody_age'])

export interface ParsedMeasurement {
  measured_at: string
  device: string | null
  raw: Record<string, string>
  [column: string]: unknown
}

export interface ParseResult {
  rows: ParsedMeasurement[]
  /** 지도에 없어 raw 로만 들어간 열 — 파서를 손볼 거리가 생기면 알 수 있게 */
  unmapped: string[]
  skipped: number
}

/** `체중(kg)` → `체중`. 단위 괄호와 앞뒤 공백만 벗긴다. */
function normalizeHeader(h: string): string {
  return h
    .replace(/^﻿/, '')
    .replace(/\([^)]*\)$/, '')
    .trim()
}

/** 따옴표로 감싼 필드와 그 안의 쉼표를 지켜 가며 한 줄을 쪼갠다 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        // "" 는 따옴표 한 글자
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/**
 * 인바디 날짜를 ISO 로. `20260610062851` 과 `2026-06-10 06:28:51` 둘 다 받는다.
 * 측정 시각은 기기가 있던 곳의 벽시계라 로컬 시간으로 해석한다.
 */
export function parseInBodyDate(v: string): string | null {
  const s = v.trim()
  const digits = s.replace(/\D/g, '')
  if (digits.length < 8) return null
  const y = Number(digits.slice(0, 4))
  const mo = Number(digits.slice(4, 6))
  const d = Number(digits.slice(6, 8))
  const h = Number(digits.slice(8, 10) || '0')
  const mi = Number(digits.slice(10, 12) || '0')
  const se = Number(digits.slice(12, 14) || '0')
  if (!y || !mo || !d || mo > 12 || d > 31) return null
  const dt = new Date(y, mo - 1, d, h, mi, se)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString()
}

function numOrNull(v: string): number | null {
  const s = v.trim()
  // '-' 는 "안 쟀다" 는 뜻이다. 0 으로 넣으면 그래프가 바닥으로 떨어진다.
  if (!s || s === '-') return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export function parseInBodyCsv(text: string): ParseResult {
  const clean = text.replace(/^﻿/, '').trim()
  if (!clean) return { rows: [], unmapped: [], skipped: 0 }

  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return { rows: [], unmapped: [], skipped: 0 }

  const headers = splitCsvLine(lines[0]).map(normalizeHeader)
  const unmapped = new Set<string>()
  const rows: ParsedMeasurement[] = []
  let skipped = 0

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line)
    const raw: Record<string, string> = {}
    const row: Record<string, unknown> = {}
    let measuredAt: string | null = null

    headers.forEach((h, i) => {
      const v = cells[i] ?? ''
      if (v && v !== '-') raw[h] = v

      if (h === '날짜' || h === '측정일시' || h === '측정일') {
        measuredAt = parseInBodyDate(v)
        return
      }
      const col = COLUMN_MAP[h]
      if (!col) {
        if (h) unmapped.add(h)
        return
      }
      if (TEXT_COLUMNS.has(col)) {
        row[col] = v && v !== '-' ? v : null
      } else {
        const n = numOrNull(v)
        row[col] = n != null && INT_COLUMNS.has(col) ? Math.round(n) : n
      }
    })

    // 날짜가 없으면 어느 측정인지 알 수 없다 — 저장할 수 없으니 센다
    if (!measuredAt) {
      skipped += 1
      continue
    }
    rows.push({ ...row, measured_at: measuredAt, device: (row.device as string) ?? null, raw } as ParsedMeasurement)
  }

  // 같은 파일 안에 같은 시각이 두 번 오면 뒤엣것만 남긴다 (upsert 가 한 번에 못 넣는다)
  const uniq = new Map<string, ParsedMeasurement>()
  for (const r of rows) uniq.set(r.measured_at, r)

  return {
    rows: [...uniq.values()].sort((a, b) => a.measured_at.localeCompare(b.measured_at)),
    unmapped: [...unmapped],
    skipped,
  }
}
