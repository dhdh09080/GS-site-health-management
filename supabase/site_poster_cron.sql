-- Install after adding poster_dispatch_url and poster_cron_secret to Supabase Vault.
-- The endpoint must be the production /api/poster-delivery?action=tick HTTPS URL.
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
 if not exists(select from vault.decrypted_secrets where name='poster_dispatch_url' and decrypted_secret like 'https://%')
 or not exists(select from vault.decrypted_secrets where name='poster_cron_secret' and length(decrypted_secret)>=32)
 then raise exception 'Configure the poster dispatcher URL and cron secret in Vault first'; end if;
 perform cron.schedule('workspace-weather-posters','* * * * *',$task$
 select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='poster_dispatch_url'),
 headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='poster_cron_secret')),
 body:='{}'::jsonb,timeout_milliseconds:=60000)
 where exists(select from public.poster_subscriptions where enabled)
 or exists(select from public.poster_message_images where expires_at<=now())
 or exists(select from public.poster_deliveries where updated_at < now()-interval '30 days'
    or (status in ('sending','preparing') and updated_at<now()-interval '5 minutes'))
 $task$);
end $$;
