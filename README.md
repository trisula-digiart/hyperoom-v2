# Hyperoom v2

Self-hosted, Supabase-free, mIRC-inspired modern chat platform.

- **PWA** — React + Vite + TypeScript, installable, realtime
- **Server** — Node + TS: REST API + WebSocket engine + auth (JWT)
- **Database** — local PostgreSQL (hyperoom_core / hyperoom_chat / hyperoom_storage)

Not connected to external IRC. Own engine, own realtime, own state.

## Workspaces

- `apps/pwa` — browser/PWA client
- `server` — backend: HTTP API + WS realtime + domain services
- `packages/domain` — shared domain types & contracts
- `packages/engine` — chat engine + mIRC-style command execution
- `sql/migrations` — plain PostgreSQL migrations (no Supabase)