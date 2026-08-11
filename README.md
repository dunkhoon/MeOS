# MeOS

개인 통합 대시보드 (Personal OS). 설계 문서는 [`docs/SPEC.md`](docs/SPEC.md) 참고.

## 구조 (모노레포)

```
MeOS/  (저장소 폴더는 PrivatePlanner)
├─ web/         React + TS + Vite (PC·모바일 공용 UI)
├─ electron/    데스크톱 셸 (+ 회사 업무 Redmine/JIRA 실시간 조회 담당)
├─ supabase/    DB 스키마 마이그레이션
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
2. **인증 URL 등록**: Authentication → URL Configuration
   - Site URL: `http://localhost:5173`
   - Redirect URLs 에 `http://localhost:5173` 추가 (배포 후 배포 URL도 추가)

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

### 데스크톱(Electron)

```bash
npm install -w electron           # electron 설치 (용량 큼, 최초 1회)
npm run dev                       # (터미널 1) Vite dev 서버
npm run desktop                   # (터미널 2) Electron 창 실행
```

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

### 2) 배포 — Cloudflare Pages

이 저장소는 git 저장소가 아니므로 **Wrangler 로 직접 업로드**한다 (GitHub 연동 불필요).

```bash
npx wrangler login          # 최초 1회 — 브라우저가 열리며 Cloudflare 로그인
npm run deploy              # 빌드 + 업로드 (= build 후 wrangler pages deploy)
```

끝나면 `https://meos.pages.dev` 같은 주소가 출력된다. 이후 배포는 `npm run deploy` 한 번이면 된다.

- **HTTPS 는 자동이다.** `*.pages.dev` 는 Cloudflare 가 인증서를 알아서 발급·갱신한다. 설정할 것이 없다.
- **SPA 리다이렉트 설정 불필요.** 이 앱은 `HashRouter`(`/#/tasks`)를 써서 서버는 `index.html` 하나만
  주면 되기 때문. (`BrowserRouter` 였다면 `_redirects` 파일이 필요했다.)
- **환경변수 설정 불필요.** `VITE_*` 값은 `npm run build` 시점에 번들에 박히므로
  Cloudflare 쪽에 따로 넣을 게 없다. 로컬에서 빌드해 올리는 구조다.

> 공개 URL 이지만 데이터는 안전하다. 접속하면 로그인 화면만 보이고,
> 실제 데이터는 Supabase 인증 + RLS(본인 데이터만 접근)로 보호된다.
> 번들에 들어가는 `VITE_SUPABASE_ANON_KEY` 는 공개를 전제로 설계된 키다.

### 3) Supabase 리다이렉트 URL 등록 (필수)

Supabase 대시보드 → Authentication → URL Configuration → **Redirect URLs** 에 배포 주소 추가:

```
https://<배포주소>
```

이걸 빠뜨리면 매직링크를 눌러도 로그인이 안 된다. 로그인 코드는 `window.location.origin` 을
쓰므로 배포 주소가 바뀌면 여기도 같이 바꿔야 한다.

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
