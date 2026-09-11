-- ============================================================
-- hyperoom-v2 · STORAGE migration 002
-- avatars — user profile pictures (uploaded via server)
-- Target DB: hyperoom_v2_storage
-- Files at H:\HYPEROOM-SERVER\storage\public\avatars\
-- ============================================================

create table if not exists public.avatars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,         -- ref core.users.id, satu avatar per user
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create index if not exists avatars_user_idx on public.avatars (user_id);