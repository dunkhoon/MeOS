-- 몸상태 판단 — 오늘 훈련해도 되는지 다섯 가지 신호로 따져 본 기록.
--
-- 신호 다섯 개:
--   recovery   가민 회복 시간이 남아 있는가
--   sleep      수면 6시간 미만인가
--   hrv        HRV 가 최근 7일 기준보다 10% 이상 떨어졌는가
--   restingHr  안정시심박이 평소(28일 중앙값)보다 3bpm 이상 올랐는가
--   subjective 다리 무거움 · 국소 뻣뻣함 · 통증 (질문지 응답)
--
-- ⚠️ 판정 근거를 `signals` 에 통째로 박아 둔다. 웰니스는 나중에 다시 동기화되면서
--    값이 바뀌기도 하는데(가민이 수면·HRV 를 늦게 확정한다), 그때 캘린더의 과거 아이콘이
--    슬그머니 다른 판정으로 바뀌면 "그날 내가 왜 쉬었는지" 를 되짚을 수가 없다.
--    아이콘도 리뷰도 **판단한 순간의 값** 으로만 그린다.
--
-- ⚠️ 회복 시간은 가민이 API 로 주지 않는다 (Forerunner 255 는 Training Readiness 미지원이라
--    /metrics-service/metrics/trainingreadiness 가 빈 배열이고, 원본 FIT 에도 필드가 없다 —
--    가민이 서드파티에 넘기기 전에 비공개 필드를 지운다. 2026-09 확인).
--    그래서 시계에 뜬 값을 질문지에서 받아 **끝나는 시각**으로 바꿔 둔다. 다음 판단 때는
--    그 시각까지 남은 시간을 자동으로 계산해 기본값으로 채운다 — 매번 시계를 볼 필요가 없다.
--
-- 하루 한 건이다. 다시 판단하면 그날 것을 덮어쓴다 (최신 판단이 그날의 답).
--
-- 재실행 안전.

create table if not exists public.body_checks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  checked_at timestamptz not null default now(),

  -- good = 신호 0개 / caution = 1~2개 / bad = 3개 이상
  level       text not null check (level in ('good', 'caution', 'bad')),
  flag_count  integer not null default 0,

  -- [{ key, tripped, value, basis, detail }] — 판단 당시의 값과 기준
  signals     jsonb not null default '[]'::jsonb,
  -- { heaviness: 0|1|2, stiffness: 0|1|2, pain: 0|1|2, area: text }
  answers     jsonb not null default '{}'::jsonb,

  -- 회복 시간이 끝나는 시각. 다음 판단의 기본값을 여기서 되짚는다. 없으면 회복 완료.
  recovery_until timestamptz,

  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

create index if not exists body_checks_by_day on public.body_checks (user_id, day desc);

create or replace trigger trg_body_checks_updated
  before update on public.body_checks
  for each row execute function public.set_updated_at();

alter table public.body_checks enable row level security;

drop policy if exists body_checks_owner_all on public.body_checks;
create policy body_checks_owner_all on public.body_checks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
