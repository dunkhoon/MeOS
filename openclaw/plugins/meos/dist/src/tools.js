import { readData } from "./client.js";
import { resolveMeosAccount } from "./config.js";
/**
 * 인자 없는 도구의 스키마.
 *
 * ⚠️ typebox 의 `Type.Object({})` 를 쓰지 않는다. 플러그인이 `~/.openclaw/plugins/` 아래
 *    설치되면 node 해석이 openclaw 안쪽의 typebox 까지 못 닿아서 import 가 깨지고,
 *    그러면 **플러그인 전체가 안 뜬다**(채널도 같이 사라진다).
 *    typebox 스키마는 런타임에 결국 이 JSON Schema 객체와 같은 모양이라 그대로 쓴다.
 *    타입 표기만 맞춰 주면 되므로 여기서만 단언한다.
 */
const NO_PARAMS = { type: "object", properties: {}, additionalProperties: false };
function makeTool(name, label, description, kind, cfgRef) {
    return {
        name,
        label,
        description,
        parameters: NO_PARAMS,
        async execute() {
            const account = resolveMeosAccount(cfgRef());
            if (!account.configured) {
                // details 는 선택이 아니다 — 빼면 등록 자체가 규격을 어긴다
                return {
                    content: [{ type: "text", text: "MeOS 채널이 설정되지 않았습니다 (channels.meos)." }],
                    details: null,
                };
            }
            const data = await readData(account, kind);
            // 에이전트가 읽을 것이므로 사람이 읽는 문장이 아니라 구조 그대로 준다
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
        },
    };
}
export function meosTools(cfgRef) {
    return [
        makeTool("meos_overview", "MeOS 최근 요약", "MeOS 에서 최근 4주 운동 요약을 읽는다 — 유산소 거리·시간·칼로리, 근력 세션·세트·볼륨, 최근 컨디션(수면·HRV·안정시심박), 최신 인바디, 활성 목표. 사용자의 최근 상태를 물으면 먼저 이걸 부른다.", "overview", cfgRef),
        makeTool("meos_activities", "MeOS 활동 목록", "MeOS 에서 최근 활동(러닝·라이딩 등) 30건을 개별로 읽는다 — 날짜·종류·거리·시간·심박·훈련부하. 특정 훈련을 짚어 이야기할 때 쓴다.", "activities", cfgRef),
        makeTool("meos_strength", "MeOS 근력 기록", "MeOS 에서 최근 4주 근력 세션을 세트 단위로 읽는다 — 종목·중량·횟수·세트 시간. 휴식은 저장돼 있지 않고 세트 사이 간격으로 계산해야 한다.", "strength", cfgRef),
        makeTool("meos_body", "MeOS 체형·목표", "MeOS 에서 인바디 측정 이력(최근 24회)·목표·최근 4주 섭취 기록을 읽는다. 체중·체지방률·골격근량 변화나 목표 진행을 이야기할 때 쓴다.", "body", cfgRef),
    ];
}
