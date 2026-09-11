-- ============================================================
-- hyperoom-v2 · CORE migration 005
-- room bans + mutes (moderation, Phase 4)
-- Target DB: hyperoom_core
-- ============================================================

create table if not exists public.room_bans (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  banned_by uuid not null references public.users(id) on delete cascade,
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create table if not exists public.room_mutes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  muted_by uuid not null references public.users(id) on delete cascade,
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);