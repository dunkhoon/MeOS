-- 러닝화(Garmin gear) + 신발↔활동 매칭.
--
-- intervals.icu 는 Garmin gear 를 못 가져온다(FIT 파일만 받는다). 그래서 Garmin 을 직접 본다.
-- 조회는 Edge Function 이 하므로 **모바일에서도 보인다** (데스크톱 전용이 아니다).
--
-- 매칭 키: intervals.icu 활동의 `external_id` 가 곧 Garmin 활동 id 다. 날짜·거리 추정 없이 정확히 붙는다.
--
-- 재실행 안전.

-- ── 연동 토큰 ──────────────────────────────────────────────
-- Garmin refresh token 은 **갱신할 때마다 값이 바뀐다(회전)**. 그래서 시크릿에 둘 수 없고
-- (함수가 시크릿을 못 쓴다) DB 에 둬야 갱신된 값을 이어받을 수 있다.
-- refresh 유효기간 30일 — 그 안에 한 번이라도 동기화가 돌면 계속 살아 있다.
create table if not exists public.integration_tokens (
  user_id    uuid not null references auth.users (id) on delete cascade,
  provider   text not null,                 -- 'garmin'
  tokens     jsonb not null,                -- {di_token, di_refresh_token, di_client_id}
  expires_at timestamptz,                   -- access token 만료 예정
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ⚠️ 정책을 만들지 않는다 = 클라이언트는 절대 못 읽는다. service_role(Edge Function)만 접근.
alter table public.integration_tokens enable row level security;

-- ── 러닝화 ────────────────────────────────────────────────
create table if not exists public.shoes (
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  uuid             text not null,           -- Garmin gear uuid
  name             text,                    -- 사용자가 붙인 별명 (displayName)
  model            text,                    -- 제품명 (customMakeModel)
  gear_type        text,                    -- Shoes / Bike …
  status           text,                    -- active / retired
  date_begin       date,
  total_distance_m double precision,        -- Garmin 기준 누적 (앱 밖 활동도 포함)
  total_activities integer,
  raw              jsonb,
  updated_at       timestamptz not null default now(),
  primary key (user_id, uuid)
);

-- ── 신발 ↔ 활동 ───────────────────────────────────────────
create table if not exists public.shoe_activities (
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  shoe_uuid         text not null,
  garmin_activity_id text not null,         -- = activities.garmin_id
  primary key (user_id, shoe_uuid, garmin_activity_id)
);

create index if not exists shoe_activities_by_activity
  on public.shoe_activities (user_id, garmin_activity_id);

-- ── 활동에 Garmin id 를 뽑아 둔다 ─────────────────────────
-- raw->>'external_id' 로도 되지만, 조인·인덱스를 위해 컬럼으로 꺼낸다.
alter table public.activities
  add column if not exists garmin_id text;

comment on column public.activities.garmin_id is
  'Garmin Connect 활동 id (intervals.icu 의 external_id 필드). 러닝화 매칭 키.';

update public.activities
   set garmin_id = raw->>'external_id'
 where garmin_id is null
   and raw->>'external_id' is not null;

create index if not exists activities_garmin_id on public.activities (user_id, garmin_id);

-- ── RLS (본인 것만) ───────────────────────────────────────
alter table public.shoes enable row level security;
alter table public.shoe_activities enable row level security;

drop policy if exists shoes_owner_all on public.shoes;
create policy shoes_owner_all on public.shoes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists shoe_activities_owner_all on public.shoe_activities;
create policy shoe_activities_owner_all on public.shoe_activities
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_shoes_updated
  before update on public.shoes
  for each row execute function public.set_updated_at();
