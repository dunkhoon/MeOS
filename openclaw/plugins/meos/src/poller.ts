import { pollMessages, postFailure, type MeosAccount } from "./client.js";
import { handleMeosMessage, type MeosChannelRuntime } from "./inbound.js";

// 질문을 가지러 나가는 고리.
//
// ⚠️ 방향이 핵심이다. 밖에서 이 PC 로 들어오는 연결이 없다 — 이쪽에서 주기적으로 나가서 가져온다.
//    그래서 공유기 포트포워딩·터널·고정IP 가 전부 필요 없다.

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

  while (!abortSignal?.aborted) {
    try {
      const messages = await pollMessages(account);
      backoff = 0;
      if (messages.length) {
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
      backoff = Math.min(MAX_BACKOFF_STEPS, backoff + 1);
      errLog(`폴링 실패 (연속 ${backoff}회): ${String(err)}`);
      setStatus?.({ accountId: account.accountId, running: true, lastError: String(err) });
    }
    const wait = backoff ? account.pollIntervalMs * 2 ** backoff : account.pollIntervalMs;
    await sleep(wait, abortSignal);
  }

  log("폴링 종료");
  setStatus?.({ accountId: account.accountId, running: false });
}
