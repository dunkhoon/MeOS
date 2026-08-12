# MeOS

개인 통합 대시보드 (Personal OS). 설계 문서는 [`docs/SPEC.md`](docs/SPEC.md) 참고.

## 구조 (모노레포)

```
MeOS/  (저장소 폴더는 PrivatePlanner)
├─ web/         React + TS + Vite (PC·모바일 공용 UI)
├─ electron/    데스크톱 셸 — 화면은 배포된 웹에서 불러오고, 창·트레이·p4·BTS 만 담당
├─ supabase/    DB 스키마 마이그레이션 + Edge Functions (동기화 · 활동 상세)
├─ openclaw/    OpenClaw 스킬 (디스코드에서 훈련 분석 → MeOS 자동 등록)
├─ docs/        설계 문서
└─ .env.local   시크릿 (git 제외) — 아래 참고
```

## 사전 준비

`.env.local` (저장소 루트, git 제외) 에 아래 값이 필요:

```
VITE_SUPABASE_URL=...            # Supabase Project URL
VITE_SUPABASE_ANON_KEY=...       # Supabase anon key
INTERVALS_ATHLETE_ID=...         # intervals.icu athlete id (서버/동기화용, 브라우저 미노출)
INTERVALS_API_KEY=...            # intervals.icu API key (서버/동기화용)
```

> `VITE_` 접두사만 브라우저에 노출됨. intervals.icu 키는 접두사가 없어 클라이언트로 새지 않음.

### Supabase 초기 설정 (최초 1회)

1. **스키마 적용**: 대시보드 → SQL Editor → `supabase/migrations/` 의 `.sql` 을 **번호순으로** 실행
   (`0001_init` → `0002_races` → `0003_hr_zones` → `0004_calendar` → `0005_work`). 모두 재실행 안전.
   `0006_cron_sync` 는 자동 동기화용 — 아래 [동기화](#동기화-supabase-edge-function) 참고 (선택).
2. **인증 URL 등록**: Authentication → URL Configuration
   - Site URL: `http://localhost:5173`
   - Redirect URLs 에 `http://localhost:5173` 추가 (배포 후 배포 URL도 추가)
3. **첫 로그인**: 계정이 없으면 로그인 화면에서 *메일 링크로 로그인* 으로 한 번 들어간 뒤,
   **설정 → 계정**에서 비밀번호를 정한다. 이후로는 이메일 + 비밀번호로 로그인한다.
   (Supabase 기본 메일은 시간당 2~4통 제한이라 매직링크는 복구용으로만 쓴다)

## 동기화 (Supabase Edge Function)

intervals.icu(활동·웰니스·대회)와 구글 캘린더를 Supabase DB 로 당겨오는 일은
**Edge Function `supabase/functions/sync`** 하나가 전담한다. 구현이 여기 한 벌뿐이고,
앱의 새로고침 버튼·CLI·cron 이 모두 이걸 부른다.

> 예전엔 PC 에서 로컬 서버(`server/sync-server.mjs`)를 띄워야 동작했다. 그래서 배포된 웹·모바일·exe
> 에서는 `/api` 가 없어 쓸 수 없었다. 지금은 어디서 열든 같은 함수를 부른다.

함수는 두 개다.

| 함수 | 하는 일 |
|---|---|
| `sync` | intervals.icu + 구글 캘린더 → Supabase (앱 버튼 · CLI · cron) |
| `activity` | 활동 하나의 **랩·데이터 추이**를 intervals.icu 에서 그때그때 가져온다 (훈련 상세 화면) |

> `activity` 는 DB 에 넣지 않고 볼 때만 부른다 — 스트림 원본이 활동 하나에 300KB 를 넘어 쌓기엔 과하고,
> intervals.icu 키는 서버 전용이라 브라우저에서 직접 부를 수도 없다. 응답은 700포인트로 줄여 약 50KB.

### 배포 (최초 1회 + 함수를 고칠 때마다)

```bash
npx supabase login                                  # 브라우저로 1회 인증
npx supabase link --project-ref ggtnaqmmdjcfhkqzjhty
npx supabase secrets set --env-file supabase/.env.secrets   # 시크릿 등록
npm run functions:deploy                            # = supabase functions deploy sync activity
```

- `supabase/.env.secrets` 는 `.env.local` 에서 복사해 만든 파일이고 **git 에서 제외**돼 있다
  (`INTERVALS_ATHLETE_ID` · `INTERVALS_API_KEY` · `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`).
- `SUPABASE_URL` · `SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` 는 **자동 주입**되므로 등록하지 않는다.

### 실행 방법

| 어디서 | 어떻게 | 인증 |
|---|---|---|
| 앱 (PC·모바일) | 운동 화면 **↻ 새로고침** | 로그인 세션 JWT → 내 데이터 |
| CLI | `npm run sync` / `sync-intervals.bat` | `.env.local` 의 service_role 키 |
| 자동 | pg_cron (아래) | Vault 에 넣어둔 service_role 키 |

**평소엔 최근 60일치만** 당긴다 (자주 눌러도 가볍다). 과거 전체를 채우려면 운동 화면의
**전체 기간** 버튼, 또는 `npm run sync:full`.

### 자동 실행 (선택)

PC 가 꺼져 있어도 최신을 유지하려면 `supabase/migrations/0006_cron_sync.sql` 을 SQL Editor 에서 실행한 뒤,
키를 **Vault 에 한 번** 넣는다 (저장소에 키를 남기지 않으려고 이렇게 나눴다):

```sql
select vault.create_secret('<service_role 키>', 'sync_service_key');
select vault.create_secret('https://ggtnaqmmdjcfhkqzjhty.supabase.co/functions/v1/sync', 'sync_function_url');
```

기본 주기는 **매시 정각**. 바꾸려면 `cron.schedule('meos-sync', '<cron 식>', …)` 만 다시 실행하면 된다.
Vault 에 값이 없으면 cron 은 조용히 넘어가므로, 마이그레이션만 먼저 돌려도 깨지지 않는다.

> 대시보드 **Integrations → Cron** 에서 GUI 로 잡아도 된다 (인증을 알아서 처리해 준다).

> **인증은 게이트웨이에 맡긴다.** `verify_jwt = true` 라 서명·만료 검증이 끝난 뒤에 함수가 호출되므로,
> 함수 안에서는 JWT 클레임(`sub`/`role`)만 읽는다 (`supabase/functions/_shared/auth.ts`).
> 예전엔 `/auth/v1/user` 로 한 번 더 물어봤는데, 그건 "세션이 아직 살아 있는가" 를 확인하는 것이라
> 다른 기기에서 로그아웃하거나 `admin.signOut(global)` 이 한 번 돌면 **멀쩡한 토큰인데도 401** 이 났다.
> 앱의 나머지(PostgREST)는 같은 토큰으로 잘 동작해서 증상이 특히 헷갈렸다.

### 함수 고칠 때

`deno` 로 타입 검사와 로컬 실행이 된다 (Docker 불필요):

```bash
npx deno@2 check supabase/functions/sync/index.ts
```

## 훈련 분석 — 규칙 기반 + 외부 AI

훈련 상세 화면에는 분석이 **두 층**으로 붙는다.

| | 무엇 | 어디서 |
|---|---|---|
| **NSM 규칙 기반 분석** | LTHR 초과율 · 반복 편차 · 드리프트 · 페이스 유지 · 목표존 적중 · 회복 · 지난 세션 대비 | 화면에서 즉석 계산 (`web/src/lib/nsm.ts`) — **AI 아님**, 오프라인·즉시·항상 같은 결과 |
| **AI 코멘트** | 문장으로 된 조언 | 외부 에이전트가 써 넣는다 (아래) |

> "반복"을 고를 때 intervals.icu 의 **그룹 정보(`group_id`)** 를 쓴다. 랩 종류(`type`)는 워밍업·쿨다운까지
> 죄다 `WORK` 로 오기 때문에 그대로 쓰면 조깅과 인터벌이 섞여 편차·적중률이 엉망이 된다.
> 그룹을 쓰면 `284s@165bpm × 6` 처럼 실제 반복만 잡힌다.

### AI 코멘트 넣기 (OpenClaw · 디스코드 등)

**MeOS 가 에이전트를 부르지 않는다. 에이전트가 MeOS 로 보낸다.** 그래서 집 PC 를 인터넷에 열
필요가 없다 (포트포워딩·터널·고정IP 전부 불필요).

Edge Function `note` 가 창구이고, 인증은 **공유 토큰** `MEOS_NOTE_TOKEN` 이다.

```
GET  /functions/v1/note?recent=1   → 최근 활동 20개 (어떤 걸 분석할지 고르기)
GET  /functions/v1/note?id=<활동id> → 그 훈련의 요약 + 랩 + 기존 코멘트
POST /functions/v1/note            → {"id": "...", "content": "...", "model": "..."} 저장
```

호출 예시 (헤더는 `x-meos-token` 또는 `Authorization: Bearer` 둘 다 받는다):

```bash
BASE=https://ggtnaqmmdjcfhkqzjhty.supabase.co/functions/v1/note

# 1) 분석할 훈련 고르기
curl -s "$BASE?recent=1" -H "x-meos-token: $MEOS_NOTE_TOKEN"

# 2) 그 훈련 자료 받기 (여기까지가 LLM 에게 줄 재료)
curl -s "$BASE?id=i174540791" -H "x-meos-token: $MEOS_NOTE_TOKEN"

# 3) LLM 이 쓴 코멘트 올리기 → MeOS 훈련 상세에 바로 표시된다
curl -s -X POST "$BASE" -H "x-meos-token: $MEOS_NOTE_TOKEN"   -H 'Content-Type: application/json; charset=utf-8'   -d '{"id":"i174540791","model":"gpt-5.4","content":"..."}'
```

- 같은 활동에 다시 POST 하면 덮어쓴다 (`source` 별로 하나씩 — 기본 `openclaw`).
- 토큰을 바꾸려면 `npx supabase secrets set MEOS_NOTE_TOKEN=<새 값>`.
- **OpenClaw 를 쓴다면 위 curl 을 직접 칠 필요 없다** — [`openclaw/`](openclaw/) 에 스킬이 있다.
  디스코드에서 "오늘 훈련 어때?" 하면 분석하고 MeOS 에 자동으로 올린다.
- 이 함수만 `verify_jwt = false` 다 — 에이전트에는 사람 세션이 없어서, 대신 함수 안에서
  토큰을 직접(타이밍 안전 비교로) 검사한다.

> **왜 브라우저에서 OpenClaw 를 직접 부르지 않나**: MeOS 는 https 로 서비스되는데 `ws://집IP:18789`
> 같은 평문 연결은 브라우저가 막는다(mixed content). https 로 뚫으면 되긴 하지만, 그러려면
> **파일을 읽고 명령을 실행하는 에이전트를 인터넷에 노출**해야 한다. 위 방식은 그럴 필요가 없다.

### 업무 탭 — Redmine / JIRA 연결 (선택, PC 전용)

업무 화면의 **BTS 섹션**만 데스크톱 앱에서 동작한다 (진행 중인 업무·할 일·루틴은 모바일에서도 사용 가능).
데스크톱 앱을 켜고 **설정 → BTS 연결 (Redmine / JIRA)** 에서 입력하면 OS 암호화로 이 PC에만 저장된다.

- Redmine: 주소 + API 키 (Redmine → 내 계정 → API 액세스 키). 사내 HTTPS 인증서 오류가 나면 *사설 인증서 허용* 체크.
- JIRA: 주소(`https://회사.atlassian.net`) + 이메일 + API 토큰 (id.atlassian.com → API 토큰).

설정 화면 대신 `.env.local` 에 넣어도 폴백으로 읽는다 (개발 편의용):

```
REDMINE_URL=...
REDMINE_API_KEY=...
JIRA_URL=...
JIRA_EMAIL=...
JIRA_API_TOKEN=...
```

### Perforce 탭 (선택, PC 전용)

`p4` CLI 가 설치돼 있어야 하고 사내망 + 로컬 워크스페이스가 필요하다.
**설정 → Perforce + 사내 LLM** 에서 지정한다.

- **서버 / 사용자** — 비워두면 이 PC의 `p4 set` 값을 쓴다. 다르면 직접 입력 (예: `10.10.10.223:1666`).
- **워크스페이스** — [목록 불러오기] 로 고른다. 이 서버는 계정이 공용이라 워크스페이스로 사용자를 구분하며,
  **선택한 워크스페이스의 체인지리스트만** 표시된다. 워크스페이스는 Host 로 잠겨 있어 이 PC에서 쓸 수 있는 것만 걸러 보여준다.
- **서밋 로그 이름** — 로그 맨 앞 `[김건훈]` 에 들어갈 이름. 같은 파일의 과거 서밋 중 이 이름이 있는 것에서
  **컨텐츠명**(`[김건훈][토너먼트]`)과 **작업번호**(`- #29580`)를 찾아 양식을 맞춘다.
- **사내 LLM** — 서밋 로그 작성용. `.env.local` 폴백:

```
LOCAL_LLM_BASE_URL=https://llm.aquatree.games/v1
LOCAL_LLM_API_KEY=...
P4PORT=10.10.10.223:1666
P4USER=client
P4WORKSPACE=client_dk_home
P4_USER_NAME=김건훈
```

서밋 로그는 이런 양식으로 나온다:

```
[김건훈][토너먼트]
- #29580
- 메뉴 탭 숨김 처리 수정 : WBP 에서 탭이 오버레이로 한 번 더 감싸여 있어 …
- WBP : 토너먼트 메인 UI 구성 수정
```

`.uasset` 같은 바이너리는 diff 가 안 되므로 파일 종류 + 한 줄 요약만 적는다.
작업번호는 **과거 이력에서 확인된 것만** 쓴다 (모델이 지어낸 번호는 버린다).

> 서밋 로그는 **사내 LLM** 에서 처리되므로 diff(소스코드)가 회사 밖으로 나가지 않는다.
> 파일 이동(`p4 reopen`)과 CL 설명 저장은 Perforce 에 **쓰기**를 한다. 서밋은 구현하지 않았다.

> 이 토큰들과 BTS 이슈 목록은 클라우드로 전송되지 않는다. 다만 *진행 중인 업무로 끌어다 놓은 항목*은
> PC·모바일 공용으로 보기 위해 Supabase 에 저장된다 (`docs/SPEC.md` §2 원칙 변경 참고).

## 개발

```bash
npm install -w web      # web 의존성 설치 (최초 1회)
npm run dev             # Vite dev 서버 → http://localhost:5173
npm run build           # 타입체크 + 프로덕션 빌드
```

> 동기화 서버를 따로 띄우지 않는다 — Edge Function 이 맡는다 (위 참고).

### 데스크톱(Electron)

```bash
npm install -w electron           # electron 설치 (용량 큼, 최초 1회)
npm run dev                       # (터미널 1) Vite dev 서버
npm run desktop                   # (터미널 2) Electron 창 실행
```

데스크톱 앱은 **화면을 자체적으로 들고 있지 않다.** 셸(창·트레이·단축키·p4·BTS)만 담고,
보여줄 화면은 주소로 불러온다.

| 실행 방식 | 불러오는 곳 |
|---|---|
| `npm run desktop` (저장소에서) | `http://localhost:5173` — Vite dev 서버 |
| 설치한 exe | **설정에 저장된 배포 주소** → 없으면 `.env.local` 의 `MEOS_APP_URL` → 그래도 없으면 주소 입력 화면 |

`MEOS_APP_URL` 환경변수를 주면 어느 쪽이든 그걸 우선한다 (일회성 테스트용).

> preload 는 주소와 무관하게 붙으므로, 원격 화면에서도 `window.desktop`(BTS · Perforce · 스니펫 ·
> 트레이 · 전역 단축키)이 그대로 동작한다. 대신 그 브리지가 원격 페이지에 열려 있으므로
> 창이 **저장된 주소 밖으로 이동하지 못하게 막아** 두었다 (외부 링크는 기본 브라우저로 넘긴다).

### exe 만들기 (Windows)

```bash
npm run dist:win     # → dist-desktop/
```

| 결과물 | 용도 |
|---|---|
| `MeOS-Setup-0.1.0.exe` | 설치본 (시작 메뉴 등록, `privateplanner://` 딥링크 등록) |
| `MeOS-0.1.0-portable.exe` | 설치 없이 바로 실행 |

**첫 실행 때 배포 주소를 한 번 입력**하면 이후로는 바로 열린다. 설정 → **앱 주소** 에서 바꿀 수 있다.

- 설정값·스니펫·토큰은 `%APPDATA%\@pp\desktop` 에 있어 **개발 모드와 exe 가 같은 것을 쓴다** (다시 설정할 필요 없음).
- `.env.local` 폴백이 필요하면 exe 옆이나 `%APPDATA%\@pp\desktop` 에 두면 된다.
- **화면을 고쳤을 땐 exe 를 다시 만들 필요가 없다** — `git push` 후 배포가 끝나면 앱만 다시 열면 된다.
  exe 재빌드는 `electron/` 안(창·트레이·p4·BTS)을 고쳤을 때만 필요하다.

> 운동 동기화 버튼은 exe·모바일에서도 동작한다 — Supabase Edge Function 을 부르기 때문이다
> (위 [동기화](#동기화-supabase-edge-function) 참고).

> `npm run dist:win` 은 아이콘(`icon.ico`) 생성 → winCodeSign 캐시 준비 → 패키징 순으로 돈다.
> 가운데 단계는 Windows 전용 우회다: winCodeSign 아카이브에 macOS 심볼릭 링크가 들어 있는데
> Windows 는 개발자 모드 없이 심링크를 못 만들어 압축 해제가 통째로 실패한다.
> `scripts/prefetch-wincodesign.mjs` 가 `darwin/` 만 빼고 직접 풀어 캐시에 넣는다.

## 모바일 (Android) — PWA

웹 코드를 그대로 쓴다. 별도 앱 코드가 없고, 빌드 결과물(`web/dist`)을 정적 호스팅에 올린 뒤
휴대폰 Chrome 에서 **홈 화면에 추가**하면 주소창 없는 앱처럼 실행된다.

**모바일에서 쓸 수 있는 것**: 업무(진행 중인 업무 · 할 일 · 루틴) · 캘린더 · 운동 · 리포트 · 휴지통
**PC 전용**(모바일에선 자동으로 숨겨지거나 안내로 대체): BTS · Perforce · 바로가기 · 스니펫 · Quick Search

### 1) 빌드

```bash
npm run icons   # 아이콘 재생성 (디자인 바꿀 때만)
npm run build   # → web/dist (manifest + 서비스워커 포함)
```

### 아이콘 바꾸기

`icons/` 폴더의 **컨택트 시트**(마젠타 배경에 여러 크기가 배치된 원본)를 교체하고 `npm run icons` 를 실행하면
필요한 크기로 자동 변환된다.

| 원본 | 모양 | 만들어지는 것 |
|---|---|---|
| `icons/android_meos_icons.png` | 라운드 사각형 | `icon-192` · `icon-512` · `icon-maskable-512` |
| `icons/favicon_meos.png` | 원형 | `favicon-32` · `apple-touch-icon` |
| `icons/window_meos_icons.png` | 라운드 사각형 | `electron/tray-icon` · `electron/app-icon` |

스크립트(`scripts/make-pwa-icons.mjs`)가 하는 일:
1. 시트에서 **마젠타가 아닌 덩어리를 찾아** 가장 큰 아이콘을 고른다 (크기·정사각형 비율로 라벨 글자는 걸러냄)
2. 잘라낸 뒤 **마젠타를 투명으로** 바꾼다 — 경계 픽셀은 배경 성분을 걷어내 색 번짐(fringe)을 없애고,
   리사이즈 후 되살아나는 잔상까지 한 번 더 청소한다
3. 용도별 크기로 리사이즈해 저장

> **maskable 아이콘**은 안드로이드가 원형·사각 등으로 잘라내므로 규칙이 다르다.
> 투명 영역이 있으면 아이콘이 작게 떠 보이기 때문에 **배경을 꽉 채우고**, 링·글자는 안전영역
> (중앙 80% 원) 안에 두며, 잘려도 되는 모서리만 밖으로 나가게 한다.

### 2) 배포 — Cloudflare Workers (GitHub 연동)

**`git push` 하면 Cloudflare 가 알아서 빌드·배포한다.** 따로 할 일이 없다.

저장소: `github.com/dunkhoon/MeOS` (Private) → Cloudflare Workers 프로젝트 `meos` 에 연결돼 있다.

Cloudflare 대시보드 설정 (최초 1회, 이미 완료):

| 항목 | 값 |
|---|---|
| Build command | `npm install && npm run build` |
| Root directory | *(비움 — 모노레포라 루트에서 빌드)* |
| 환경변수 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1` |

출력 경로는 대시보드가 아니라 **`wrangler.toml` 의 `[assets] directory`** 가 정한다.
UI 가 자주 바뀌어 파일로 고정해 두는 편이 안전하다.

> ⚠️ **Pages 가 아니라 Workers 다.** 배포 명령이 `wrangler deploy`(Workers)라
> Pages 전용 설정(`pages_build_output_dir`)은 먹지 않는다. 주소도 `*.workers.dev` 다.

- **HTTPS 자동** — Cloudflare 가 인증서를 발급·갱신한다.
- **SPA 리다이렉트 불필요** — `HashRouter`(`/#/tasks`)라 서버는 `index.html` 하나만 주면 된다.
  (`wrangler.toml` 에 `not_found_handling` 을 켜 두긴 했다 — 나중에 라우터를 바꿔도 안전하도록)
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 은 빌드에 필요 없는 200MB Electron 바이너리를 건너뛴다.

로컬에서 바로 올리고 싶으면 `npm run deploy` (빌드 + `wrangler deploy`).

> 데스크톱 앱도 이 주소를 띄우므로 **한 번 배포하면 PC·모바일이 같이 갱신된다.**

> 공개 URL 이지만 데이터는 안전하다. 접속하면 로그인 화면만 보이고,
> 실제 데이터는 Supabase 인증 + RLS(본인 데이터만 접근)로 보호된다.
> 번들에 들어가는 `VITE_SUPABASE_ANON_KEY` 는 공개를 전제로 설계된 키다.

### 3) Supabase 리다이렉트 URL 등록

Supabase 대시보드 → Authentication → URL Configuration → **Redirect URLs** 에 배포 주소 추가:

```
https://meos.<계정>.workers.dev
```

비밀번호 로그인만 쓴다면 없어도 되지만, **복구용 매직링크가 동작하려면 필요하다.**

### 4) 휴대폰에서 설치

Chrome 으로 배포 주소 접속 → 메뉴 → **홈 화면에 추가**(또는 자동으로 뜨는 설치 배너).
설치 후에는 아이콘으로 실행되고 주소창 없이 전체화면으로 뜬다.

> 업데이트는 재배포만 하면 된다. 다음에 앱을 열 때 서비스워커가 자동으로 새 버전을 받는다.

### APK 로 만들려면 (선택)

Capacitor 로 같은 `web/dist` 를 감싸면 APK 가 나온다. PWA 작업이 그대로 재사용되므로
지금 한 작업이 헛되지 않는다. 다만 Android Studio + JDK 설치가 필요하고,
고칠 때마다 APK 를 다시 빌드·설치해야 한다.

## 현재 상태

- **Phase 0 스캐폴딩 / 1 운동 / 2 캘린더 / 3 업무+휴지통**: 완료.
- 다음: Phase 4 (대시보드 홈 위젯) → 5 (리포트 자동 요약) → 6 (PWA/배포). 로드맵은 `docs/SPEC.md` §10.
