import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { postAnswer, postFailure, type MeosAccount, type MeosPendingMessage } from "./client.js";
import { CHANNEL_ID } from "./config.js";

// 질문 하나를 에이전트에 태우고, 나온 답을 MeOS 로 돌려보낸다.
//
// 호출 순서는 번들 채널들이 쓰는 것과 같다:
//   라우트 해석 → 세션 경로 → 컨텍스트 확정 → 세션 기록 → 디스패처로 답 받기
//
// 디스패처의 deliver 가 곧 "MeOS 에 답 저장" 이다. 채팅 화면이 그 행을 보고 뜬다.

/** `ctx.channelRuntime` — 게이트웨이가 호출마다 넣어 주는 런타임 표면. */
export type MeosChannelRuntime = {
  routing: {
    resolveAgentRoute: (params: {
      cfg: unknown;
      channel: string;
      accountId?: string;
      peer: { kind: "direct"; id: string };
    }) => { agentId: string; sessionKey: string; mainSessionKey?: string };
  };
  session: {
    resolveStorePath: (store: unknown, opts: { agentId: string }) => string;
    recordInboundSession: (params: Record<string, unknown>) => Promise<void>;
  };
  reply: {
    finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
    resolveHumanDelayConfig: (cfg: unknown, agentId: string) => unknown;
    createReplyDispatcherWithTyping: (params: Record<string, unknown>) => {
      dispatcher: unknown;
      replyOptions: Record<string, unknown>;
      markDispatchIdle: () => void;
    };
    withReplyDispatcher: (params: { dispatcher: unknown; run: () => Promise<unknown> }) => Promise<unknown>;
    dispatchReplyFromConfig: (params: Record<string, unknown>) => Promise<unknown>;
  };
};

export type HandleDeps = {
  account: MeosAccount;
  cfg: unknown;
  channelRuntime: MeosChannelRuntime;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
};

/** 화면에서 실어 보낸 맥락을 질문 앞에 붙인다 — 에이전트가 도구를 안 불러도 바로 답할 수 있게. */
function bodyWithContext(message: MeosPendingMessage): string {
  const ctx = message.context;
  if (!ctx || typeof ctx !== "object") return message.content;
  let rendered: string;
  try {
    rendered = JSON.stringify(ctx, null, 2);
  } catch {
    return message.content;
  }
  // 맥락이 지나치게 크면 프롬프트를 잡아먹는다. 넘치면 도구로 다시 읽으면 된다.
  if (rendered.length > 6000) rendered = `${rendered.slice(0, 6000)}\n…(생략)`;
  return `[MeOS 화면 맥락]\n${rendered}\n\n${message.content}`;
}

/** 화면이 사진을 딸려 보냈나 — 영양정보표 판독이 그렇다 */
function imageUrlOf(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  const url = (context as { imageUrl?: unknown }).imageUrl;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
}

/**
 * 서명 URL 을 받아 임시 파일로 떨군다.
 *
 * ⚠️ URL 을 글로만 넘기면 에이전트는 **글자만 본다.** 실제로 이미지를 보려면 파일이어야 한다.
 *    (번들 채널들도 받은 미디어를 내려받아 `MediaPath` 로 넘긴다)
 *    Supabase 서명 URL 은 30분짜리라 지금 받아 두면 된다.
 */
async function downloadToTemp(url: string): Promise<{ filePath: string; dir: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`사진을 받지 못했습니다 (HTTP ${res.status})`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const dir = await mkdtemp(path.join(tmpdir(), "meos-food-"));
  const filePath = path.join(dir, `label.${ext}`);
  await writeFile(filePath, Buffer.from(await res.arrayBuffer()));
  return { filePath, dir, mime };
}

/**
 * dispatch 반환값을 한 줄로 요약한다.
 *
 * 모양이 버전마다 조금씩 달라 형태를 가정하지 않는다 — 아는 칸만 뽑고,
 * 모르는 모양이면 통째로 문자열로 남긴다. 진단용이라 정확한 타입보다 "무엇이든 남는 것" 이 낫다.
 */
function describeDispatchOutcome(outcome: unknown): string {
  if (!outcome || typeof outcome !== "object") return String(outcome ?? "");
  const o = outcome as Record<string, unknown>;
  const bits: string[] = [];
  for (const key of ["status", "reason", "queuedFinal", "skipped"]) {
    if (o[key] !== undefined) bits.push(`${key}=${String(o[key])}`);
  }
  const counts = o.counts;
  if (counts && typeof counts === "object") bits.push(`counts=${JSON.stringify(counts)}`);
  if (bits.length) return bits.join(" ");
  try {
    return JSON.stringify(o).slice(0, 300);
  } catch {
    return "(요약 불가)";
  }
}

export async function handleMeosMessage(deps: HandleDeps, message: MeosPendingMessage): Promise<void> {
  const { account, cfg, channelRuntime } = deps;
  // 답을 되돌릴 대상은 "대화" 다. 대화마다 세션이 갈리므로 새 대화 = 새 맥락이 된다.
  const to = message.thread_id;

  // 사진이 딸려 왔으면 받아서 파일로 붙인다 (URL 글자만으로는 에이전트가 못 본다)
  let media: { filePath: string; dir: string; mime: string } | null = null;
  const imageUrl = imageUrlOf(message.context);
  if (imageUrl) {
    try {
      media = await downloadToTemp(imageUrl);
    } catch (err) {
      deps.errLog(`사진 내려받기 실패: ${String(err)}`);
      await postFailure(account, { messageId: message.id, error: `사진을 읽지 못했습니다: ${String(err)}` });
      return;
    }
  }

  const ctx: Record<string, unknown> = {
    Body: bodyWithContext(message),
    From: "meos-user",
    To: to,
    AccountId: account.accountId ?? undefined,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: to,
    MessageSid: message.id,
    Timestamp: Date.parse(message.created_at) || Date.now(),
    Provider: CHANNEL_ID,
    ChatType: "direct",
    // 이 채널에 들어오는 유일한 길이 공유 토큰이다 — 여기까지 온 메시지는 곧 운영자 본인이다.
    CommandAuthorized: true,
    CommandBody: message.content.trim(),
    ...(media ? { MediaPath: media.filePath, MediaType: media.mime } : {}),
  };

  // 어디로 빠져나가든 임시 파일은 지운다
  const cleanup = async () => {
    if (media) await rm(media.dir, { recursive: true, force: true }).catch(() => {});
    media = null;
  };

  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId ?? undefined,
    peer: { kind: "direct", id: to },
  });
  if (!route?.agentId) {
    await cleanup();
    await postFailure(account, { messageId: message.id, error: "에이전트를 찾지 못했습니다 (agent route 없음)." });
    return;
  }

  // 해석된 세션을 ctx 에 실어야 dispatchReplyFromConfig 가 agent:main:main 으로 안 떨어진다
  ctx.SessionKey = route.sessionKey;

  const storePath = channelRuntime.session.resolveStorePath((cfg as { session?: { store?: unknown } })?.session?.store, {
    agentId: route.agentId,
  });
  const finalized = channelRuntime.reply.finalizeInboundContext(ctx);

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalized,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: CHANNEL_ID,
      to,
      accountId: account.accountId ?? undefined,
    },
    onRecordError: (err: unknown) => deps.errLog(`recordInboundSession: ${String(err)}`),
  });

  // 답을 여러 조각으로 흘려보내면 채팅에 말풍선이 여러 개 뜬다.
  // MeOS 는 한 질문에 한 답이 자연스러우니 모았다가 한 번에 저장한다.
  const chunks: string[] = [];
  let delivered = false;

  const humanDelay = channelRuntime.reply.resolveHumanDelayConfig(cfg, route.agentId);
  const { dispatcher, replyOptions, markDispatchIdle } = channelRuntime.reply.createReplyDispatcherWithTyping({
    humanDelay,
    deliver: async (payload: { text?: string }) => {
      const text = (payload?.text ?? "").trim();
      if (text) chunks.push(text);
      delivered = true;
    },
    onError: (err: unknown, info: { kind: string }) => {
      deps.errLog(`meos reply ${info?.kind ?? "?"}: ${String(err)}`);
    },
  });

  // ⚠️ dispatch 결과를 버리면 안 된다. core 는 턴을 **조용히 건너뛸 수 있다** — 예외도 아니고
  //    로그도 verbose 에서만 나온다. 버리면 화면엔 "답하지 않았습니다" 만 남고 이유가 사라진다.
  //    (실제로 그 상태에서 원인을 못 찾아 한참 헤맸다. 아래 sourceReplyDeliveryMode 가 그 원인이었다.)
  let dispatchInfo = "";
  try {
    const outcome = await channelRuntime.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        channelRuntime.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming: true,
            // ⚠️ 이 한 줄이 없으면 **답이 통째로 버려진다.**
            //
            // core 는 최종 텍스트를 자동으로 넘길지(`automatic`), 에이전트가 `message` 도구를
            // 직접 불러야 하는지(`message_tool_only`) 를 턴마다 정한다. 직접 대화이고
            // `messages.visibleReplies` 가 없으면 **harness 기본값**이 그대로 먹는데,
            // codex harness 는 `deliveryDefaults: { sourceVisibleReplies: "message_tool" }` 이다.
            // 즉 OpenAI/codex 모델을 쓰는 순간 MeOS 는 자동 전달이 꺼진다.
            //
            // 그 모드에서 에이전트가 도구를 안 부르고 그냥 답하면 core 는 그 글을 조용히 버린다
            // (`final reply suppressed by sourceReplyDeliveryMode: message_tool_only`, verbose 로그).
            // 우리 deliver 가 한 번도 안 불리니 화면엔 "답하지 않았습니다" 만 남았다 — 실측한 증상이다.
            //
            // MeOS 의 계약은 "질문 하나 → 답 하나를 DB 에 저장" 이고, 그 저장을 하는 게 곧
            // 이 dispatcher 의 deliver 다. 그러니 harness 가 뭐든 자동 전달이어야 맞다.
            // 명시적으로 요청한 값은 harness 기본값보다 먼저 적용된다
            // (source-reply-delivery-mode.ts — requested 를 가장 앞에서 반환한다).
            sourceReplyDeliveryMode: "automatic",
          },
        }),
    });
    dispatchInfo = describeDispatchOutcome(outcome);
    deps.log(`dispatch ${message.id}: ${dispatchInfo}`);
  } catch (err) {
    await cleanup();
    await postFailure(account, { messageId: message.id, error: String(err).slice(0, 2000) });
    return;
  } finally {
    markDispatchIdle();
  }
  await cleanup();

  const answer = chunks.join("\n\n").trim();
  if (!answer) {
    // 도구만 돌고 글이 안 나온 경우도 있다 — 화면에 영원히 '대기 중' 으로 남으면 안 된다
    const why = delivered ? "빈 답이 돌아왔습니다." : "에이전트가 답하지 않았습니다.";
    deps.errLog(`${why} ${message.id} · ${dispatchInfo || "dispatch 결과 없음"}`);
    await postFailure(account, {
      messageId: message.id,
      // 이유를 같이 넘긴다 — 화면에서 바로 보이고, 로그를 못 봐도 무엇이 막았는지 안다
      error: dispatchInfo ? `${why} (${dispatchInfo})` : why,
    });
    return;
  }
  await postAnswer(account, { messageId: message.id, content: answer });
  deps.log(`answered ${message.id} (${answer.length}자)`);
}
