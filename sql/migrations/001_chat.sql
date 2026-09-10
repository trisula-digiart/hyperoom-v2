-- ============================================================
-- hyperoom-v2 · CHAT migration 001
-- messages · reactions · presence (ephemeral)
-- Target DB: hyperoom_chat
-- user_id/room_id reference CORE uuids (no cross-DB FK)
-- ============================================================

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,               -- ref core.rooms.id
  author_id uuid not null,             -- ref core.users.id
  kind text not null default 'text' check (kind in ('text','action','system')),
  content text not null check (char_length(content) between 1 and 4000),
  reply_to_message_id uuid,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);

create table if not exists public.reactions (
  message_id uuid not null,            -- ref this db messages.id
  user_id uuid not null,               -- ref core.users.id
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.presence (
  user_id uuid primary key,            -- ref core.users.id
  status text not null default 'offline' check (status in ('online','idle','offline')),
  last_seen_at timestamptz not null default now()
);