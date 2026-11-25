-- Additive. Legacy relational rows remain available to administrators for
-- backup and recovery. Account cutover occurs only after a snapshot is seeded.
create table if not exists public.dictation_sync_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  format_version integer not null default 1 check (format_version = 1),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and coalesce(jsonb_typeof(payload->'libraries') = 'array', false)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dictation_sync_states enable row level security;
revoke all on table public.dictation_sync_states from public, anon, authenticated;
grant select on table public.dictation_sync_states to authenticated;
drop policy if exists dictation_state_read_own on public.dictation_sync_states;
create policy dictation_state_read_own on public.dictation_sync_states
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.save_dictation_sync_state(p_expected_revision bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  saved_revision bigint;
  saved_at timestamptz;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < 0
     or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_payload->'libraries') is distinct from 'array'
     or pg_catalog.octet_length(p_payload::text) > 8 * 1024 * 1024 then
    raise exception 'Invalid dictation state' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_payload->'libraries') = 0 then
    raise exception 'Empty dictation state' using errcode = '22023';
  end if;
  if p_expected_revision = 0 then
    insert into public.dictation_sync_states(user_id, payload)
    values(actor, p_payload)
    on conflict (user_id) do nothing
    returning revision, updated_at into saved_revision, saved_at;
  else
    update public.dictation_sync_states
    set payload = p_payload, revision = revision + 1, updated_at = pg_catalog.clock_timestamp()
    where user_id = actor and revision = p_expected_revision
    returning revision, updated_at into saved_revision, saved_at;
  end if;
  if saved_revision is null then return null; end if;
  return pg_catalog.jsonb_build_object('revision', saved_revision, 'updated_at', saved_at);
end;
$$;
revoke all on function public.save_dictation_sync_state(bigint,jsonb) from public, anon, authenticated;
grant execute on function public.save_dictation_sync_state(bigint,jsonb) to authenticated;

-- Fail closed for old clients on migrated accounts. Otherwise an old tab can
-- both delete legacy rows and pull a lossy copy over its local data. The owner
-- of an account with no snapshot keeps the original behavior until cutover.
do $$
declare rel text;
begin
  foreach rel in array array['libraries','words','dictation_sessions','user_word_progress','user_library_settings','draft_tasks'] loop
    execute pg_catalog.format('drop policy if exists legacy_dictation_before_cutover on public.%I', rel);
    execute pg_catalog.format($policy$
      create policy legacy_dictation_before_cutover on public.%I as restrictive for all to authenticated
      using ((select not exists (select 1 from public.dictation_sync_states where user_id = (select auth.uid()))))
      with check ((select not exists (select 1 from public.dictation_sync_states where user_id = (select auth.uid()))))
    $policy$, rel);
  end loop;
end;
$$;
