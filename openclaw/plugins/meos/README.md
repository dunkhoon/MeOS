# OpenClaw 채널 — MeOS

MeOS **어시스턴트** 화면에서 물어보면 집 PC 의 OpenClaw 가 답하고, 그 답이 앱에 바로 뜬다.
디스코드를 거치지 않는다. 휴대폰에서도 같은 화면이다.

```
MeOS 앱 (폰/PC)              Supabase                집 PC (OpenClaw)
   │ 질문 ──(RLS insert)──▶ chat_messages                │
   │                            │ ◀──(폴링, x-meos-token)── meos 채널
   │                            │                        │  에이전트 실행
   │ ◀──(2초 폴링)───────────  │ ◀──(답 insert)──────── │
```

**집 PC 는 밖으로 나가기만 한다.** 포트포워딩·터널·고정IP 가 전부 필요 없다 —
[`openclaw/skills/meos-training`](../../skills/meos-training) 과 같은 원칙이다.

## 무엇이 들어 있나

| | |
|---|---|
| **채널 `meos`** | 질문을 폴링해 가져오고, 답을 되돌려 저장한다 |
| **도구 `meos_overview`** | 최근 4주 요약 — 유산소·근력·컨디션·인바디·목표 |
| **도구 `meos_activities`** | 최근 활동 30건 (거리·심박·훈련부하) |
| **도구 `meos_strength`** | 최근 4주 근력 세션 (종목·중량·횟수·시간) |
| **도구 `meos_body`** | 인바디 이력·목표·섭취 기록 |

도구가 있어서 "지난달이랑 비교하면?" 같이 화면에 없는 것도 답할 수 있다.
데이터는 전부 Edge Function `chat` 을 지난다 — **이 플러그인은 DB 키를 들지 않는다.**

## 사전 준비 (MeOS 쪽, 최초 1회)

1. 마이그레이션 `supabase/migrations/0012_chat.sql` 을 SQL Editor 에서 실행
2. Edge Function 배포: `npx supabase functions deploy chat`
3. 토큰은 `note` 와 같은 것을 쓴다. 아직 없으면:
   `npx supabase secrets set MEOS_NOTE_TOKEN=<충분히 긴 임의 문자열>`

## 설치 (OpenClaw 가 도는 PC)

⚠️ 이 저장소가 **OpenClaw 가 도는 PC** 에 있어야 한다.

```bash
openclaw plugins install ./openclaw/plugins/meos
```

`~/.openclaw/openclaw.json` 에 채널 설정을 넣는다:

```jsonc
{
  "channels": {
    "meos": {
      "baseUrl": "https://<프로젝트>.supabase.co/functions/v1/chat",
      "token": "<MEOS_NOTE_TOKEN>",
      "pollIntervalMs": 3000
    }
  }
}
```

게이트웨이를 재시작하면 폴링이 돈다.

## 확인

```bash
# 함수가 살아 있나 (질문이 없으면 messages: [])
curl -s "https://<프로젝트>.supabase.co/functions/v1/chat?poll=1" -H "x-meos-token: $MEOS_NOTE_TOKEN"

# 에이전트 도구가 볼 데이터
curl -s "https://<프로젝트>.supabase.co/functions/v1/chat?data=overview" -H "x-meos-token: $MEOS_NOTE_TOKEN"
```

그다음 MeOS **어시스턴트** 탭에서 아무거나 물어본다. 몇 초 뒤에 답이 뜬다.

## 설계에서 조심한 것들

- **질문을 집어가는 순간 `taken` 으로 표시한다.** 나중에 표시하면 폴링 주기가 답변 시간보다
  짧을 때 같은 질문을 두 번 답한다. `status='pending'` 조건이 붙은 update 라 폴링이 겹쳐도
  한 질문은 한 번만 나간다.
- **지난 대화를 실어 보내지 않는다.** OpenClaw 가 `thread_id` 별로 자기 세션을 들고 있다.
  또 보내면 같은 내용이 두 번 들어간다. 앱에서 **새 대화 = 새 thread = 새 세션**이다.
- **답은 모았다가 한 번에 저장한다.** 조각마다 저장하면 채팅에 말풍선이 여러 개로 쪼개진다.
- **답이 비어도 반드시 표시를 남긴다.** 도구만 돌고 글이 안 나오는 경우가 있는데,
  그대로 두면 화면에 '생각하는 중…' 이 영원히 남는다.
- **연달아 실패하면 폴링 간격을 늘린다.** 함수가 죽었을 때 초당 요청을 계속 때리지 않도록.
- **보내기 구현은 한 벌이다.** 2026.6/2026.7 의 채널은 `outbound`(청크 한도·전송 방식)와
  `message`(durable send·receipt) 두 자리를 갖는다. 두 벌로 쓰면 반드시 갈라지므로,
  `src/outbound.ts` 의 `sendMeosText` 하나를 만들어 `outbound` 에 꽂고 같은 객체를
  `createChannelMessageAdapterFromOutbound()` 로 감싸 `message` 에 꽂는다.
  capability 는 `outbound.deliveryCapabilities.durableFinal` 한 곳에만 적는다 —
  브리지가 같은 자리를 읽는다.

## 아직 확인 못 한 것

이 플러그인은 **실제 OpenClaw 게이트웨이에서 돌려 보지 않았다** (개발 PC 에 OpenClaw 가 없다).
확인한 것은 여기까지다:

- 채널 객체가 SDK 의 `ChannelPlugin` 타입에 **캐스트 없이** 맞는다
- 도구가 `api.registerTool` 이 받는 타입에 맞는다
  (이 과정에서 필수 `label` 누락과 필수 `details` 누락을 잡았다)
- `message` 어댑터를 **실제 SDK(2026.7.1-2)로 타입체크 + 런타임 확인**했다:
  브리지가 `outbound.deliveryCapabilities.durableFinal` 을 물려받아 `{text:true}` 로 선언하고,
  `send.text` 만 노출하며(미디어 없음), receive 는 manual ack 기본값이 붙고,
  `{channel, messageId}` 반환값이 `MessageReceipt`(parts 1개, kind=text)로 정규화된다.
  ⚠️ 문서 예제의 `durableFinal: { capabilities: … }` 인자는 **실제 타입에 없다** —
  그대로 쓰면 조용히 아무 capability 도 선언되지 않는다.

`gateway.startAccount` 의 `ctx.channelRuntime` 표면은 번들 채널 구현을 따라 맞췄지만
런타임 동작은 첫 실행에서 확인이 필요하다. 안 되면 게이트웨이 로그의 `[meos]` 줄을 본다.
