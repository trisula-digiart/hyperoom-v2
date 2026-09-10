# Cara Menjalankan HYPEROOM v2

## Cara 1 — Double-click (paling gampang)
**Desktop → klik 2x `HYPEROOM v2`**
- Start PostgreSQL (kalau belum jalan)
- Start backend :3100
- Start PWA :3101
- Buka browser `http://localhost:3101` otomatis

## Cara 2 — Autostart (PC restart otomatis nyala)
File sudah ada di:
`C:\Users\MASTER\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\HYPEROOM-v2.vbs`
- Setiap Windows login → server langsung jalan (hidden, tanpa window)
- Tidak perlu klik apa pun

## Cara 3 — Manual (terminal)
```bash
# PostgreSQL (kalau belum jalan)
H:\HYPEROOM-SERVER\storage\private\downloads\pgbin\pgsql\bin\postgres.exe -D H:\HYPEROOM-SERVER\storage\pgdata -p 5432

# Backend + PWA
cd H:\TRISULA_DIGIART\hyperoom-v2
npm run dev          # backend :3100 (watch mode)
cd apps/pwa && npx vite --host   # PWA :3101
```

## URL
| Halaman | URL |
|---|---|
| Aplikasi chat (login: calculus_1987 / salahketik) | `http://localhost:3101` |
| Dashboard server | `http://localhost:3100` |
| Health check | `http://localhost:3100/health` |
| LAN (HP/laptop di wifi sama) | `http://192.168.1.2:3101` |

## Cara matiin
```bash
# Semua server v2
taskkill /F /PID <pid-port-3100>
taskkill /F /PID <pid-port-3101>
# Atau: Task Manager → end process node.exe (yang bukan punya app lain)
```

## Log
- Server: `H:\TRISULA_DIGIART\hyperoom-v2\logs\server.log`
- PWA: `H:\TRISULA_DIGIART\hyperoom-v2\logs\pwa.log`
- PostgreSQL: `H:\HYPEROOM-SERVER\logs\postgres.log`

## Catatan
- VBS cek port dulu — kalau server sudah jalan, ga start dobel
- PostgreSQL TIDAK di-kill sama VBS (biar tetap jalan 24/7)
- Password dev: `hyperoom_pg_local_dev_2026` (localhost only)