-- ============================================================
-- hyperoom-v2 · CORE migration 003
-- private rooms: password_hash, room_invites
-- Target DB: hyperoom_core
-- ============================================================

alter table public.rooms add column if not exists password_hash text;

create table if not exists public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  invited_by uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create index if not exists room_invites_user_idx on public.room_invites (user_id);