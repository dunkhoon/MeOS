-- PrivatePlanner — 대회(races) 테이블 (Phase 1 확장)
-- intervals.icu 캘린더의 RACE_A/B/C 이벤트를 저장한다. (개인 데이터)

create table if not exists public.races (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  external_id   text not null,
  category      text,           -- RACE_A | RACE_B | RACE_C
  name          text not null,
  race_date     date not null,
  type          text,
  description   text,
  distance_m    double precision,
  moving_time_s integer,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, external_id)
);

create or replace trigger trg_races_updated
  before update on public.races
  for each row execute function public.set_updated_at();

alter table public.races enable row level security;

drop policy if exists races_owner_all on public.races;
create policy races_owner_all on public.races
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
