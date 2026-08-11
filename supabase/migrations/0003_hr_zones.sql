-- PrivatePlanner — 활동에 HR 존 체류시간(초) 추가 (Phase 1 확장)
-- intervals.icu 활동의 icu_hr_zone_times (Z1~Z5, 초) 저장용.

alter table public.activities
  add column if not exists hr_zone_times integer[];
