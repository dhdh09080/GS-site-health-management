-- Vault stores only the SHA-256 fingerprint of the Vercel-only POSTER_STORAGE_KEY.
create function public.poster_storage_authorized(p_digest text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (select from vault.decrypted_secrets
    where name='poster_storage_key_sha256' and decrypted_secret=p_digest and length(p_digest)=64)
$$;
revoke all on function public.poster_storage_authorized(text) from public,anon,authenticated;
grant execute on function public.poster_storage_authorized(text) to service_role;
