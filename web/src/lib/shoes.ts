// 러닝화 — Garmin 장비 정보. sync Edge Function 이 채워 넣고 여기서는 읽기만 한다.
//
// intervals.icu 는 Garmin gear 를 못 가져오므로(FIT 파일만 받는다) Garmin 을 직접 본다.
// 다만 조회를 서버(Edge Function)에서 하기 때문에 **모바일에서도 그대로 보인다.**

import { supabase } from './supabase'
import type { Activity } from './exercise'

export interface Shoe {
  uuid: string
  /** 사용자가 붙인 별명 (없을 수 있음) */
  name: string | null
  /** 제품명 */
  model: string | null
  status: string | null
  dateBegin: string | null
  /** Garmin 기준 누적 거리 — MeOS 에 없는 활동도 포함된다 */
  totalDistanceM: number
  totalActivities: number
  /** 교체 목표 거리 (Garmin 설정). 없으면 null */
  maxMeters: number | null
  /** Garmin 에 올려둔 사진이 있으면 파일명 (대개 없다) */
  imageName: string | null
}

interface ShoeRow {
  uuid: string
  name: string | null
  model: string | null
  status: string | null
  date_begin: string | null
  total_distance_m: number | null
  total_activities: number | null
  raw: { maximumMeters?: number | null; imageNameLarge?: string | null } | null
}

function toShoe(r: ShoeRow): Shoe {
  return {
    uuid: r.uuid,
    name: r.name,
    model: r.model,
    status: r.status,
    dateBegin: r.date_begin,
    totalDistanceM: r.total_distance_m ?? 0,
    totalActivities: r.total_activities ?? 0,
    maxMeters: r.raw?.maximumMeters ?? null,
    imageName: r.raw?.imageNameLarge ?? null,
  }
}

/** 누적 거리 많은 순. 은퇴한 신발은 뒤로. */
export async function fetchShoes(): Promise<Shoe[]> {
  const { data, error } = await supabase
    .from('shoes')
    .select('uuid, name, model, status, date_begin, total_distance_m, total_activities, raw')
  // 마이그레이션 전이면 테이블이 없다 — 화면이 깨지지 않게 빈 목록으로
  if (error) return []
  return ((data ?? []) as ShoeRow[])
    .map(toShoe)
    .sort((a, b) => {
      const ar = /retired/i.test(a.status ?? '') ? 1 : 0
      const br = /retired/i.test(b.status ?? '') ? 1 : 0
      return ar - br || b.totalDistanceM - a.totalDistanceM
    })
}

/**
 * 이 신발로 뛴 활동 (MeOS 에 있는 것만).
 * Garmin 이 준 활동 id 를 activities.garmin_id 로 맞춘다 — 날짜·거리 추정이 아니라 정확히 일치한다.
 * Garmin 쪽 이력이 MeOS 동기화 범위보다 길 수 있어, 여기 개수는 신발의 총 횟수보다 적을 수 있다.
 */
export async function fetchShoeActivities(shoeUuid: string): Promise<Activity[]> {
  const { data: links, error } = await supabase
    .from('shoe_activities')
    .select('garmin_activity_id')
    .eq('shoe_uuid', shoeUuid)
  if (error || !links?.length) return []

  const ids = links.map((l) => l.garmin_activity_id as string)
  const out: Activity[] = []
  // in() 에 수백 개를 한 번에 넣으면 URL 이 길어져 실패한다 — 나눠서 조회한다
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from('activities')
      .select(
        'id, external_id, type, name, start_date_local, distance_m, moving_time_s, average_speed, average_hr, max_hr, calories, training_load, device_name, hr_zone_times, session_kind',
      )
      .in('garmin_id', ids.slice(i, i + 200))
      .order('start_date_local', { ascending: false })
    if (data) out.push(...(data as Activity[]))
  }
  return out.sort((a, b) => (b.start_date_local ?? '').localeCompare(a.start_date_local ?? ''))
}

/** 표시용 이름 — 별명이 있으면 별명, 없으면 제품명. */
export function shoeLabel(s: Shoe): string {
  return s.name || s.model || '이름 없는 장비'
}

/** Garmin 에서 비활성(은퇴) 처리한 장비인지. */
export function isRetired(s: Shoe): boolean {
  return /retired/i.test(s.status ?? '')
}
