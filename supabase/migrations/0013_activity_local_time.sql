-- 훈련 시각이 +9시간 밀려 보이던 것 — 컬럼 타입을 실제 의미에 맞춘다.
--
-- intervals.icu 는 두 가지를 준다:
--   start_date_local : "2026-08-15T06:11:14"   ← 시간대가 없는 **벽시계** 시각 (실제로 뛴 시각)
--   start_date       : "2026-08-14T21:11:14Z"  ← 진짜 UTC 순간
--
-- 우리는 앞의 것을 `timestamptz` 컬럼에 넣고 있었다. 시간대가 안 붙은 문자열이라
-- Postgres 가 **UTC 로 해석**해서 `06:11+00` 으로 저장했고, 화면의 dayjs 가 그걸 다시
-- 브라우저 시간대(KST)로 환산해서 **15:11** 로 보여 줬다. 한 번은 UTC 인 척, 한 번은 KST 로
-- 환산 — 정확히 +9시간이다.
--
-- 실제 피해는 시각만이 아니었다. 현지 15시 이후 운동은 날짜까지 다음날로 넘어가
-- **325건 중 99건(30%)이 캘린더에서 하루 밀려** 있었다. 주간·월간 합계도 같이 어긋났다.
--
-- 훈련 기록에서 "06:11 에 뛰었다" 는 어디서 보든 06:11 이어야 한다. 그래서 시간대를
-- 붙이지 않는 `timestamp` 로 바꾼다. 컬럼 이름(`_local`)도 그제야 정직해진다.
--
-- 변환은 무손실이다: 지금 값은 "naive 를 UTC 로 해석한 것" 이므로 `at time zone 'UTC'`
-- 로 되돌리면 원래 벽시계 값이 그대로 나온다. raw 를 안 봐도 된다.
--
-- 재실행 안전 (이미 timestamp 면 아무것도 하지 않는다).

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'activities'
       and column_name = 'start_date_local'
       and data_type = 'timestamp with time zone'
  ) then
    alter table public.activities
      alter column start_date_local type timestamp without time zone
      using start_date_local at time zone 'UTC';
  end if;
end $$;

comment on column public.activities.start_date_local is
  '활동이 시작된 **현지 벽시계** 시각 (시간대 없음). intervals.icu 의 start_date_local 그대로. '
  '시간대를 붙이면 보는 곳에 따라 시각·날짜가 밀린다 — 0013 참고.';

-- 원본이 남아 있는 행은 raw 에서 다시 확정한다.
-- 위 변환만으로도 값은 맞지만, 과거에 다른 경로로 들어온 행이 섞여 있을 수 있다.
update public.activities
   set start_date_local = (raw->>'start_date_local')::timestamp
 where raw ? 'start_date_local'
   and raw->>'start_date_local' <> ''
   and (start_date_local is distinct from (raw->>'start_date_local')::timestamp);
