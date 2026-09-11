#!/bin/bash
# ============================================================
# Hyperoom v2 — Quality Gate: test otomatis alur user BARU.
# Jalanin sebelum deploy: bash scripts/qc-new-user.sh
# Simulasi user baru: daftar → rooms → DM → kirim → resolve nama
# ============================================================
set -e
BASE="${1:-http://localhost:3100}"
PASS=0; FAIL=0

check() { # $1=desc $2="OK"|error
  if echo "$2" | grep -q "OK"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "❌ $1: $2"; fi
}

echo "═══ QC USER BARU ═══"
SUFFIX=$(date +%s)
U="qc_${SUFFIX}"

# 1. daftar
T=$(curl -s -X POST "$BASE/api/auth/signup" -H "Content-Type: application/json" -d "{\"username\":\"$U\",\"password\":\"rahasia123\",\"displayName\":\"QC $SUFFIX\"}" | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
check "1. daftar" "$([ -n "$T" ] && echo OK || echo GAGAL)"

# 2. rooms (lobby auto-join)
ROOMS=$(curl -s "$BASE/api/rooms" -H "Authorization: Bearer $T")
check "2. rooms" "$(echo "$ROOMS" | python -c "import sys,json; print('OK' if json.load(sys.stdin).get('rooms') else 'KOSONG')" 2>/dev/null)"

# 3. lobby id + kirim
LOBBY=$(echo "$ROOMS" | python -c "import sys,json; rs=json.load(sys.stdin)['rooms']; print(next((r['id'] for r in rs if r.get('isLobby')),rs[0]['id']))" 2>/dev/null)
R=$(curl -s -X POST "$BASE/api/rooms/$LOBBY/messages" -H "Content-Type: application/json" -H "Authorization: Bearer $T" -d '{"content":"qc lobby"}' | python -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('message') else d)" 2>/dev/null)
check "3. kirim lobby" "$R"

# 4. DM ke calculus_1987
DM=$(curl -s -X POST "$BASE/api/dm" -H "Content-Type: application/json" -H "Authorization: Bearer $T" -d '{"username":"calculus_1987"}' | python -c "import sys,json; print(json.load(sys.stdin).get('room',{}).get('id',''))" 2>/dev/null)
check "4. buat DM" "$([ -n "$DM" ] && echo OK || echo GAGAL)"

# 5. kirim DM
R=$(curl -s -X POST "$BASE/api/rooms/$DM/messages" -H "Content-Type: application/json" -H "Authorization: Bearer $T" -d '{"content":"qc dm"}' | python -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('message') else d)" 2>/dev/null)
check "5. kirim DM" "$R"

# 6. partner resolve
P=$(curl -s "$BASE/api/rooms/$DM/dm-partner" -H "Authorization: Bearer $T" | python -c "import sys,json; p=json.load(sys.stdin).get('partner'); print(p.get('username') if p else 'NONE')" 2>/dev/null)
check "6. DM partner" "$([ "$P" = "calculus_1987" ] && echo OK || echo "$P")"

# cleanup
PGBIN="/h/HYPEROOM-SERVER/storage/private/downloads/pgbin/pgsql/bin"
PGPASSWORD='hyperoom_pg_local_dev_2026' "$PGBIN/psql.exe" -h 127.0.0.1 -U postgres -d hyperoom_v2_core -c "DELETE FROM users WHERE username='$U';" >/dev/null 2>&1 || true

echo ""
echo "═══ HASIL: $PASS PASS, $FAIL FAIL ═══"
[ "$FAIL" -eq 0 ] || exit 1