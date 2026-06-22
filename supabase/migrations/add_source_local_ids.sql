-- Run this file manually in Supabase SQL Editor before using manual cloud upload.
-- This migration only adds nullable mapping columns and unique indexes.
-- It does not delete, truncate, or overwrite existing rows.

alter table public.libraries
  add column if not exists source_local_id text;

alter table public.words
  add column if not exists source_local_id text;

alter table public.dictation_sessions
  add column if not exists source_local_id text;

create unique index if not exists libraries_owner_source_local_id_uidx
  on public.libraries (owner_id, source_local_id);

create unique index if not exists words_library_source_local_id_uidx
  on public.words (library_id, source_local_id);

create unique index if not exists sessions_user_library_source_local_id_uidx
  on public.dictation_sessions (user_id, library_id, source_local_id);

comment on column public.libraries.source_local_id is
  'Stable localStorage libraryId used only for manual upload mapping.';

comment on column public.words.source_local_id is
  'Stable localStorage word id used only for manual upload mapping.';

comment on column public.dictation_sessions.source_local_id is
  'Stable localStorage recordId used only for manual upload mapping.';
