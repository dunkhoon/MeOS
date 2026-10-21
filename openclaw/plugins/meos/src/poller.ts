import { MeosHttpError, pollMessages, postFailure, type MeosAccount } from "./client.js";
import { handleMeosMessage, type MeosChannelRuntime } from "./inbound.js";

// 질문을 가지러 나가는 고리.
//
// ⚠️ 방향이 핵심이다. 밖에서 이 PC 로 들어오는 연결이 없다 — 이쪽에서 주기적으로 나가서 가져온다.
//    그래서 공유기 포트포워딩·터널·고정IP 가 전부 필요 없다.
//
// ⚠️ 그래서 **아무도 질문하지 않아도 계속 호출한다.** 3초 고정이던 시절 하루 28,800회,
//    한 달 86만 회를 썼다. Supabase 무료 플랜의 Edge Function 한도가 월 50만 회라
//    2026-10 에 실제로 한도를 넘겨 앱 전체가 402 로 막혔다(사용자가 앱을 거의 안 쓴 달인데도).
//    조용히 새는 종류라 알아채기 어렵다 — 아래 두 장치로 막는다.
//      ① 질문이 없으면 간격을 단계적으로 늘린다 (대화 중에는 그대로 빠르다)
//      ② 한도 초과(402)를 만나면 길게 쉰다 — 계속 때려 봐야 다음 주기까지 같이 갉아먹는다

/**
 * 유휴 단계 — 마지막으로 질문을 가져간 뒤 흐른 시간에 따라 간격을 늘린다.
 * 질문을 하나라도 집어오면 즉시 기준 간격(account.pollIntervalMs)으로 돌아간다.
 */
const IDLE_STEPS: { afterMs: number; intervalMs: number }[] = [
  { afterMs: 2 * 60_000, intervalMs: 10_000 },
  { afterMs: 10 * 60_000, intervalMs: 30_000 },
];

/** 한도 초과·결제 문제는 몇 초 뒤에 다시 해 봐야 소용이 없다. 길게 쉬고 다시 본다. */
const QUOTA_WAIT_MS = 10 * 60_000;

/** 어떤 이유로든 이보다 오래 자지는 않는다 — 고쳐 놓고도 안 고쳐진 것처럼 보이면 안 된다 */
const MAX_WAIT_MS = 60_000;

/** 기준 간격과 유휴 시간으로 이번에 쉴 간격을 정한다. 기준보다 짧아지지는 않는다. */
function idleInterval(baseMs: number, idleMs: number): number {
  let out = baseMs;
  for (const step of IDLE_STEPS) {
    if (idleMs >= step.afterMs) out = step.intervalMs;
  }
  return Math.max(baseMs, out);
}

export type PollerParams = {
  account: MeosAccount;
  cfg: unknown;
  channelRuntime: MeosChannelRuntime;
  abortSignal?: AbortSignal;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  setStatus?: (s: Record<string, unknown>) => void;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(t);
      done();
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runMeosPoller(params: PollerParams): Promise<void> {
  const { account, abortSignal, log, errLog, setStatus } = params;
  // 주소를 찍어 둔다 — 설정이 틀렸을 때 로그만 보고 바로 알 수 있어야 한다
  log(`폴링 시작 · ${account.pollIntervalMs}ms · ${account.baseUrl}`);

  // 연달아 실패하면 간격을 늘린다. 함수가 죽었을 때 초당 요청을 계속 때리지 않도록.
  // ⚠️ 너무 길게 잡으면 안 된다 — 대화 기능이라 3분씩 자면 고쳐 놓고도 안 고쳐진 것처럼 보인다.
  const MAX_BACKOFF_STEPS = 3; // 3s → 최대 24s
  let backoff = 0;
  /** 마지막으로 질문을 집어온 시각. 여기서부터 유휴 시간을 센다. */
  let lastInboundAt = Date.now();
  /** 한도 초과를 만났으면 그 사실을 이번 주기 동안 기억한다 */
  let quotaBlocked = false;
  /** 간격이 바뀐 순간에만 로그를 남긴다 — 매번 찍으면 로그가 폴링으로 가득 찬다 */
  let loggedInterval = account.pollIntervalMs;

  while (!abortSignal?.aborted) {
    try {
      const messages = await pollMessages(account);
      backoff = 0;
      if (quotaBlocked) {
        log("한도가 풀렸습니다 — 평소 간격으로 돌아갑니다");
        quotaBlocked = false;
      }
      if (messages.length) {
        lastInboundAt = Date.now();
        setStatus?.({ accountId: account.accountId, running: true, lastInboundAt: Date.now() });
        for (const m of messages) {
          if (abortSignal?.aborted) break;
          try {
            await handleMeosMessage(
              { account, cfg: params.cfg, channelRuntime: params.channelRuntime, log, errLog },
              m,
            );
          } catch (err) {
            // 한 질문이 터져도 고리는 계속 돈다. 대신 그 질문은 실패로 표시해
            // 화면에 '대기 중' 으로 영원히 남지 않게 한다.
            errLog(`meos: 처리 실패 ${m.id}: ${String(err)}`);
            await postFailure(account, { messageId: m.id, error: String(err).slice(0, 2000) }).catch(() => {});
          }
        }
      }
    } catch (err) {
      // 402 = 요금제 한도 초과. 재시도해도 이번 주기에는 풀리지 않고, 실패한 호출도
      // 사용량으로 집계되므로 계속 때리면 다음 주기까지 미리 갉아먹는다.
      const status = err instanceof MeosHttpError ? err.status : 0;
      if (status === 402) {
        if (!quotaBlocked) {
          errLog(`Supabase 한도 초과(402) — ${QUOTA_WAIT_MS / 60_000}분 간격으로 늦춥니다: ${String(err)}`);
          quotaBlocked = true;
        }
      } else {
        backoff = Math.min(MAX_BACKOFF_STEPS, backoff + 1);
        errLog(`폴링 실패 (연속 ${backoff}회): ${String(err)}`);
      }
      setStatus?.({ accountId: account.accountId, running: true, lastError: String(err) });
    }

    // 쉴 간격: 한도 초과 > 실패 백오프 > 유휴 단계 순으로 정해진다.
    const idle = idleInterval(account.pollIntervalMs, Date.now() - lastInboundAt);
    const wait = quotaBlocked
      ? QUOTA_WAIT_MS
      : Math.min(MAX_WAIT_MS, backoff ? idle * 2 ** backoff : idle);
    if (!quotaBlocked && idle !== loggedInterval) {
      log(`폴링 간격 ${idle / 1000}초 (질문 없이 ${Math.round((Date.now() - lastInboundAt) / 60_000)}분 경과)`);
      loggedInterval = idle;
    }
    await sleep(wait, abortSignal);
  }

  log("폴링 종료");
  setStatus?.({ accountId: account.accountId, running: false });
}
