-- 훈련 계획 (intervals.icu 의 WORKOUT 이벤트).
--
-- `events` 는 구글 캘린더 일정이고, `races` 는 RACE_* 이벤트다. 이건 세 번째 —
-- "이 날 이걸 하기로 했다" 는 계획이다.
--
-- ⚠️ 소화 여부는 **`paired_activity_id`** 로 안다. intervals.icu 가 계획과 실제 활동을
--    짝지어 주면 그 값이 채워진다. "그날 활동이 있으면 끝난 것" 으로 보면 안 된다 —
--    계획과 다른 걸 뛴 날이 실제로 있다(8/16: 활동은 있는데 계획과는 안 맞음).
--
-- 재실행 안전.

create table if not exists public.workouts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  external_id        text not null,                    -- intervals.icu 이벤트 id
  start_date         date not null,                    -- 계획한 날
  type               text,                             -- Run / Ride …
  name               text,
  description        text,                             -- 사람이 읽는 계획 본문 (여러 줄)

  -- 목표치
  target_load        integer,
  target_time_s      integer,
  target_distance_m  double precision,

  -- 소화한 활동. null 이면 아직 안 한 것 → 캘린더에 계획으로 띄운다.
  paired_activity_id text,

  workout_doc        jsonb,                            -- 구간 구조 (steps·zoneTimes)
  raw                jsonb,
  updated_at         timestamptz not null default now(),
  unique (user_id, external_id)
);

create index if not exists workouts_by_date on public.workouts (user_id, start_date);
-- 캘린더는 "아직 안 한 계획" 만 훑는다
create index if not exists workouts_pending
  on public.workouts (user_id, start_date)
  where paired_activity_id is null;

alter table public.workouts enable row level security;

drop policy if exists workouts_owner_all on public.workouts;
create policy workouts_owner_all on public.workouts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_workouts_updated
  before update on public.workouts
  for each row execute function public.set_updated_at();
