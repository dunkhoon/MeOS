import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { meosPlugin } from "./src/channel.js";

// 채널이 꺼져 있거나 아직 설정 전일 때 OpenClaw 가 전체 진입점 대신 이걸 읽는다.
// 폴링 같은 무거운 런타임을 안 끌고 오려는 것이다.
export default defineSetupPluginEntry(meosPlugin);
