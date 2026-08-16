-- 음식 기록 — 내 음식 목록 + 끼니별 일지.
--
-- 0011 의 `nutrition_logs` 는 하루 한 줄(kcal·단백질)뿐이라 "뭘 먹었는지" 를 못 남긴다.
-- 그걸 대체한다. 예전 기록은 그대로 두고(수동 입력분), 합계는 이제 여기서 나온다.
--
-- 구조는 FatSecret 과 같은 모양이다: 음식(브랜드+이름) → 기준 서빙 → 일지 항목(끼니·수량).
--
-- ⚠️ 단위 환산은 **한 곳에서만** 한다. 음식마다 "기준 수량 + 기준 단위" 를 두고
--    영양소는 **그 기준 1회분** 값으로 저장한다.
--      닭가슴살 스테이크 : base 100 g        → 165kcal
--      임팩트 웨이 프로틴 : base 1 스쿱(25g)  → 98kcal
--      크림 파스타       : base 150 g        → 413kcal
--    기록할 때 배율만 곱한다. g 로 적고 싶으면 base_grams 가 있을 때만 가능하다.
--
-- 재실행 안전.

-- ── 내 음식 목록 ──────────────────────────────────────────
create table if not exists public.foods (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,                    -- '닭가슴살 스테이크'
  brand        text,                             -- '맛있닭'

  -- 기준 1회분
  base_amount  double precision not null default 100,
  base_unit    text not null default 'g',        -- g | ml | 스쿱 | 인분 | 개 …
  -- 그램 환산. 있으면 g 단위로도 적을 수 있다. 스쿱·인분만 아는 음식은 null.
  base_grams   double precision,

  -- 기준 1회분 기준 영양소 (모르는 값은 null — 0 으로 두면 합계가 조용히 틀어진다)
  kcal         double precision,
  carb_g       double precision,
  sugar_g      double precision,
  protein_g    double precision,
  fat_g        double precision,
  sat_fat_g    double precision,
  trans_fat_g  double precision,
  chol_mg      double precision,
  fiber_g      double precision,
  sodium_mg    double precision,
  potassium_mg double precision,

  source       text not null default 'manual',   -- manual | ai-photo | ai-text
  note         text,
  archived     boolean not null default false,   -- 지우는 대신 감춘다 (과거 기록이 참조)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 같은 이름이 여러 개 쌓이지 않게. 브랜드가 다르면 다른 음식이다.
create unique index if not exists foods_unique_name
  on public.foods (user_id, coalesce(brand, ''), name);

create index if not exists foods_recent on public.foods (user_id, updated_at desc);

-- ── 일지 ──────────────────────────────────────────────────
create table if not exists public.food_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  meal       text not null default 'snack' check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),

  food_id    uuid references public.foods (id) on delete set null,
  -- 이름·영양소를 복사해 둔다: 음식을 지우거나 성분을 고쳐도 **그날 먹은 것은 그대로**여야 한다
  name       text not null,
  brand      text,

  amount     double precision not null,          -- 1.5
  unit       text not null,                      -- 'g' | '스쿱' | '인분' …
  grams      double precision,                   -- 환산된 그램 (알 때만)

  -- 실제 섭취량 (기준 1회분 × 배율). 조회할 때마다 다시 계산하지 않는다.
  kcal         double precision,
  carb_g       double precision,
  sugar_g      double precision,
  protein_g    double precision,
  fat_g        double precision,
  sat_fat_g    double precision,
  trans_fat_g  double precision,
  chol_mg      double precision,
  fiber_g      double precision,
  sodium_mg    double precision,
  potassium_mg double precision,

  created_at timestamptz not null default now()
);

create index if not exists food_entries_by_day on public.food_entries (user_id, day, meal);

-- ── RLS (본인 것만) ───────────────────────────────────────
alter table public.foods         enable row level security;
alter table public.food_entries  enable row level security;

drop policy if exists foods_owner_all on public.foods;
create policy foods_owner_all on public.foods
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists food_entries_owner_all on public.food_entries;
create policy food_entries_owner_all on public.food_entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_foods_updated
  before update on public.foods
  for each row execute function public.set_updated_at();

-- ── 영양정보표 사진 보관함 ────────────────────────────────
-- AI 에게 읽히려고 잠깐 올려 두는 곳. 공개 버킷이 아니고, 앱이 만든 **서명 URL**만
-- 집 PC 의 플러그인에 넘긴다 (에이전트에는 사람 세션이 없어서 RLS 로는 못 읽는다).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('food-photos', 'food-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 경로는 `<user_id>/...` 로 둔다 — 첫 칸이 자기 id 일 때만 손댈 수 있다.
drop policy if exists food_photos_owner_all on storage.objects;
create policy food_photos_owner_all on storage.objects
  for all to authenticated
  using (bucket_id = 'food-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'food-photos' and (storage.foldername(name))[1] = auth.uid()::text);
