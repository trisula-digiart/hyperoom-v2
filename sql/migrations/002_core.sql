-- ============================================================
-- hyperoom-v2 · CORE migration 002
-- user_ignores — IRC /ignore /unignore (persisted)
-- Target DB: hyperoom_core
-- ============================================================

create table if not exists public.user_ignores (
  user_id uuid not null references public.users(id) on delete cascade,
  ignored_user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ignored_user_id)
);

create index if not exists user_ignores_user_idx on public.user_ignores (user_id);