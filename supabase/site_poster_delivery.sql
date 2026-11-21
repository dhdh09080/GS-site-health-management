begin;
create table public.poster_subscriptions (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 channel text not null check(channel in ('telegram','kakao')),
 user_id uuid references auth.users(id) on delete cascade,
 check ((channel='kakao') = (user_id is not null)),
 unique nulls not distinct(workspace_id,channel,user_id),
 enabled boolean not null default false,
 minute smallint not null default 360 check(minute between 0 and 1439),
 days smallint[] not null default array[1,2,3,4,5,6,7]::smallint[]
   check(cardinality(days) between 1 and 7 and array_position(days,null) is null and days <@ array[1,2,3,4,5,6,7]::smallint[]),
 destination text, label text, binding_hash text unique, binding_until timestamptz, candidate text, candidate_label text,
 revision uuid not null default gen_random_uuid(),
 check(not enabled or destination is not null)
);
create table public.poster_deliveries (
 subscription_id uuid not null references public.poster_subscriptions(id) on delete cascade,
 slot text not null, attempt uuid not null default gen_random_uuid(),
 status text not null check(status in ('preparing','sending','sent','failed','unknown')),
 detail text, updated_at timestamptz not null default now(),
 primary key(subscription_id,slot)
);
create unique index poster_delivery_inflight on public.poster_deliveries(subscription_id) where status in ('preparing','sending');
create index poster_delivery_history on public.poster_deliveries(subscription_id,updated_at desc);
-- A short-lived, unguessable image for Kakao's feed template. Only the API serves its bytes.
create table public.poster_message_images (
 id uuid primary key default gen_random_uuid(), subscription_id uuid not null references public.poster_subscriptions(id) on delete cascade,
 png text not null check(length(png) <= 8000000), expires_at timestamptz not null default now()+interval '7 days'
);
create index poster_image_expiry on public.poster_message_images(expires_at);
alter table public.poster_subscriptions enable row level security;
alter table public.poster_deliveries enable row level security;
alter table public.poster_message_images enable row level security;
revoke all on public.poster_subscriptions, public.poster_deliveries, public.poster_message_images from public,anon,authenticated;
grant select,insert,update,delete on public.poster_subscriptions,public.poster_deliveries,public.poster_message_images to service_role;

-- Service-role only. A dated slot survives changes to destination, weekdays and send time.
create function public.claim_poster_deliveries(p_test uuid default null,p_expected uuid default null)
returns table(subscription_id uuid, slot text, attempt uuid, revision uuid)
language plpgsql set search_path = '' as $$
declare t timestamp := now() at time zone 'Asia/Seoul';
begin
 if p_test is null then
   delete from public.poster_message_images where expires_at <= now();
   delete from public.poster_deliveries where updated_at < now()-interval '30 days';
 end if;
   update public.poster_deliveries set status='unknown',detail='전송 결과를 확인할 수 없습니다.',updated_at=now()
    where (p_test is null or poster_deliveries.subscription_id=p_test) and status='sending' and updated_at < now()-interval '5 minutes';
   update public.poster_deliveries set status='failed',detail='포스터 준비 시간이 초과됐습니다.',updated_at=now()
    where (p_test is null or poster_deliveries.subscription_id=p_test) and status='preparing' and updated_at < now()-interval '5 minutes';
 return query
 with eligible as (
   select s.id,s.revision,case when p_test is null then t::date::text else 'test-'||to_char(t,'YYYYMMDDHH24MI') end as key
   from public.poster_subscriptions s join public.workspaces w on w.id=s.workspace_id
   where s.destination is not null and coalesce(w.status,'active') not in ('suspended','archived')
   and (s.user_id is null or w.owner_id=s.user_id or exists
        (select from public.workspace_members m where m.workspace_id=w.id and m.user_id=s.user_id))
   and ((p_test is not null and s.id=p_test and s.revision=p_expected) or (p_test is null and s.enabled
       and extract(isodow from t)::int=any(s.days)
       and (extract(hour from t)*60+extract(minute from t)-s.minute) between 0 and 29))
 ), batch as (
   select e.* from eligible e where not exists(select from public.poster_deliveries d where d.subscription_id=e.id and (d.slot=e.key or d.status in ('preparing','sending')))
   order by e.id limit 2
 ), claimed as (
   insert into public.poster_deliveries as d(subscription_id,slot,status)
     select b.id,b.key,'preparing' from batch b on conflict do nothing returning d.subscription_id,d.slot,d.attempt
 )
 select c.subscription_id,c.slot,c.attempt,b.revision from claimed c join batch b on b.id=c.subscription_id;
end $$;

-- Recheck permissions and the exact saved destination immediately before handing the file to the messenger.
create function public.begin_poster_send(p_subscription uuid,p_slot text,p_attempt uuid,p_revision uuid)
returns boolean language sql set search_path='' as $$
 with changed as (
 update public.poster_deliveries d set status='sending',updated_at=now()
 from public.poster_subscriptions s join public.workspaces w on w.id=s.workspace_id
 where s.id=p_subscription and s.revision=p_revision and s.destination is not null
 and (s.enabled or p_slot like 'test-%') and coalesce(w.status,'active') not in ('suspended','archived')
 and (s.user_id is null or w.owner_id=s.user_id or exists(select from public.workspace_members m where m.workspace_id=w.id and m.user_id=s.user_id))
 and d.subscription_id=s.id and d.slot=p_slot and d.attempt=p_attempt and d.status='preparing'
 returning 1)
 select exists(select from changed)
$$;
create function public.poster_scheduler_ready() returns boolean language plpgsql stable set search_path='' as $$
declare ready boolean;
begin
 if to_regclass('cron.job') is null then return false; end if;
 execute 'select exists(select from cron.job where jobname=$1 and active)' into ready using 'workspace-weather-posters';
 return ready;
end $$;
revoke all on function public.poster_scheduler_ready() from public,anon,authenticated;
-- The role cannot read postgres cron metadata directly.
alter function public.poster_scheduler_ready() security definer;
grant execute on function public.poster_scheduler_ready() to service_role;
revoke all on function public.claim_poster_deliveries(uuid,uuid),public.begin_poster_send(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_poster_deliveries(uuid,uuid),public.begin_poster_send(uuid,text,uuid,uuid) to service_role;
commit;
