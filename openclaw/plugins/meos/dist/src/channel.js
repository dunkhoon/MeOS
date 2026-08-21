import { CHANNEL_ID, inspectMeosAccount, listMeosAccountIds, resolveMeosAccount } from "./config.js";
import { meosMessageAdapter, meosOutbound } from "./outbound.js";
import { runMeosPoller } from "./poller.js";
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
            "질문이 **JSON 형식을 지정**하면(영양정보표 판독·음식 영양 추정이 그렇다) 설명·인사·코드펜스 없이 " +
                "**JSON 객체 하나만** 출력해라. 앱이 그걸 그대로 파싱해 입력 칸에 채운다. 표에 없는 항목은 " +
                "0 이 아니라 null 이다 — 0 으로 적으면 합계가 조용히 틀어진다.",
            "사진이 붙어 있으면 그건 **영양정보표를 찍은 것**이다(음식 사진이 아니다). 표의 숫자를 그대로 읽어라.",
            "그 밖의 답은 한국어 존댓말로, 화면에서 바로 읽을 수 있게 짧게. 표보다 문장과 짧은 목록이 낫다.",
        ],
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    config: {
        listAccountIds: () => listMeosAccountIds(),
        resolveAccount: (cfg, accountId) => resolveMeosAccount(cfg, accountId),
        inspectAccount: (cfg) => inspectMeosAccount(cfg),
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: "MeOS",
            enabled: account.configured,
            configured: account.configured,
        }),
    },
    setup: {
        applyAccountConfig: ({ cfg, input }) => ({
            ...cfg,
            channels: {
                ...cfg.channels,
                [CHANNEL_ID]: { ...cfg.channels?.[CHANNEL_ID], ...input },
            },
        }),
    },
    // 보내기는 outbound.ts 한 곳에 있다. 여기서는 두 자리에 꽂기만 한다.
    //   outbound — 청크 한도·전송 방식 (2026.7 에서도 그대로 쓰인다)
    //   message  — 그 outbound 를 감싼 새 어댑터 (durable send·receipt)
    outbound: meosOutbound,
    message: meosMessageAdapter,
    status: {
        defaultRuntime: {
            accountId: "",
            lastError: null,
            lastInboundAt: null,
            lastOutboundAt: null,
        },
        collectStatusIssues: () => [],
        buildChannelSummary: ({ snapshot }) => ({
            configured: snapshot.configured ?? false,
            lastError: snapshot.lastError ?? null,
            lastInboundAt: snapshot.lastInboundAt ?? null,
            lastOutboundAt: snapshot.lastOutboundAt ?? null,
        }),
        buildAccountSnapshot: ({ account, runtime }) => ({
            ...runtime,
            accountId: account.accountId,
            name: "MeOS",
            enabled: account.configured,
            configured: account.configured,
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            const account = ctx.account;
            if (!account.configured) {
                ctx.setStatus?.({ accountId: account.accountId, running: false });
                throw new Error("meos: 설정이 없습니다 — channels.meos.baseUrl 과 channels.meos.token 을 채우세요.");
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
};
