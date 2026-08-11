-- PrivatePlanner — 초기 스키마 (Phase 0)
-- 원칙: 클라우드 DB에는 "개인 데이터"만 저장한다.
--       회사 업무(Redmine/JIRA)는 데스크톱 실시간 조회만 하고 여기에 저장하지 않는다.

create extension if not exists "pgcrypto";

-- updated_at 자동 갱신 트리거 함수
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── events: Google Calendar 일정 ───────────────────────────
create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source       text not null default 'google',
  external_id  text,
  title        text not null,
  start_at     timestamptz not null,
  end_at       timestamptz,
  all_day      boolean not null default false,
  location     text,
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, source, external_id)
);

-- ── activities: intervals.icu 활동 ────────────────────────
create table if not exists public.activities (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  external_id       text not null,
  type              text,
  name              text,
  start_date_local  timestamptz,
  distance_m        double precision,
  moving_time_s     integer,
  average_speed     double precision,
  average_hr        integer,
  max_hr            integer,
  calories          integer,
  training_load     integer,
  device_name       text,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, external_id)
);

-- ── wellness: 일자별 컨디션 + 훈련부하 (Form = ctl - atl 로 계산) ──
create table if not exists public.wellness (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day          date not null,
  ctl          double precision,   -- Fitness
  atl          double precision,   -- Fatigue
  hrv          double precision,
  resting_hr   integer,
  sleep_secs   integer,
  sleep_score  double precision,
  steps        integer,
  weight       double precision,
  vo2max       double precision,
  raw          jsonb,
  updated_at   timestamptz not null default now(),
  primary key (user_id, day)
);

-- ── gear: 러닝화 마일리지 (소스: Garmin, 후순위) ──────────────
create table if not exists public.gear (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  external_id  text,
  name         text not null,
  type         text default 'shoes',
  distance_m   double precision not null default 0,
  retired      boolean not null default false,
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, external_id)
);

-- ── reports: 자동 주간/월간 요약 스냅샷 (개인 데이터만) ────────
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  period        text not null,          -- 'weekly' | 'monthly'
  period_start  date not null,
  summary       jsonb not null,
  created_at    timestamptz not null default now(),
  unique (user_id, period, period_start)
);

-- ── sync_state: 소스별 마지막 동기화 상태 ────────────────────
create table if not exists public.sync_state (
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source          text not null,        -- 'google' | 'intervals' | 'garmin'
  last_synced_at  timestamptz,
  status          text,
  detail          jsonb,
  primary key (user_id, source)
);

-- updated_at 트리거 (재실행 안전)
create or replace trigger trg_events_updated     before update on public.events     for each row execute function public.set_updated_at();
create or replace trigger trg_activities_updated before update on public.activities for each row execute function public.set_updated_at();
create or replace trigger trg_wellness_updated   before update on public.wellness   for each row execute function public.set_updated_at();
create or replace trigger trg_gear_updated       before update on public.gear       for each row execute function public.set_updated_at();

-- Row Level Security: 각 사용자는 본인 데이터만 접근
alter table public.events     enable row level security;
alter table public.activities enable row level security;
alter table public.wellness   enable row level security;
alter table public.gear       enable row level security;
alter table public.reports    enable row level security;
alter table public.sync_state enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['events', 'activities', 'wellness', 'gear', 'reports', 'sync_state']
  loop
    execute format('drop policy if exists %I_owner_all on public.%I;', t, t);
    execute format(
      'create policy %I_owner_all on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid());',
      t, t
    );
  end loop;
end
$$;
