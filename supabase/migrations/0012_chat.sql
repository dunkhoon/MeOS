-- 어시스턴트 대화 — MeOS ↔ OpenClaw.
--
-- ⚠️ 방향이 핵심이다. MeOS 가 집 PC 의 에이전트를 부르지 않는다.
--    집 PC 의 OpenClaw 채널 플러그인이 이 테이블을 **폴링해서 가져간다**.
--    그래서 집 PC 를 인터넷에 열 필요가 없다 (포트포워딩·터널·고정IP 불필요).
--    `activity_notes` + `note` 함수와 같은 원칙이다.
--
-- 앱은 RLS 로 본인 것만 읽고 쓰고, 플러그인은 Edge Function `chat` 을 통해
-- service_role 로 접근한다 (에이전트에는 사람 세션이 없다).
--
-- 재실행 안전.

-- ── 대화 ──────────────────────────────────────────────────
create table if not exists public.chat_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_threads_recent on public.chat_threads (user_id, updated_at desc);

-- ── 메시지 ────────────────────────────────────────────────
create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  thread_id   uuid not null references public.chat_threads (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  -- 사용자 메시지의 처리 상태. 플러그인이 집어가면 taken, 답이 달리면 done.
  -- assistant 행은 만들 때부터 done 이다.
  status      text not null default 'pending' check (status in ('pending', 'taken', 'done', 'error')),
  -- 보낸 화면에서 같이 실어 준 맥락 (그때의 목표·최근 측정 요약 등)
  context     jsonb,
  error       text,
  model       text,                                  -- 어떤 모델이 답했는지
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists chat_messages_by_thread
  on public.chat_messages (user_id, thread_id, created_at);

-- 플러그인은 "아직 안 가져간 질문" 만 훑는다.
-- 부분 인덱스라 대화가 아무리 쌓여도 이 조회는 안 느려진다.
create index if not exists chat_messages_pending
  on public.chat_messages (created_at)
  where role = 'user' and status = 'pending';

-- ── RLS (본인 것만) ───────────────────────────────────────
alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists chat_threads_owner_all on public.chat_threads;
create policy chat_threads_owner_all on public.chat_threads
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists chat_messages_owner_all on public.chat_messages;
create policy chat_messages_owner_all on public.chat_messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_chat_threads_updated
  before update on public.chat_threads
  for each row execute function public.set_updated_at();

-- 새 메시지가 달리면 대화를 최근으로 끌어올린다 — 목록 정렬이 이 값을 쓴다
create or replace function public.touch_chat_thread()
returns trigger
language plpgsql
as $$
begin
  update public.chat_threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;

create or replace trigger trg_chat_messages_touch_thread
  after insert on public.chat_messages
  for each row execute function public.touch_chat_thread();
