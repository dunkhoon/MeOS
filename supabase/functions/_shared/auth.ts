// Edge Function 공통 인증 도우미.
//
// **게이트웨이가 이미 JWT 를 검증했다** (config.toml 의 verify_jwt = true).
// 서명과 만료가 확인된 뒤에야 함수가 호출되므로, 여기서는 클레임만 읽으면 된다.
//
// 예전에는 `/auth/v1/user` 로 한 번 더 물어봤는데, 그건 "서명이 유효한가" 가 아니라
// "세션이 아직 살아 있는가" 를 확인하는 것이라 다른 기기에서 로그아웃하거나
// admin.signOut(global) 이 한 번 돌면 **멀쩡한 토큰인데도 401** 이 났다.
// 앱의 나머지(PostgREST)는 그 상황에서도 동작하니 증상이 특히 헷갈렸다.

export interface Claims {
  /** 사용자 id (service_role 키에는 없다) */
  sub?: string
  role?: string
  exp?: number
}

/** `Authorization: Bearer <token>` 에서 토큰만 꺼낸다. */
export function bearer(req: Request): string {
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

/** JWT 페이로드를 읽는다. 서명 검증은 하지 않는다 (게이트웨이 담당). */
export function jwtClaims(token: string): Claims | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as Claims
  } catch {
    return null
  }
}

export class Unauthorized extends Error {
  constructor() {
    super('UNAUTHORIZED')
  }
}

/**
 * 호출자를 판정한다.
 *   'service' — service_role 키 (CLI·cron)
 *   'user'    — 로그인한 사용자 (userId 포함)
 */
export function whoIs(req: Request): { via: 'service' | 'user'; userId: string | null } {
  const token = bearer(req)
  if (!token) throw new Unauthorized()
  const claims = jwtClaims(token)
  if (!claims) throw new Unauthorized()
  if (claims.role === 'service_role') return { via: 'service', userId: null }
  if (claims.sub) return { via: 'user', userId: claims.sub }
  throw new Unauthorized()
}
