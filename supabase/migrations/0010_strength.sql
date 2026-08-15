-- 근력 운동 — 세트 단위 타이머 기록.
--
-- intervals.icu 는 근력 운동을 "WeightTraining 45분 · 평균 심박 120" 한 덩어리로만 준다.
-- 무엇을 몇 kg 로 몇 번 들었는지는 안 준다. 그래서 세트는 앱에서 직접 찍는다.
--
-- ⚠️ 휴식은 행으로 저장하지 않는다. 세트 사이의 빈 시간이 곧 휴식이라,
--    따로 행을 두면 세트를 지우거나 고칠 때 두 기록이 반드시 어긋난다.
--    조회할 때 앞 세트의 ended_at ~ 다음 세트의 started_at 간격으로 계산한다.
--
-- 재실행 안전.

-- ── 종목 (사용자가 붙이는 라벨) ────────────────────────────
create table if not exists public.strength_exercises (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,                   -- '바벨 프레스'
  category    text,                            -- chest|back|shoulder|leg|arm|core|other
  sort_order  integer not null default 0,
  -- 지우는 대신 감춘다 — 과거 기록이 이 종목을 가리키고 있다
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ── 세션 (운동 시작 ~ 종료) ────────────────────────────────
create table if not exists public.strength_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at timestamptz not null,
  ended_at   timestamptz,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strength_sessions_by_day
  on public.strength_sessions (user_id, started_at desc);

-- ── 세트 ──────────────────────────────────────────────────
create table if not exists public.strength_sets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id    uuid not null references public.strength_sessions (id) on delete cascade,
  seq           integer not null,              -- 세션 안의 순서 (1부터)
  exercise_id   uuid references public.strength_exercises (id) on delete set null,
  -- 종목 이름을 복사해 둔다: 종목을 지우거나 이름을 바꿔도 그날의 기록은 그대로여야 한다
  exercise_name text not null,
  weight_kg     double precision,
  reps          integer,
  started_at    timestamptz not null,
  ended_at      timestamptz not null,
  duration_s    integer not null,
  created_at    timestamptz not null default now(),
  unique (user_id, session_id, seq)
);

create index if not exists strength_sets_by_session
  on public.strength_sets (user_id, session_id, seq);

-- 종목별 추이(볼륨·최고중량) 그래프가 이 순서로 훑는다
create index if not exists strength_sets_by_exercise
  on public.strength_sets (user_id, exercise_name, started_at);

-- ── RLS (본인 것만) ───────────────────────────────────────
alter table public.strength_exercises enable row level security;
alter table public.strength_sessions  enable row level security;
alter table public.strength_sets      enable row level security;

drop policy if exists strength_exercises_owner_all on public.strength_exercises;
create policy strength_exercises_owner_all on public.strength_exercises
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists strength_sessions_owner_all on public.strength_sessions;
create policy strength_sessions_owner_all on public.strength_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists strength_sets_owner_all on public.strength_sets;
create policy strength_sets_owner_all on public.strength_sets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_strength_sessions_updated
  before update on public.strength_sessions
  for each row execute function public.set_updated_at();
