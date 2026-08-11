-- PrivatePlanner — events 에 캘린더 식별/색상 컬럼 추가 (Phase 2)
-- 여러 구글 캘린더를 색상 구분해 표시하기 위함.

alter table public.events add column if not exists calendar_id text;
alter table public.events add column if not exists color text;
