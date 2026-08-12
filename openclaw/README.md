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

## 원리 (설치랄 게 없다)

OpenClaw 스킬에는 레지스트리도 패키지 매니저도 없다. **정해진 폴더에 파일이 있으면 끝**이다.

```
~/.openclaw/workspace/skills/meos-training/
├─ SKILL.md              ← 이게 있으면 스킬로 인식된다
└─ scripts/meos.mjs
```

1. OpenClaw 가 시작할 때 `skills/**/SKILL.md` 를 훑는다
2. 각 파일의 frontmatter `description` 한 줄이 에이전트 시스템 프롬프트에 들어간다
3. "오늘 훈련 어때?" 가 그 설명과 맞으면 에이전트가 **SKILL.md 본문을 읽는다**
4. 본문의 `node {baseDir}/scripts/meos.mjs today` 를 `exec` 로 실행한다
   (`{baseDir}` 은 그 스킬 폴더 경로로 치환된다)

즉 **파일을 거기 갖다 놓는 것**이 설치의 전부다.

## 설치 (OpenClaw 가 도는 PC, 최초 1회)

⚠️ 이 저장소가 **OpenClaw 가 도는 PC** 에 있어야 한다. 개발 PC 와 다른 기기라면 먼저 옮긴다.

**1) 저장소 받기** — 이후 업데이트가 `git pull` 로 끝나므로 이 방법을 권한다

```powershell
git clone https://github.com/dunkhoon/MeOS.git C:\MeOS      # Private → GitHub 로그인 1회
```

클론이 부담되면 **파일 2개만** 옮겨도 된다 (USB·네트워크·클라우드 드라이브 아무거나):
`SKILL.md` 와 `scripts/meos.mjs`. 폴더 구조만 위와 같으면 동작한다.

집 PC 앞이라면 OpenClaw 에게 직접 시켜도 된다 —
*"`~/.openclaw/workspace/skills/meos-training/` 만들고 github.com/dunkhoon/MeOS 의
`openclaw/skills/meos-training` 내용을 복사해줘"*.

**2) 스킬 폴더에 복사**

```powershell
Copy-Item -Recurse C:\MeOS\openclaw\skills\meos-training "$env:USERPROFILE\.openclaw\workspace\skills\"
```

```bash
# macOS / Linux
cp -r ~/MeOS/openclaw/skills/meos-training ~/.openclaw/workspace/skills/
```

**3) 토큰 등록** — `~/.openclaw/openclaw.json`

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

**4) 반영** — OpenClaw 는 `SKILL.md` 를 감시하지만, 진행 중인 세션에는 안 붙는다.
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
