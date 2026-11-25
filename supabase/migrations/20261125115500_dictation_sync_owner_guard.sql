-- Require the account checked by the client to match the JWT at write time.
-- A sign-out/sign-in race must never send one account's data to another.
create or replace function public.save_dictation_sync_state_for_owner(p_owner uuid, p_expected_revision bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_owner then
    raise exception 'Dictation account changed' using errcode = '42501';
  end if;
  return public.save_dictation_sync_state(p_expected_revision, p_payload);
end;
$$;
revoke all on function public.save_dictation_sync_state_for_owner(uuid,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.save_dictation_sync_state_for_owner(uuid,bigint,jsonb) to authenticated;
revoke execute on function public.save_dictation_sync_state(bigint,jsonb) from authenticated;
