import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { meosPlugin } from "./src/channel.js";
import { meosTools } from "./src/tools.js";
// MeOS 채널 — 앱 안에서 바로 대화한다. 디스코드를 거치지 않는다.
//
// 질문은 이 플러그인이 Supabase Edge Function `chat` 을 **폴링해서** 가져오고,
// 답은 같은 함수로 되돌려 보낸다. 집 PC 로 들어오는 연결이 없으므로
// 포트포워딩·터널·고정IP 가 필요 없다.
// 도구가 실행될 때의 설정을 읽어야 한다. 등록 시점의 값을 붙잡아 두면
// 사용자가 토큰을 고친 뒤에도 옛 값을 계속 쓰게 된다.
//
// ⚠️ `runtime.config` 는 설정 객체가 **아니라** 접근자 묶음이다. 예전엔 이걸 그대로
//    넘겨서 `cfg.channels` 가 늘 undefined 였고, **도구 4개가 전부
//    "설정되지 않았습니다" 만 돌려주고 있었다**(그래서 에이전트가 체형·근력을 못 봤다).
//    실제 스냅샷은 `config.current()` 다.
let runtimeRef;
export default defineChannelPluginEntry({
    id: "meos",
    name: "MeOS",
    description: "MeOS 어시스턴트 채널 + 내 운동·체형 데이터 조회 도구",
    plugin: meosPlugin,
    setRuntime: (runtime) => {
        runtimeRef = runtime;
    },
    registerFull(api) {
        for (const tool of meosTools(() => runtimeRef?.config.current())) {
            api.registerTool(tool);
        }
    },
});
