# OpenClaw 스킬 — MeOS 훈련 분석

디스코드에서 **"오늘 훈련 어때?"** 하면 OpenClaw 가 훈련을 분석하고,
그 결과를 **MeOS 훈련 상세에 자동으로 올린다.** 휴대폰에서도 바로 보인다.

```
디스코드 ──▶ OpenClaw(집 PC) ──▶ MeOS Edge Function `note` ──▶ Supabase
                                                                 │
                          MeOS 훈련 상세 화면 ◀───────────────────┘
```

바깥에서 집 PC 로 들어갈 일이 없다 — **집 PC 가 밖으로 보내기만** 한다.
포트포워딩·터널·고정IP 모두 필요 없다.

## 설치 (집 PC, 최초 1회)

**1) 스킬 폴더 복사**

```bash
cp -r skills/meos-training ~/.openclaw/workspace/skills/
```

Windows 라면:

```powershell
Copy-Item -Recurse skills\meos-training "$env:USERPROFILE\.openclaw\workspace\skills\"
```

**2) 토큰 등록** — `~/.openclaw/openclaw.json`

```jsonc
{
  "skills": {
    "entries": {
      "meos-training": {
        "env": { "MEOS_NOTE_TOKEN": "<MeOS 토큰>" }
      }
    }
  }
}
```

토큰이 안 먹으면 셸 환경변수로 넣어도 된다 (`export MEOS_NOTE_TOKEN=...`).
`MEOS_NOTE_URL` 은 기본값이 이 프로젝트 주소라 보통 건드릴 필요 없다.

**3) 반영** — OpenClaw 는 `SKILL.md` 를 감시하지만, 진행 중인 세션에는 안 붙는다.
**새 세션을 시작**하거나 게이트웨이를 재시작한다.

## 확인

```bash
export MEOS_NOTE_TOKEN=<토큰>
node ~/.openclaw/workspace/skills/meos-training/scripts/meos.mjs recent 3
```

최근 훈련 3건이 JSON 으로 나오면 성공.

## 쓰는 법 (디스코드)

| 말 | 하는 일 |
|---|---|
| "오늘 훈련 어때?" | 분석 + **자동으로 MeOS 에 올림** |
| "어제 러닝 봐줘" | 위와 같되 그날 훈련으로 |
| "MeOS에 훈련 분석 올려줘" | 방금 한 분석을 올림 (없으면 새로 분석) |
| "최근 훈련 목록" | 목록만 (올리지 않음) |

같은 훈련에 다시 올리면 덮어쓴다.

## 명령 (스킬이 내부에서 쓰는 것)

```bash
node scripts/meos.mjs today              # 오늘(없으면 최근) 훈련 자료
node scripts/meos.mjs recent [N]         # 최근 목록
node scripts/meos.mjs get <활동id>       # 특정 훈련 자료
node scripts/meos.mjs post <활동id> --model <이름>   # 본문은 stdin
```

> `post` 본문을 **stdin 으로만** 받는 건 의도한 것이다. 여러 줄 한국어를 명령줄 인자로 넘기면
> 따옴표·개행·인코딩에서 깨진다 (윈도우에서 특히). 실제로 개발 중에 curl 로 넣었다가
> 한글이 통째로 깨진 적이 있다.

## 분석 품질에 대해

MeOS 화면에는 이미 **규칙 기반 수치**가 나온다 (LTHR 초과율·반복 편차·드리프트·목표존 적중 등).
그래서 스킬은 AI 에게 **숫자를 다시 나열하지 말고** 해석과 다음 세션 제안을 쓰라고 지시한다.

랩의 `type` 은 믿지 말라고도 적어 뒀다 — intervals.icu 는 워밍업·쿨다운까지 `WORK` 로 준다.
