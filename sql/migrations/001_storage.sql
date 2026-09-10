-- ============================================================
-- hyperoom-v2 · STORAGE migration 001
-- media_objects — file metadata for avatars, attachments
-- Target DB: hyperoom_storage
-- Files stored at H:\HYPEROOM-SERVER\storage\public\<bucket>\
-- ============================================================

create table if not exists public.media_objects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,              -- ref core.users.id
  bucket text not null check (bucket in ('avatars','attachments')),
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  created_at timestamptz not null default now()
);
create index if not exists media_objects_owner_idx on public.media_objects (owner_id);