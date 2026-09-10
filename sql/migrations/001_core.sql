-- ============================================================
-- hyperoom-v2 · CORE migration 001
-- users (profiles) · rooms · room_members · roles · permissions
-- Target DB: hyperoom_core
-- ============================================================

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  display_name text,
  avatar_url text,
  bio text,
  status text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,          -- "#general"
  type text not null default 'public' check (type in ('public','private','dm','group')),
  topic text,
  is_locked boolean not null default false,
  owner_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','operator','voice','member')),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  role_name text not null references public.roles(name) on delete cascade,
  permission text not null,           -- e.g. 'rooms.manage', 'messages.delete_any'
  unique (role_name, permission)
);

-- Seed baseline roles
insert into public.roles (name, description) values
  ('owner',     'Full control of the room'),
  ('admin',     'Manage members and messages'),
  ('operator',  'Kick/ban and moderate'),
  ('voice',     'Can speak in moderated rooms'),
  ('member',    'Standard member')
on conflict (name) do nothing;