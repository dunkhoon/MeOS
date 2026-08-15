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
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 함수가 죽으면 HTML 이 올 수 있다 — 원문을 잘라서 보여 줘야 원인이 보인다
    throw new Error(`meos: 응답을 읽을 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.ok === false) {
    throw new Error(`meos: ${String(parsed.error ?? `HTTP ${res.status}`)}`);
  }
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
