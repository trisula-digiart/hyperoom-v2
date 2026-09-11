-- ============================================================
-- hyperoom-v2 · CORE migration 004
-- lobby room flag — RUANGAN LOBY UTAMA
-- Target DB: hyperoom_core
-- ============================================================

alter table public.rooms add column if not exists is_lobby boolean not null default false;