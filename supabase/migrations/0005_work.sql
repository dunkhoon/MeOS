-- PrivatePlanner — 업무 모듈 (Phase 3)
-- 진행 중인 업무 · 할 일(BTS 외) · 루틴, 그리고 휴지통(soft delete).
--
-- ⚠️ 설계 결정 변경 (2026-08-07):
--   원래 SPEC §2·§5 는 "회사 업무(Redmine/JIRA) 데이터는 클라우드에 저장하지 않는다" 였다.
--   BTS 이슈를 끌어와 만든 진행 중인 업무 항목도 PC·모바일에서 같은 목록으로 보이도록
--   사용자 결정에 따라 클라우드에 저장한다(origin='bts' + bts_* 컬럼).
--   → 실시간 BTS 목록 조회 자체는 여전히 데스크톱 전용이며 DB에 쌓지 않는다.
--     여기 저장되는 것은 "내가 진행 중인 업무로 끌어다 놓은 항목"뿐이다.

-- ── work_items: 진행 중인 업무 + 할 일 (두 리스트를 한 테이블로) ──
create table if not exists public.work_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  list          text not null default 'progress',   -- 'progress' | 'todo'  (둘 사이 이동 가능)
  status        text not null default 'wait',       -- 'wait' | 'doing' | 'done'  (progress 에서만 의미)
  title         text not null,
  url           text,
  done          boolean not null default false,     -- todo 리스트의 체크 여부
  sort          double precision not null default 0,
  origin        text not null default 'manual',     -- 'manual' | 'bts'
  bts_system    text,                               -- 'redmine' | 'jira'
  bts_issue_id  text,                               -- Redmine 이슈번호 / JIRA 이슈키
  bts_tracker   text,                               -- 트래커(개발/버그 …) · JIRA 이슈타입
  bts_version   text,                               -- 목표 버전 / fixVersion
  deleted_at    timestamptz,                        -- 휴지통 (null = 살아있음)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 이전 버전에서 만들어졌다면 컬럼 보강 (재실행 안전)
alter table public.work_items add column if not exists origin       text not null default 'manual';
alter table public.work_items add column if not exists bts_system   text;
alter table public.work_items add column if not exists bts_issue_id text;
alter table public.work_items add column if not exists bts_tracker  text;
alter table public.work_items add column if not exists bts_version  text;

-- 같은 BTS 이슈를 두 번 끌어다 놓아도 중복 생기지 않게 (휴지통에 있는 건 제외)
create unique index if not exists work_items_bts_uniq
  on public.work_items (user_id, bts_system, bts_issue_id)
  where origin = 'bts' and deleted_at is null;

-- ── routines: 매일 리셋되는 루틴 ────────────────────────────
-- last_done_on 이 "오늘"이면 체크된 상태. 날짜가 바뀌면 비교값이 어긋나 자동으로 풀린다
-- (별도 리셋 배치/크론 불필요).
create table if not exists public.routines (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null,
  sort         double precision not null default 0,
  last_done_on date,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists work_items_live_idx on public.work_items (user_id, list, sort) where deleted_at is null;
create index if not exists work_items_trash_idx on public.work_items (user_id, deleted_at) where deleted_at is not null;
create index if not exists routines_live_idx on public.routines (user_id, sort) where deleted_at is null;

create or replace trigger trg_work_items_updated before update on public.work_items for each row execute function public.set_updated_at();
create or replace trigger trg_routines_updated   before update on public.routines   for each row execute function public.set_updated_at();

-- Row Level Security: 각 사용자는 본인 데이터만 접근
alter table public.work_items enable row level security;
alter table public.routines   enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['work_items', 'routines']
  loop
    execute format('drop policy if exists %I_owner_all on public.%I;', t, t);
    execute format(
      'create policy %I_owner_all on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid());',
      t, t
    );
  end loop;
end
$$;
