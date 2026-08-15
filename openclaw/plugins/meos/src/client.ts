// MeOS Edge Function `chat` 클라이언트.
//
// 이 플러그인이 바깥으로 나가는 유일한 통로다. 집 PC 로 들어오는 연결은 없다.

export type MeosAccount = {
  accountId: string | null;
  baseUrl: string;
  token: string;
  pollIntervalMs: number;
  configured: boolean;
};

export type MeosPendingMessage = {
  id: string;
  thread_id: string;
  content: string;
  context: unknown;
  created_at: string;
  history: { role: "user" | "assistant"; content: string }[];
};

async function call(
  account: MeosAccount,
  init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
): Promise<Record<string, unknown>> {
  const url = new URL(account.baseUrl);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: init.method,
    headers: {
      "x-meos-token": account.token,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* JSON 이 아니면 아래에서 원문을 그대로 보여 준다 */
  }

  if (!res.ok || parsed?.ok === false) {
    // ⚠️ 우리 함수의 `error` 만 읽으면 안 된다. 503 은 대개 **우리 코드가 아니라 Supabase 가**
    //    내는 것이고 그 몸통은 `{code, message}` 라, error 만 보면 이유가 통째로 사라진다
    //    (실제로 "meos: HTTP 503" 만 남아 원인을 못 찾았다). 원문을 붙여 보낸다.
    const detail =
      (typeof parsed?.error === "string" && parsed.error) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      "";
    const code = typeof parsed?.code === "string" ? ` code=${parsed.code}` : "";
    throw new Error(
      `meos: HTTP ${res.status}${code}${detail ? ` — ${detail}` : ""} @ ${url.pathname}${url.search}` +
        (detail ? "" : ` body=${text.slice(0, 300)}`),
    );
  }
  if (!parsed) throw new Error(`meos: 응답이 JSON 이 아닙니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return parsed;
}

/** 아직 안 가져간 질문을 집어온다. 함수가 집어가면서 taken 으로 표시하므로 두 번 안 나온다. */
export async function pollMessages(account: MeosAccount, max = 5): Promise<MeosPendingMessage[]> {
  const r = await call(account, { method: "GET", query: { poll: "1", max: String(max) } });
  return (r.messages ?? []) as MeosPendingMessage[];
}

export async function postAnswer(
  account: MeosAccount,
  params: { messageId: string; content: string; model?: string },
): Promise<void> {
  await call(account, { method: "POST", body: params });
}

export async function postFailure(
  account: MeosAccount,
  params: { messageId: string; error: string },
): Promise<void> {
  await call(account, { method: "POST", body: params });
}

export type MeosDataKind = "overview" | "activities" | "strength" | "body";

export async function readData(account: MeosAccount, kind: MeosDataKind): Promise<unknown> {
  const r = await call(account, { method: "GET", query: { data: kind } });
  delete r.ok;
  return r;
}
