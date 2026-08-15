import type { MeosAccount } from "./client.js";

// 계정 해석. 1인용 앱이라 계정은 하나뿐이고, 필요한 건 주소와 토큰 둘이다.

export const CHANNEL_ID = "meos";
export const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_POLL_MS = 3000;

type ConfigLike = { channels?: Record<string, unknown> };

function section(cfg: unknown): Record<string, unknown> {
  const channels = (cfg as ConfigLike)?.channels;
  const s = channels?.[CHANNEL_ID];
  return (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
}

export function resolveMeosAccount(cfg: unknown, accountId?: string | null): MeosAccount {
  const s = section(cfg);
  const baseUrl = String(s.baseUrl ?? "").trim();
  const token = String(s.token ?? "").trim();
  const raw = Number(s.pollIntervalMs);
  // 너무 짧으면 Edge Function 호출만 늘고, 너무 길면 답이 늦게 뜬다
  const pollIntervalMs = Number.isFinite(raw) ? Math.min(60_000, Math.max(1000, raw)) : DEFAULT_POLL_MS;
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    baseUrl,
    token,
    pollIntervalMs,
    configured: Boolean(baseUrl && token),
  };
}

export function listMeosAccountIds(): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function inspectMeosAccount(cfg: unknown) {
  const s = section(cfg);
  const ok = Boolean(String(s.baseUrl ?? "").trim() && String(s.token ?? "").trim());
  return {
    enabled: ok,
    configured: ok,
    tokenStatus: String(s.token ?? "").trim() ? ("available" as const) : ("missing" as const),
  };
}
