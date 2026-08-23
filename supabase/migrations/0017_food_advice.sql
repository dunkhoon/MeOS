-- 섭취 조언 — 하루 섭취 기록마다 에이전트에게 물어본 것과 그 답.
--
-- 질문은 기존 어시스턴트 경로(0012)를 그대로 탄다. 집 PC 의 플러그인이 `chat_messages` 를
-- 폴링해 가져가고 답을 되돌려 준다. 여기 테이블은 그 왕복을 **섭취 기록 화면에 붙들어 두는**
-- 역할이다 — 어느 날의, 어떤 종류의 질문이었고, 그때 수치가 어땠는지.
--
-- ⚠️ 답을 앱이 옮겨 담지 않는다. 답은 보통 수십 초 뒤에 오는데 그 사이 앱이 닫히면
--    영영 못 옮긴다. 그래서 **트리거로 DB 안에서** 옮긴다.
--
-- ⚠️ 물어본 시점의 수치를 `snapshot` 에 통째로 박아 둔다. 나중에 음식을 고치거나 목표가
--    바뀌어도 "그때 무엇을 보고 이런 조언이 나왔는지" 가 남아야 답을 읽을 수 있다.
--
-- 재실행 안전.

create table if not exists public.food_advice (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,

  -- review = 하루 섭취가 끝난 뒤 판단 / plan = 아직 먹는 중, 남은 식사 조언
  kind       text not null check (kind in ('review', 'plan')),
  question   text not null,
  snapshot   jsonb,

  -- 대화는 질문 하나당 하나를 판다. 답이 어느 질문 것인지 트리거가 thread 로 찾기 때문이다.
  -- 대화를 지워도(on delete set null) 여기 남은 답과 맥락은 그대로 남는다.
  thread_id  uuid references public.chat_threads (id) on delete set null,
  message_id uuid references public.chat_messages (id) on delete set null,

  answer     text,
  status     text not null default 'pending' check (status in ('pending', 'taken', 'done', 'error')),
  error      text,
  model      text,

  created_at  timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists food_advice_by_day
  on public.food_advice (user_id, day, created_at desc);

-- 답을 기다리는 것만 훑는 화면용
create index if not exists food_advice_open
  on public.food_advice (user_id, created_at desc)
  where status in ('pending', 'taken');

alter table public.food_advice enable row level security;

drop policy if exists food_advice_owner_all on public.food_advice;
create policy food_advice_owner_all on public.food_advice
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── 답이 달리면 여기로 옮겨 담는다 ────────────────────────
-- 답 행(role='assistant')은 Edge Function 이 service_role 로 넣는다. 그때 같은 대화를 보는
-- 조언 행을 채운다. 질문 하나당 대화 하나라 thread_id 로 정확히 하나가 잡힌다.
create or replace function public.fill_food_advice_answer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role <> 'assistant' then
    return new;
  end if;
  update public.food_advice
     set answer      = new.content,
         model       = new.model,
         status      = 'done',
         error       = null,
         answered_at = coalesce(new.answered_at, now())
   where thread_id = new.thread_id
     and user_id   = new.user_id
     and status <> 'done';
  return new;
end;
$$;

drop trigger if exists trg_chat_messages_fill_food_advice on public.chat_messages;
create trigger trg_chat_messages_fill_food_advice
  after insert on public.chat_messages
  for each row execute function public.fill_food_advice_answer();

-- ── 가져감·실패도 그대로 비춘다 ───────────────────────────
-- 화면이 "기다리는 중" 에 영원히 머물지 않게. 답이 온 경우는 위 트리거가 이미 done 으로
-- 바꿔 두므로 여기서 건드리지 않는다.
create or replace function public.sync_food_advice_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role <> 'user' or new.status not in ('taken', 'error') then
    return new;
  end if;
  update public.food_advice
     set status      = new.status,
         error       = case when new.status = 'error' then new.error else error end,
         answered_at = case when new.status = 'error' then coalesce(new.answered_at, now()) else answered_at end
   -- message_id 로 찾는 게 정확하지만, 앱이 그 값을 넣기 전에 플러그인이 먼저 집어갈 수도 있다.
   -- 그 창을 메우려고 thread 도 같이 본다 (질문 하나당 대화 하나라 안전하다).
   where (message_id = new.id or thread_id = new.thread_id)
     and user_id = new.user_id
     and status in ('pending', 'taken');
  return new;
end;
$$;

drop trigger if exists trg_chat_messages_sync_food_advice on public.chat_messages;
create trigger trg_chat_messages_sync_food_advice
  after update of status on public.chat_messages
  for each row execute function public.sync_food_advice_status();
