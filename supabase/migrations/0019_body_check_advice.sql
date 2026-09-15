-- 몸상태 판단에 붙는 AI 조언 — 물어본 것과 그 답을 그날 판단에 붙들어 둔다.
--
-- 지금까지는 리뷰의 '물어보기' 가 어시스턴트 화면으로 넘어가 버려서, 답은 대화에만 남고
-- 며칠 뒤 캘린더에서 그날을 다시 열면 **무슨 말을 들었는지 알 수 없었다.**
-- 판정 옆에 답을 같이 두면 "그날 왜 쉬었나" 가 한 화면에서 끝난다.
--
-- ⚠️ 답을 앱이 옮겨 담지 않는다 (0017 과 같은 이유). 답은 보통 수십 초 뒤에 오는데
--    그 사이 리뷰를 닫거나 앱이 꺼지면 영영 못 옮긴다. **트리거로 DB 안에서** 옮긴다.
--
-- 하루 한 건이라 별도 표를 파지 않고 `body_checks` 에 열로 붙인다. 다시 물으면 새 답으로
-- 덮는다 — 판단 자체가 그렇고(다시 판단하면 그날 것을 덮어쓴다), 최신 답이 그날의 답이다.
--
-- 재실행 안전.

alter table public.body_checks
  add column if not exists advice            text,
  add column if not exists advice_status     text,
  add column if not exists advice_error      text,
  add column if not exists advice_model      text,
  add column if not exists advice_thread_id  uuid references public.chat_threads (id) on delete set null,
  add column if not exists advice_message_id uuid references public.chat_messages (id) on delete set null,
  add column if not exists advice_asked_at   timestamptz,
  add column if not exists advice_at         timestamptz;

-- null = 아직 물어본 적 없음
do $$
begin
  alter table public.body_checks
    add constraint body_checks_advice_status_chk
    check (advice_status is null or advice_status in ('pending', 'taken', 'done', 'error'));
exception
  when duplicate_object then null;
end
$$;

-- 답을 기다리는 판단만 훑는 화면용
create index if not exists body_checks_advice_open
  on public.body_checks (user_id, day desc)
  where advice_status in ('pending', 'taken');

-- ── 답이 달리면 여기로 옮겨 담는다 ────────────────────────
-- 답 행(role='assistant')은 Edge Function 이 service_role 로 넣는다. 그때 같은 대화를 보는
-- 판단 행을 채운다. 조언 하나당 대화 하나라 thread_id 로 정확히 하나가 잡힌다.
create or replace function public.fill_body_check_advice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role <> 'assistant' then
    return new;
  end if;
  update public.body_checks
     set advice        = new.content,
         advice_model  = new.model,
         advice_status = 'done',
         advice_error  = null,
         advice_at     = coalesce(new.answered_at, now())
   where advice_thread_id = new.thread_id
     and user_id          = new.user_id
     and advice_status is distinct from 'done';
  return new;
end;
$$;

drop trigger if exists trg_chat_messages_fill_body_check on public.chat_messages;
create trigger trg_chat_messages_fill_body_check
  after insert on public.chat_messages
  for each row execute function public.fill_body_check_advice();

-- ── 가져감·실패도 그대로 비춘다 ───────────────────────────
-- 화면이 "기다리는 중" 에 영원히 머물지 않게. 답이 온 경우는 위 트리거가 이미 done 으로
-- 바꿔 두므로 여기서 건드리지 않는다.
create or replace function public.sync_body_check_advice_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role <> 'user' or new.status not in ('taken', 'error') then
    return new;
  end if;
  update public.body_checks
     set advice_status = new.status,
         advice_error  = case when new.status = 'error' then new.error else advice_error end,
         advice_at     = case when new.status = 'error' then coalesce(new.answered_at, now()) else advice_at end
   -- message_id 로 찾는 게 정확하지만, 앱이 그 값을 넣기 전에 플러그인이 먼저 집어갈 수도 있다.
   -- 그 창을 메우려고 thread 도 같이 본다 (조언 하나당 대화 하나라 안전하다).
   where (advice_message_id = new.id or advice_thread_id = new.thread_id)
     and user_id = new.user_id
     and advice_status in ('pending', 'taken');
  return new;
end;
$$;

drop trigger if exists trg_chat_messages_sync_body_check on public.chat_messages;
create trigger trg_chat_messages_sync_body_check
  after update of status on public.chat_messages
  for each row execute function public.sync_body_check_advice_status();
