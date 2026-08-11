-- 동기화 자동 실행 (선택) — PC 가 꺼져 있어도 최신 데이터가 유지되게 한다.
-- pg_cron 이 주기적으로 Edge Function `sync` 를 호출한다.
--
-- ⚠️ 이 파일에는 키를 적지 않는다. service_role 키와 함수 주소는 Vault 에 넣어두고 여기서 읽는다.
--    아래 "1회 등록" 블록을 SQL Editor 에서 값만 채워 따로 실행하면 된다 (저장소에는 남지 않는다).
--
--    select vault.create_secret('<service_role 키>', 'sync_service_key');
--    select vault.create_secret('https://<프로젝트>.supabase.co/functions/v1/sync', 'sync_function_url');
--
--    (이미 넣어둔 값을 바꾸려면 vault.update_secret 사용)
--
-- 재실행 안전.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vault 에 값이 없으면 조용히 넘어간다 — 마이그레이션만 먼저 돌려도 깨지지 않게.
create or replace function public.trigger_sync()
returns void
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_key text;
  v_url text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'sync_service_key';
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'sync_function_url';

  if v_key is null or v_url is null then
    raise notice 'Vault 에 sync_service_key / sync_function_url 이 없어 동기화를 건너뜁니다.';
    return;
  end if;

  -- 응답을 기다리지 않는다(비동기). 결과는 public.sync_state 와 Edge Function 로그에서 확인.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('full', false)
  );
end;
$$;

revoke all on function public.trigger_sync() from public, anon, authenticated;

-- 매시 정각 (UTC 기준이지만 매시간이라 시차와 무관).
-- 더 자주/드물게 하려면 cron 표현식만 바꿔 다시 실행하면 된다.
select cron.unschedule('meos-sync') where exists (select 1 from cron.job where jobname = 'meos-sync');
select cron.schedule('meos-sync', '0 * * * *', $$select public.trigger_sync()$$);
