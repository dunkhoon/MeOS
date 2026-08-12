-- 세션 종류 수동 지정.
--
-- 평소엔 활동 이름에서 추정하지만(`web/src/lib/session.ts`) 이름을 그렇게 안 적은 활동도 있고
-- 추정이 틀릴 때도 있다. 사용자가 고른 값이 있으면 그게 이긴다.
--
-- 동기화(`sync` Edge Function)는 upsert 로 지정한 컬럼만 덮으므로 이 값은 살아남는다.
--
-- 재실행 안전.

alter table public.activities
  add column if not exists session_kind text;

comment on column public.activities.session_kind is
  '사용자가 수동 지정한 세션 종류 (race|interval|tempo|long|recovery|easy|other). null 이면 활동 이름에서 추정.';
