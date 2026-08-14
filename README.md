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
| `activity` | 활동 하나의 **랩·데이터 추이·GPS 경로**를 intervals.icu 에서 그때그때 가져온다 (훈련 상세 화면) |

> `activity` 는 DB 에 넣지 않고 볼 때만 부른다 — 스트림 원본이 활동 하나에 300KB 를 넘어 쌓기엔 과하고,
> intervals.icu 키는 서버 전용이라 브라우저에서 직접 부를 수도 없다.
> 응답은 추이 700포인트(≈50KB) + 경로 2000포인트(≈40KB)로 줄인다.

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

### 러닝화 (Garmin) — 선택

**intervals.icu 는 Garmin 의 gear 를 못 가져온다.** Garmin Connect 에서 FIT 파일만 받기 때문이다
(intervals.icu 개발자 확인, 2026-06). 그래서 러닝화만 Garmin 을 직접 본다.

Garmin 은 개인용 공식 API 가 없고 2026-03 에 인증까지 바꿔 기존 라이브러리(garth)가 막혔다.
그래서 **로그인만 PC 에서 1회**, 이후 조회는 Edge Function 이 한다 → 모바일에서도 보인다.

```bash
pip install -U garminconnect
python scripts/garmin-login.py      # 이메일·비밀번호·(MFA) → garmin-tokens.json
```

생긴 `garmin-tokens.json` 을 `integration_tokens` 테이블에 넣으면 끝이다 (git 제외 파일):

```sql
-- SQL Editor. <토큰 JSON> 자리에 파일 내용을 그대로.
insert into integration_tokens (user_id, provider, tokens, expires_at)
select id, 'garmin', '<토큰 JSON>'::jsonb, now() + interval '20 hours' from auth.users limit 1
on conflict (user_id, provider) do update set tokens = excluded.tokens, expires_at = excluded.expires_at;
```

- 이후 **새로고침·전체 기간** 을 누르면 러닝화도 같이 동기화된다. cron 은 30분 간격으로 제한한다
  (비공식 API 라 호출을 아낀다).
- ⚠️ **refresh token 은 갱신할 때마다 값이 바뀌고 유효기간이 30일**이다. 그래서 시크릿이 아니라 DB 에 두며
  (함수가 시크릿을 못 쓴다), 30일 넘게 동기화가 없으면 위 로그인을 다시 해야 한다.
- 신발↔활동 매칭은 추정이 아니다 — **intervals.icu 활동의 `external_id` 가 곧 Garmin 활동 id** 라 정확히 붙는다.
- Garmin 에서 **비활성(은퇴)** 처리한 신발은 목록에서 숨긴다. 카드 우측 **비활성 N 보기** 로 펼칠 수 있고
  선택은 기억한다.
- 사진은 안 가져온다. Garmin 이 `imageName*` 을 전부 null 로 주기 때문이다.

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

## 모바일 레이아웃

390 / 360 / 320px 폭에서 전 화면을 훑어 **가로 넘침·칸 밖으로 삐져나감·잘림·작은 버튼**을 검사한다.

⚠️ **그리드·플렉스 칸의 기본 `min-width` 는 `auto`(=내용 최소폭)다.** 안에 `white-space: nowrap` 글자가
하나라도 있으면 칸이 그 아래로 못 줄어들어 표 전체가 컨테이너 밖으로 밀린다. 좁은 화면에서 배치가
틀어지는 원인의 대부분이 이것이다. `min-width: 0`(또는 `overflow: hidden`)으로 풀어야 `1fr` 이 실제로
균등 분할된다. `.card` · `.tcal-cell` · `.tcal-dow` 에 걸어 뒀다.

⚠️ `flex-shrink: 0` 은 좁은 화면에서 **줄바꿈 자체를 막는다.** 줄어들 수 없으면 `flex-wrap` 도 안 걸린다 —
`.card-actions` 는 넓은 화면에서만 고정하고 768px 이하에서는 풀어 준다.

- 좁은 칸에 글자를 우겨넣는 대신 **색으로 바꾼다.** 한 칸이 20~45px 인 화면에서 제목을 넣으면
  `[26…` / `RE…` 만 남아 아무 정보가 없다. 색이면 종류와 개수가 그대로 읽히고 누르는 자리도 살아 있다.
  - 캘린더 월 그리드의 일정 → **색 점**
  - 훈련 캘린더의 세션 라벨 → **색 막대** (보이는 건 4px, 손가락이 닿는 자리는 14px —
    `height: 14px; padding: 5px 0; background-clip: content-box`). 종류 이름은 아래 범례에서 본다.
- 터치 기기(`@media (pointer: coarse)`)에서는 작은 버튼들을 최소 36px 로 키운다. 마우스 화면은 그대로.
- **직접 띄우는 툴팁은 화면 안으로 당겨야 한다.** Fitness 범례 설명(`.metric-tip`)은 항목 가운데에
  `translateX(-50%)` 로 붙는데, 가장자리 항목에서는 그대로 화면 밖으로 나갔다. 최대 폭 기준으로
  중심을 clamp 한다 (`FitnessPanel.tsx` 의 `TIP_MAX`/`TIP_EDGE` 는 CSS `max-width` 와 같은 값).

⚠️ **모달 덮개를 `display: grid; place-items: center` 로 만들면 암묵 트랙이 내용 *최대폭*으로 부푼다.**
그러면 안쪽의 `max-width: 100%` 가 화면이 아니라 그 부푼 트랙 기준이 되어 모달이 화면 밖으로 나간다
(390px 화면에서 380px 모달이 x=16 에서 시작해 396 까지). `flex` 는 컨테이너를 넘겨 늘어나지 않는다.
모달 자체에는 `max-height: calc(100dvh - 32px)` + `overflow-y: auto` 를 줘야 길어졌을 때 아래가 잘리거나
하단 탭바에 가리지 않는다.

⚠️ `word-break: keep-all`(한국어 단어 안 쪼개기)은 **쓰지 않는다.** 줄바꿈 지점이 사라져
업무·휴지통의 버튼줄이 카드 밖으로 나갔다. 단어가 갈리는 것보다 넘치는 쪽이 더 나쁘다.

- 러닝화 상세의 활동 목록은 560px 이하에서 **두 줄**로 나눈다(위: 종류·이름 / 아래: 날짜·페이스·거리).
  ⚠️ 이 미디어쿼리는 `.shoe-act` 기본 규칙보다 **뒤**에 와야 한다 — 미디어쿼리는 우선순위를 더하지 않아서
  앞에 두면 나중에 나오는 `display: flex` 에 그대로 덮인다.

## 테마 (10종)

**설정 → 테마**에서 고른다. 에디터에서 널리 쓰이는 테마의 **공식 팔레트**를 그대로 옮겼다 —
어두움: MeOS 기본 · Catppuccin Mocha · Dracula · Tokyo Night · Nord · Gruvbox Dark · One Dark /
밝음: Catppuccin Latte · GitHub Light · Solarized Light.

- 색은 전부 `web/src/index.css` 의 `:root[data-theme=…]` 블록에 있다. `lib/theme.ts` 는 목록과 적용 함수만 갖는다.
- 각 블록이 `[data-swatch=…]` 에도 걸려 있어 **설정 화면 미리보기가 같은 팔레트를 재사용**한다. 색을 두 벌 적을 필요가 없다.
- 선택은 `localStorage`(`pp:theme`). `index.html` 의 인라인 스크립트가 **첫 페인트 전에** 입혀 번쩍임이 없다.
- 토큰은 표면(`--bg` / `--bg-elev` / `--bg-card` / `--border` / `--text` / `--muted`), 브랜드(`--accent` / `--on-accent`),
  색상환 8개(`--h-red` … `--h-pink`). 의미(`--ok` `--warn` `--danger` `--info`)는 색상환에 엮은 별칭이다.

⚠️ **활동 종류·세션 종류 색에는 `--accent` 를 쓰지 않는다.** 테마 10개 중 8개가 액센트로
팔레트의 색 하나를 그대로 쓴다(GitHub Light 는 액센트도 `--h-blue` 도 같은 파랑). 예전처럼 Run 을
액센트로 두면 **Ride 와 같은 색**이 되어 차트에서 구분이 사라진다. 색상환 토큰만 골라 쓰면 안전하다.

⚠️ 색이 토큰이 되면서 `색 + '33'` 으로 투명도를 붙이던 코드는 전부 깨진다(`var(--x)33`).
`lib/color.ts` 의 `alpha(color, pct)`(= `color-mix`)를 쓴다.

### 칠하는 색(`--h-*`)과 글자 색(`--ink-*`)은 다르다

⚠️ **`--h-*` 를 글자색으로 그대로 쓰면 안 된다.** 그건 차트 선·점·막대를 **칠하는** 색이다.
밝은 테마에서 글자로 얹으면 최악 2.15:1, 구글 캘린더가 주는 파스텔은 **1.05:1**(흰 바탕에 흰 글자)까지
떨어진다. 반대로 Nord·Gruvbox 처럼 파스텔이 진한 어두운 테마에서도 2.46:1 이 나온다.

글자에는 `--ink-red` … `--ink-pink` / `--ink-accent` 를 쓴다. 같은 색상·채도에 **밝기(OKLCH 의 L)만**
테마별 한계(`--ink-lo` / `--ink-hi`)로 조인 값이라 "빨강은 빨강" 그대로다. 의미 토큰
(`--ok` `--warn` `--danger` `--info`)은 전부 ink 에 엮여 있으니 그냥 쓰면 된다.
JS 에서 색을 인라인으로 넣을 때는 `lib/color.ts` 의 `ink(color)` 를 통과시킨다.

- 한계값은 각 테마 팔레트 8색이 **표면 3종 + 같은 색으로 12%까지 물든 배경** 위에서 모두 4.5:1 을
  넘는 최소치를 계산해 넣었다. 팔레트를 고치면 다시 계산해야 한다.
- ⚠️ `--ink-lo` 와 `--ink-hi` 는 테마마다 **둘 다** 적는다. MeOS 블록은 `:root` 에도 걸려 있어서
  하나만 덮으면 `clamp(0.69, l, 0.44)` 처럼 min>max 가 되고, CSS 는 그때 **min 을 돌려준다** —
  밝은 테마의 색이 오히려 밝아진다(실제로 한 번 그렇게 나왔다).
- 글자가 얹히는 배경 틴트는 **12% 이하**로 둔다. 그보다 진하면 같은 색 글자가 배경에 묻힌다.
- 이번 달 밖 날짜처럼 흐리게 보여야 하는 것은 `opacity` 로 죽이지 말고 **배경·테두리를 지운다.**
  투명도는 글자와 배경을 같이 지워서 어떤 테마에서도 못 읽게 만든다(실측 1.3~1.9:1).

## 서체 — Pretendard (앱에 포함)

예전엔 서체를 지정하지 않아 OS 가 골랐다. 윈도우에서는 라틴이 Segoe UI, 한글이 **맑은 고딕**으로 갈라져
글자마다 리듬이 달랐다. 지금은 **Pretendard** 를 쓴다 (system-ui 대체용으로 만들어진 서체, SIL OFL).

- **CDN 이 아니라 앱에 같이 넣는다** — 오프라인·PWA 에서도 서체가 유지되도록.
- 전체 가변 폰트는 2MB 라 **서브셋**을 만들어 쓴다: `web/src/assets/fonts/pretendard-subset.woff2` (453KB).
  KS X 1001 완성형 2350자 + 라틴·숫자·문장부호·화살표·도형. **굵기 축(45~930)은 그대로**라 파일 하나로 9단계를 다 쓴다.
- 서브셋 밖 글자는 기존 시스템 스택으로 자연스럽게 떨어진다.
- 다시 만들려면:

  ```bash
  pip install fonttools brotli
  npm i -w web pretendard        # 원본 (devDependency)
  python scripts/make-font-subset.py
  ```

  ⚠️ 완성형 2350자를 고를 때 `euc_kr` 로 거르면 안 된다 — 파이썬의 `euc_kr` 은 완성형에 없는 글자를
  8바이트 조합형으로 인코딩해서 11172자가 전부 통과한다(서브셋이 1.7MB 가 된다). `iso2022_kr` 이 정확히 2350자만 받는다.

## 경로 지도

훈련 상세에 **GPS 경로**를 그린다 (`web/src/components/exercise/RouteMap.tsx`).

- 좌표는 intervals.icu 의 `latlng` 스트림 — 위도는 `data`, 경도는 `data2` 로 **따로** 온다.
- 솎아낼 때 평균이 아니라 **건너뛰기**로 줄인다. 좌표를 평균 내면 코너가 잘려 실제로 지나지 않은 곳을 가로지른다.
- 지도 종류 두 가지. **키·계정·비용 전부 불필요**, 선택은 `localStorage`(`pp:map:style`).
  - **자세히**(기본) — 표준 OpenStreetMap 타일. 길 등급·건물·공원·철도·지명이 다 보인다.
    어두운 테마에서는 CSS 로 살짝 눌러 준다(`.rm-soft`). ⚠️ `invert()` 로 뒤집으면 도로 색과 지명이
    같이 망가지므로 **밝기·채도만** 건드린다.
  - **단순** — CARTO(테마 밝기에 따라 `dark_all`/`light_all`). 경로만 보고 싶을 때.
- 실내 러닝·수동 입력처럼 GPS 가 없는 활동은 카드째 뜨지 않고, leaflet 청크(≈150KB)도 받지 않는다.
- 휠 확대는 기본 **끔** — 페이지를 스크롤하다 지도 위를 지날 때 화면이 멋대로 확대되지 않게. 버튼으로 켠다.

### 지도 위 표시 3가지

전부 **경과 시간(초)** 하나로 묶여 있어 서로 어긋나지 않는다.

| 표시 | 어디서 오는가 |
|---|---|
| 지나온 구간 + 현재 위치 점 | 재생 커서 |
| 작은 고리 | **그래프에 올린 마우스** 위치 |
| 굵은 노란 구간 | **랩 표에서 고른 랩** (행을 다시 누르면 해제) |

### 그래프 툴팁

그래프는 한 항목만 그리지만 툴팁에는 그 시점의 값을 **전부** 띄운다 —
페이스·심박수·고도·파워·케이던스·보행 길이·수직 비율·수직 진폭·접지 시간.
표시 규칙은 `web/src/lib/metrics.ts` 한 곳에 모아 뒀다.

- ⚠️ intervals.icu 의 케이던스는 **한쪽 발 기준(rpm)** 이다. 흔히 말하는 spm 은 그 두 배 —
  예전엔 그래프만 ×2 를 안 해서 같은 값을 93spm / 186spm 으로 다르게 보여 주고 있었다.
- ⚠️ Recharts 의 `<Tooltip content={…}>` 는 content 를 복제하면서 **자기 `active`(boolean) prop 을 덮어쓴다.**
  넘기는 prop 이름을 `active` 로 하면 조용히 사라진다 (여기서는 `activeKey`).

### 재생 (▶)

지도 아래 **재생**을 누르면 출발부터 도착까지 따라가고, **데이터 추이·랩 분석이 같이 움직인다.**

- 커서는 **경과 시간(초) 하나**뿐이다. 지도·그래프·랩이 각자 시간을 세면 반드시 어긋나므로,
  Edge Function 이 세 가지를 모두 같은 축에 실어 준다 — 경로는 `routeT`, 랩은 `startT`/`endT`
  (intervals.icu 의 `start_index`/`end_index` 를 원본 `time` 스트림으로 환산).
- 지도는 지나온 구간만 색이 살고 현재 위치에 점이 붙는다. 그래프는 지나온 부분만 칠하고 커서 선·점을 찍는다.
  랩 표는 지금 구간을 강조하고 아직 안 온 구간을 흐리게 한다.
- 1배속 = 전체를 약 30초. `1× / 2× / 4×` 와 슬라이더로 아무 데나 건너뛸 수 있다.
- 커서 갱신은 **60ms 주기**로 묶는다. 매 프레임(16ms) 갱신하면 Recharts 가 700점을 다시 그리며 버벅인다.
- 계산은 순수 함수 `web/src/lib/playback.ts` 로 분리했다(보간·랩 판정·진행 속도). 화면 없이 테스트한다.
- GPS 가 없는 활동은 지도가 없으므로 재생도 없다.

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

### AI 코드 리뷰 (Windows 전용)

CL 마다 **AI 리뷰** 버튼이 있다. 누르면 설정에 켜 둔 리뷰 모델들에게 **같은 diff 를 동시에** 보내고,
결과를 md 파일 한 벌로 이 PC에 저장한다. 저장된 리뷰는 **리뷰 보기**(그 CL) 또는 화면 위 **리뷰 기록**
(전체)에서 다시 볼 수 있고 거기서 지울 수도 있다.

리뷰 모델은 **설정 → AI 코드 리뷰 (Perforce)** 에서 1~N 개 등록한다.

| 종류 | 실행 방식 | 모델 | effort | 코드가 나가는 곳 |
| --- | --- | --- | --- | --- |
| **Codex (GPT)** | `codex exec` CLI | `gpt-5.5` 등 | low / medium / high / xhigh | 사외 (OpenAI) |
| **Claude** | `claude -p` CLI | `opus` / `sonnet` / `haiku` | low / medium / high / xhigh / max | 사외 (Anthropic) |
| **사내 LLM** | OpenAI 호환 HTTP | 게이트웨이 모델 목록 | 없음 | 사내망 안 |

- **API 키가 아니라 구독 로그인으로 돈다.** 두 CLI 는 이미 로그인해 둔 계정을 그대로 쓴다
  (`codex login` · `claude` 로그인). 그래서 main 이 자식 프로세스 환경에서
  `ANTHROPIC_API_KEY` `ANTHROPIC_BASE_URL` `OPENAI_API_KEY` 같은 값을 **일부러 지운다** —
  남아 있으면 CLI 가 로그인 대신 그 키를 쓴다.
- **실행 파일은 자동으로 찾는다** (PATH + npm 전역 설치 위치). 못 찾으면 설정에서 경로를 직접 지정한다.
  codex 는 npm 이 같이 깔아 두는 네이티브 `codex.exe` 를 우선한다(PATH 의 `codex` 는 확장자 없는
  git-bash 용 스크립트라 윈도우에서 실행되지 않는다).
- **리뷰어는 워크스페이스를 뒤지지 않는다.** 우리가 준 diff 만 보고 판단한다(`claude --tools ""`,
  `codex --sandbox read-only`). 셋이 같은 입력을 받으므로 결과를 나란히 비교할 수 있다.
- **새로 추가한 파일**(add)은 서버에 없어 `p4 diff` 가 아무것도 내놓지 않는다. 리뷰에서는 그게 오히려
  핵심이라 워크스페이스의 실제 파일을 읽어 본문을 같이 보낸다 (설정에서 끌 수 있음).
- 저장 파일명에 시각이 들어간다: `CL29580_20260814-153012.md`. 같은 CL 을 여러 번 리뷰해도 겹치지 않는다.
  기본 위치는 `%APPDATA%\MeOS\reviews`, 설정에서 바꿀 수 있다.

> ⚠️ **Codex / Claude 는 사외 서비스다.** 켜는 순간 그 CL 의 코드가 회사 밖으로 전송된다.
> 그래서 기본값은 **사내 LLM 하나**뿐이고, 화면에서도 리뷰어마다 `사내`/`사외` 를 표시하고
> 사외가 하나라도 켜져 있으면 실행 전에 경고를 띄운다. 회사 코드를 보내도 되는지는 사용자가 판단한다.

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
