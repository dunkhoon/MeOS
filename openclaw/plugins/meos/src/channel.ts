import { postAnswer, type MeosAccount } from "./client.js";
import { CHANNEL_ID, inspectMeosAccount, listMeosAccountIds, resolveMeosAccount } from "./config.js";
import { runMeosPoller, type PollerParams } from "./poller.js";

// MeOS 채널.
//
// 다른 채널과 다른 점이 하나 있다: **보낼 대상이 대화(thread)가 아니라 질문(message)** 이다.
// MeOS 는 "질문 하나에 답 하나" 구조라, 답을 저장할 때 어느 질문에 대한 답인지가 있어야 한다.
// 평소 흐름은 inbound.ts 가 messageId 를 쥐고 있으니 문제없고, cron 처럼 밖에서 먼저
// 말을 거는 경우만 여기 sendText 로 온다.

export const meosPlugin = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "MeOS",
    selectionLabel: "MeOS (앱 내 대화)",
    blurb: "MeOS 어시스턴트 화면에서 온 질문을 받고 답한다.",
    order: 80,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: false,
    // 답은 모았다가 한 번에 저장한다 — 조각마다 저장하면 말풍선이 여러 개로 쪼개진다
    blockStreaming: false,
  },

  /**
   * 이 채널로 들어온 질문에만 붙는 지침.
   *
   * 이게 없으면 에이전트가 도구가 있는 줄 모르고 넘겨짚는다. 실제로 "이번 주에 뭘 조정할까"
   * 라는 체형 질문을 **러닝 훈련 분석으로 받아** 엉뚱하게 답한 적이 있다 —
   * 이 사용자는 러닝 기록이 압도적으로 많아서 그쪽으로 쏠린다.
   */
  agentPrompt: {
    messageToolHints: () => [
      "이 대화는 MeOS 앱에서 왔다. 사용자의 실제 기록을 볼 수 있는 도구가 있으니 **추측하지 말고 먼저 읽어라**: " +
        "`meos_overview`(최근 4주 요약 — 유산소·근력·컨디션·인바디·목표), `meos_activities`(러닝 등 개별 활동), " +
        "`meos_strength`(근력 세션의 종목·중량·횟수), `meos_body`(인바디 이력·목표·섭취 기록).",
      "질문이 무엇에 관한 것인지 먼저 가려라. **체중·체지방·근육량·인바디·식단·칼로리·목표 달성** 이야기면 " +
        "`meos_body` 와 `meos_overview` 를 쓰고, 러닝 훈련 분석 스킬을 쓰지 마라. " +
        "**근력·세트·볼륨·종목** 이야기면 `meos_strength` 를 쓴다. 러닝 페이스·심박·훈련부하일 때만 러닝 쪽으로 간다.",
      "메시지 앞에 `[MeOS 화면 맥락]` 이 붙어 있으면 그건 사용자가 지금 보고 있는 화면의 수치이고, " +
        "이미 규칙으로 계산된 값이다. 그 숫자를 다시 나열하지 말고 **해석과 다음 행동**을 말해라. " +
        "맥락에 없는 것이 필요하면 위 도구로 직접 더 읽어라.",
      "답은 한국어 존댓말로, 화면에서 바로 읽을 수 있게 짧게. 표보다 문장과 짧은 목록이 낫다.",
    ],
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  config: {
    listAccountIds: () => listMeosAccountIds(),
    resolveAccount: (cfg: unknown, accountId?: string | null) => resolveMeosAccount(cfg, accountId),
    inspectAccount: (cfg: unknown) => inspectMeosAccount(cfg),
    isConfigured: (account: MeosAccount) => account.configured,
    describeAccount: (account: MeosAccount) => ({
      accountId: account.accountId,
      name: "MeOS",
      enabled: account.configured,
      configured: account.configured,
    }),
  },

  setup: {
    applyAccountConfig: ({ cfg, input }: { cfg: Record<string, unknown>; input: Record<string, unknown> }) => ({
      ...cfg,
      channels: {
        ...(cfg.channels as Record<string, unknown>),
        [CHANNEL_ID]: { ...((cfg.channels as Record<string, unknown>)?.[CHANNEL_ID] as object), ...input },
      },
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 20000,
    /**
     * 대화를 먼저 거는 경로(cron 등). `to` 는 답을 달 **질문 id** 여야 한다.
     * 평소 답변은 inbound.ts 가 직접 저장하므로 여기를 지나지 않는다.
     */
    sendText: async (ctx: { cfg: unknown; to: string; text: string; accountId?: string }) => {
      const account = resolveMeosAccount(ctx.cfg, ctx.accountId);
      if (!account.configured) throw new Error("meos: baseUrl/token 이 설정되지 않았습니다.");
      await postAnswer(account, { messageId: ctx.to, content: ctx.text });
      return { channel: CHANNEL_ID, messageId: ctx.to };
    },
  },

  status: {
    defaultRuntime: {
      accountId: "",
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: { account: MeosAccount; runtime: Record<string, unknown> }) => ({
      ...runtime,
      accountId: account.accountId,
      name: "MeOS",
      enabled: account.configured,
      configured: account.configured,
    }),
  },

  gateway: {
    startAccount: async (ctx: {
      account: MeosAccount;
      cfg: unknown;
      channelRuntime?: PollerParams["channelRuntime"];
      abortSignal?: AbortSignal;
      setStatus?: (s: Record<string, unknown>) => void;
      log?: { info?: (m: string) => void; error?: (m: string) => void };
    }) => {
      const account = ctx.account;
      if (!account.configured) {
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error(
          "meos: 설정이 없습니다 — channels.meos.baseUrl 과 channels.meos.token 을 채우세요.",
        );
      }
      // 게이트웨이가 호출마다 넣어 주는 런타임이다. 이게 없으면 답을 만들 길이 없다.
      if (!ctx.channelRuntime) {
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error("meos: ctx.channelRuntime 이 없습니다 — 호스트 버전이 너무 낮습니다.");
      }

      ctx.setStatus?.({ accountId: account.accountId, running: true, lastStartAt: Date.now() });
      return runMeosPoller({
        account,
        cfg: ctx.cfg,
        channelRuntime: ctx.channelRuntime,
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus,
        log: (m) => ctx.log?.info?.(`[meos] ${m}`),
        errLog: (m) => ctx.log?.error?.(`[meos] ${m}`),
      });
    },
  },
}
