import { createChannelMessageAdapterFromOutbound, } from "openclaw/plugin-sdk/channel-outbound";
import { postAnswer } from "./client.js";
import { CHANNEL_ID, resolveMeosAccount } from "./config.js";
/**
 * 답을 MeOS 에 저장한다.
 *
 * ⚠️ `to` 는 대화(thread)가 아니라 **답을 달 질문 id** 다. MeOS 는 "질문 하나에 답 하나" 라
 * 어느 질문에 대한 답인지가 있어야 화면에 붙는다. 평소 답변은 inbound.ts 가 직접 저장하므로
 * 이 경로를 지나지 않는다 — 여기로 오는 건 cron 처럼 밖에서 먼저 말을 거는 경우다.
 */
export async function sendMeosText(ctx) {
    const account = resolveMeosAccount(ctx.cfg, ctx.accountId);
    if (!account.configured)
        throw new Error("meos: baseUrl/token 이 설정되지 않았습니다.");
    await postAnswer(account, { messageId: ctx.to, content: ctx.text });
    // 저장된 답 행의 id 를 함수가 돌려주지 않는다. 되돌릴 수 있는 유일한 안정된 식별자가
    // 질문 id 라 그걸 receipt 에 담는다 — "이 질문에 답이 붙었다" 는 뜻이지, 답 행의 id 가 아니다.
    return { channel: CHANNEL_ID, messageId: ctx.to };
}
/**
 * 기존 outbound. 새 어댑터가 생겨도 이건 남는다 —
 * 청크 한도·전송 방식(deliveryMode)은 message 어댑터가 아니라 여기가 들고 있다.
 *
 * `deliveryCapabilities.durableFinal` 은 legacy 타입에도 있고 브리지도 같은 자리를 읽는다.
 * 그래서 **여기 한 번만** 적어 두면 양쪽이 같은 값을 본다.
 * 텍스트만 켠다 — MeOS 는 미디어·답글·스레드·묶음전송을 하지 않는다(없는 걸 켜면 core 가
 * 지키지도 못할 보장을 믿고 동작한다).
 */
export const meosOutbound = {
    deliveryMode: "direct",
    textChunkLimit: 20000,
    deliveryCapabilities: { durableFinal: { text: true } },
    sendText: sendMeosText,
};
/**
 * 새 message 어댑터 — 기존 outbound 를 그대로 감싼다.
 *
 * ⚠️ 문서(sdk-channel-outbound.md)의 예제는 `durableFinal: { capabilities: … }` 를 넘기라고
 *    적혀 있는데 **실제 파라미터 타입에는 그런 칸이 없다**(구현은
 *    `params.capabilities ?? params.outbound.deliveryCapabilities?.durableFinal` 를 읽는다).
 *    문서대로 쓰면 조용히 `capabilities: undefined` 가 되어 아무것도 선언되지 않는다.
 *    여기서는 outbound 쪽 선언을 그대로 물려받게 두었다.
 *
 * receive 는 넘기지 않는다 → 브리지가 manual ack 을 기본으로 넣는다. MeOS 는 Edge Function 이
 * 질문을 집어가는 순간 taken 으로 표시하므로(중복 응답 차단) 그 기본값이 맞다.
 */
export const meosMessageAdapter = createChannelMessageAdapterFromOutbound({
    id: CHANNEL_ID,
    outbound: meosOutbound,
});
