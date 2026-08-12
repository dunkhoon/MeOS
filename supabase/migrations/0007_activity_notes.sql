-- 활동별 AI 코멘트 보관 (외부 에이전트가 써 넣는다).
--
-- 규칙 기반 분석은 화면에서 즉석 계산하지만, LLM 이 쓴 문장은 어딘가 남겨야
-- PC 에서 만들고 모바일에서 볼 수 있다. OpenClaw(집 PC) → Edge Function `note` → 이 테이블.
--
-- 재실행 안전.

create table if not exists public.activity_notes (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- intervals.icu 활동 id (activities.external_id 와 같은 값)
  external_id text not null,
  -- 어디서 온 코멘트인지: 'openclaw' | 'manual' | …  같은 활동에 여러 출처를 남길 수 있다
  source      text not null default 'openclaw',
  content     text not null,
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, external_id, source)
);

create index if not exists activity_notes_lookup on public.activity_notes (user_id, external_id);

create or replace trigger trg_activity_notes_updated
  before update on public.activity_notes
  for each row execute function public.set_updated_at();

alter table public.activity_notes enable row level security;

drop policy if exists activity_notes_owner_all on public.activity_notes;
create policy activity_notes_owner_all on public.activity_notes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
