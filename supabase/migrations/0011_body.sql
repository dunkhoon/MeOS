-- 체형(인바디) · 목표 · 영양.
--
-- 인바디 앱 CSV 를 그대로 받는다. 기기마다 주는 항목이 다르다 —
-- 270S 는 45개 열 중 부위별 근육·지방을 안 준다(전부 '-'). 그래서 대부분의 열이 null 을 허용하고,
-- 원본 행은 `raw` 에 통째로 남긴다. 나중에 열이 늘거나 다른 기기로 바꿔도 값을 잃지 않는다.
--
-- BMR(기초대사량)은 공식으로 추정하지 않고 **인바디가 준 값을 쓴다**. 제지방량을 실제로 잰
-- 값이라 키·나이·성별로 계산한 Harris-Benedict 류보다 이 사람에게 맞는다.
--
-- 재실행 안전.

-- ── 인바디 측정 ───────────────────────────────────────────
create table if not exists public.body_measurements (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  measured_at        timestamptz not null,          -- CSV 의 '날짜' (YYYYMMDDHHmmss)
  device             text,                          -- '270S'

  -- 기본
  weight_kg          double precision,
  skeletal_muscle_kg double precision,              -- 골격근량
  muscle_kg          double precision,              -- 근육량
  body_fat_kg        double precision,              -- 체지방량
  bmi                double precision,
  body_fat_pct       double precision,
  bmr_kcal           integer,                       -- 기초대사량
  inbody_age         integer,
  inbody_score       double precision,

  -- 부위별 근육량 (주는 기기에서만)
  arm_r_muscle_kg    double precision,
  arm_l_muscle_kg    double precision,
  trunk_muscle_kg    double precision,
  leg_r_muscle_kg    double precision,
  leg_l_muscle_kg    double precision,

  -- 부위별 체지방
  arm_r_fat_kg       double precision,
  arm_l_fat_kg       double precision,
  trunk_fat_kg       double precision,
  leg_r_fat_kg       double precision,
  leg_l_fat_kg       double precision,

  -- 복부·내장지방
  whr                double precision,              -- 복부지방률
  waist_cm           double precision,
  visceral_fat_area  double precision,              -- 내장지방단면적(cm²)
  visceral_fat_level double precision,

  -- 체수분
  body_water_l       double precision,
  icw_l              double precision,              -- 세포내수분
  ecw_l              double precision,              -- 세포외수분
  ecw_ratio          double precision,              -- 세포외수분비

  -- 조성·기타
  protein_kg         double precision,
  mineral_kg         double precision,
  bone_mineral_kg    double precision,
  bcm_kg             double precision,              -- 체세포량
  leg_muscle_kg      double precision,
  leg_muscle_level   double precision,
  smi                double precision,              -- 골격근지수(kg/m²)
  phase_angle        double precision,              -- 전신위상각(°)

  raw                jsonb,                         -- CSV 원본 행 (열이 늘어도 잃지 않게)
  created_at         timestamptz not null default now(),
  -- 같은 파일을 다시 올려도 늘지 않는다. 측정 시각이 곧 그 측정의 신원.
  unique (user_id, measured_at)
);

create index if not exists body_measurements_by_time
  on public.body_measurements (user_id, measured_at desc);

-- ── 목표 ──────────────────────────────────────────────────
-- 지표마다 한 줄. 체중·체지방률·골격근량을 동시에 걸 수 있다.
create table if not exists public.body_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  metric       text not null,                       -- weight_kg | body_fat_pct | skeletal_muscle_kg
  target_value double precision not null,
  target_date  date not null,
  -- 세울 때의 값을 박아 둔다. 나중에 계산으로 되찾으려 하면 그 사이 측정이 지워졌을 때 진행률이 흔들린다.
  start_value  double precision not null,
  start_date   date not null,
  achieved_at  timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists body_goals_active
  on public.body_goals (user_id, active, metric);

-- ── 영양 기록 (하루 한 줄, 숫자만) ────────────────────────
-- 음식 DB 는 두지 않는다. 목표 대비 달성률만 보면 되는 용도다.
create table if not exists public.nutrition_logs (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  kcal       integer,
  protein_g  integer,
  note       text,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ── 체형 설정 ─────────────────────────────────────────────
-- 신장은 인바디의 체중·BMI 로 역산할 수 있어서 비워 둬도 된다.
-- neat_factor: 운동을 뺀 하루 활동량 배수. 운동 소모는 intervals.icu 활동에서 따로 더한다.
create table if not exists public.body_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  height_cm   double precision,
  sex         text,                                 -- male | female (선택)
  birth_year  integer,                              -- 선택
  neat_factor double precision not null default 1.25,
  updated_at  timestamptz not null default now()
);

-- ── RLS (본인 것만) ───────────────────────────────────────
alter table public.body_measurements enable row level security;
alter table public.body_goals        enable row level security;
alter table public.nutrition_logs    enable row level security;
alter table public.body_settings     enable row level security;

drop policy if exists body_measurements_owner_all on public.body_measurements;
create policy body_measurements_owner_all on public.body_measurements
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists body_goals_owner_all on public.body_goals;
create policy body_goals_owner_all on public.body_goals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nutrition_logs_owner_all on public.nutrition_logs;
create policy nutrition_logs_owner_all on public.nutrition_logs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists body_settings_owner_all on public.body_settings;
create policy body_settings_owner_all on public.body_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_body_goals_updated
  before update on public.body_goals
  for each row execute function public.set_updated_at();

create or replace trigger trg_nutrition_logs_updated
  before update on public.nutrition_logs
  for each row execute function public.set_updated_at();

create or replace trigger trg_body_settings_updated
  before update on public.body_settings
  for each row execute function public.set_updated_at();
