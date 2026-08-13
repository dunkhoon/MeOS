// Garmin Connect 최소 클라이언트 (러닝화 정보용).
//
// Garmin 은 개인용 공식 API 가 없고, 2026-03 에 인증까지 바꿔 기존 라이브러리(garth)가 막혔다.
// 그래서 **로그인만** PC 에서 python-garminconnect 로 1회 하고(scripts/garmin-login.py),
// 여기서는 저장된 토큰으로 조회만 한다 — 그래야 서버에서 돌고 모바일에서도 보인다.
//
// ⚠️ refresh token 은 **갱신할 때마다 값이 바뀐다(회전)**. 갱신 직후 반드시 저장해야 하며,
//    저장에 실패하면 다음 갱신이 막혀 재로그인해야 한다. 그래서 저장이 성공한 뒤에야 조회를 진행한다.
//    유효기간은 30일 — 그 안에 한 번이라도 동기화가 돌면 계속 살아 있다.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

const API = 'https://connectapi.garmin.com'
const TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token'

/** python-garminconnect 가 쓰는 네이티브 앱 헤더. 빼면 일부 엔드포인트가 거절한다. */
const BASE_HEADERS: Record<string, string> = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-Client-Platform': 'Android',
  'X-Garmin-Paired-App-Version': '10861',
  'X-App-Ver': '10861',
  'X-Lang': 'en',
  'X-GCExperience': 'GC5',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json',
}

export interface GarminTokens {
  di_token: string
  di_refresh_token: string
  di_client_id: string
}

export interface GarminGear {
  uuid: string
  displayName: string | null
  customMakeModel: string | null
  gearTypeName: string | null
  gearStatusName: string | null
  dateBegin: string | null
  [k: string]: unknown
}

export interface GarminGearStats {
  totalDistance?: number
  totalActivities?: number
}

export interface GarminGearActivity {
  activityId: number | string
  activityName?: string
  startTimeLocal?: string
  distance?: number
}

export class GarminAuthError extends Error {}

export class GarminClient {
  private token: string
  private constructor(
    token: string,
    private readonly profileId: number | string,
  ) {
    this.token = token
  }

  /**
   * DB 의 토큰으로 클라이언트를 만든다. access token 이 만료가 가까우면 먼저 갱신하고 **저장**한다.
   * 토큰이 없으면 null (연동을 안 한 것 — 조용히 건너뛴다).
   */
  static async fromDb(db: SupabaseClient, userId: string): Promise<GarminClient | null> {
    const { data } = await db
      .from('integration_tokens')
      .select('tokens, expires_at')
      .eq('user_id', userId)
      .eq('provider', 'garmin')
      .maybeSingle()
    if (!data?.tokens) return null

    let tokens = data.tokens as GarminTokens
    const expiresAt = data.expires_at ? Date.parse(data.expires_at) : 0
    // 10분 여유를 두고 미리 갱신 (조회 도중 만료되면 중간에 깨진다)
    if (!expiresAt || expiresAt - Date.now() < 10 * 60 * 1000) {
      tokens = await refreshAndSave(db, userId, tokens)
    }

    const profileId = await getProfileId(tokens.di_token)
    return new GarminClient(tokens.di_token, profileId)
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(API + path, {
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${this.token}` },
    })
    if (res.status === 401 || res.status === 403) {
      throw new GarminAuthError(`Garmin 인증 거부 (${res.status}) — 재로그인이 필요할 수 있습니다.`)
    }
    if (!res.ok) throw new Error(`Garmin ${path} → HTTP ${res.status}`)
    return (await res.json()) as T
  }

  /** 등록된 장비 전체 (신발·자전거 등) */
  gear(): Promise<GarminGear[]> {
    return this.get<GarminGear[]>(`/gear-service/gear/filterGear?userProfilePk=${this.profileId}`)
  }

  /** 누적 거리·횟수. Garmin 기준이라 MeOS 에 없는 활동도 포함된다. */
  gearStats(uuid: string): Promise<GarminGearStats> {
    return this.get<GarminGearStats>(`/gear-service/gear/stats/${uuid}`)
  }

  /** 이 장비로 한 활동 목록 (신발↔활동 매칭의 원천) */
  gearActivities(uuid: string, limit = 1000): Promise<GarminGearActivity[]> {
    return this.get<GarminGearActivity[]>(`/activitylist-service/activities/${uuid}/gear?start=0&limit=${limit}`)
  }
}

async function getProfileId(token: string): Promise<number | string> {
  const res = await fetch(`${API}/userprofile-service/socialProfile`, {
    headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new GarminAuthError(`프로필 조회 실패 (${res.status})`)
  const p = (await res.json()) as { profileId?: number | string }
  if (!p?.profileId) throw new GarminAuthError('profileId 를 못 찾았습니다.')
  return p.profileId
}

/** 갱신 → **먼저 저장** → 반환. 저장이 실패하면 새 토큰을 잃으므로 진행하지 않는다. */
async function refreshAndSave(db: SupabaseClient, userId: string, tokens: GarminTokens): Promise<GarminTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: tokens.di_client_id,
    refresh_token: tokens.di_refresh_token,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      Authorization: 'Basic ' + btoa(`${tokens.di_client_id}:`),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200)
    throw new GarminAuthError(
      `Garmin 토큰 갱신 실패 (${res.status}). 30일 넘게 동기화가 없었다면 재로그인이 필요합니다: ${text}`,
    )
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
  const next: GarminTokens = {
    di_token: j.access_token,
    // 회전된 값이 오면 그것을 쓴다. 안 오면 기존 것을 유지.
    di_refresh_token: j.refresh_token ?? tokens.di_refresh_token,
    di_client_id: tokens.di_client_id,
  }
  const expiresAt = new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString()
  const { error } = await db
    .from('integration_tokens')
    .update({ tokens: next, expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', 'garmin')
  if (error) throw new Error(`갱신한 Garmin 토큰을 저장하지 못했습니다: ${error.message}`)
  return next
}
