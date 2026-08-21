# MeOS — 프로젝트 지침

개인 통합 대시보드("Personal OS"). 상세 설계는 `docs/SPEC.md`, 실행법은 `README.md` 참고.

## 작업 규칙

### 🔄 LLM Wiki 동기화 (필수)

이 프로젝트에 **실질적 변경**이 생기면, 그 작업을 끝내기 전에 **반드시 LLM Wiki도 함께 갱신**한다.

- **대상 페이지**: `C:\Users\KIM GUN HOON\Documents\Obsidian Vault\LLM Wiki\PrivatePlanner.md`
- **갱신해야 하는 "실질적 변경"**: 새 모듈/기능, 데이터 모델·DB 스키마 변경, 아키텍처·기술스택 결정, 외부 연동 추가/변경, Phase 완료, 중요한 설계 결정.
- **갱신 방법**:
  1. `PrivatePlanner.md`의 해당 섹션(진행 상황·모듈·데이터 모델·결정 등)을 수정하고, 프론트매터 `updated` 날짜를 갱신한다. **기존 페이지를 갱신**하며 새 페이지를 만들지 않는다.
  2. `C:\Users\KIM GUN HOON\Documents\Obsidian Vault\LLM Wiki\log.md` 에 한 줄 추가:
     `YYYY-MM-DD | INGEST | <무엇을 바꿨는지 한 줄> | pages: [[PrivatePlanner]]`
  3. `docs/SPEC.md`가 크게 바뀌었으면 `LLM Wiki/sources/PrivatePlanner-SPEC-<날짜>.md` 로 새 스냅샷을 남긴다.
- **하지 말 것**: 오타 수정·리팩터·사소한 스타일 변경 같은 trivial 작업으로는 위키를 갱신하지 않는다(로그 노이즈 방지).

> 위키 스키마/규칙 전체는 `LLM Wiki/CLAUDE.md` 참고. 커맨드: `/wiki-query`, `/wiki-ingest`, `/wiki-lint`.

### 🔧 OpenClaw 플러그인 — 소스를 고치면 `dist/` 도 같은 커밋에

`openclaw plugins install` 은 **TypeScript 를 빌드하지 않는다.** 폴더를 그대로 복사할 뿐이라
`dist/` 가 낡으면 **설치가 "성공" 이라고 표시하면서 옛 코드가 그대로 깔린다**(조용해서 못 알아챈다 —
2026-08-21 에 이걸로 오래 헤맸다).

- `openclaw/plugins/*/dist/` 는 **저장소에 커밋한다**(루트 `.gitignore` 의 `dist/` 에 예외를 파 뒀다).
- 빌드: `cd openclaw/plugins/<이름> && npm run build` (`tsc -p tsconfig.build.json`, `noCheck` — 내보내기 전용).
- `.githooks/pre-commit` 이 자동으로 빌드해 커밋에 담는다. **새 클론에서는 한 번만**:
  `git config core.hooksPath .githooks`
- 설치본에 반영됐는지: `grep -rl <고친_코드_조각> ~/.openclaw/extensions/<이름>/`

## 핵심 사실 (요약)

- **스택**: React + TS + Vite / Electron / Supabase(Postgres+Auth 매직링크). 차트 Recharts.
- **원칙**: 모든 외부 연동 읽기 전용. 데이터 2계층 — 개인 데이터=클라우드 저장(PC+모바일), 회사 업무(Redmine/JIRA)=데스크톱 전용·휘발.
- **로컬 실행**: `start-dev.bat` 또는 `npm run dev` (→ http://localhost:5173). intervals.icu 동기화: `sync-intervals.bat`.
- **시크릿**: 루트 `.env.local` (git 제외). `service_role` 키는 서버/스크립트 전용.
