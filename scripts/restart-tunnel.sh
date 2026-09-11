#!/bin/bash
# Auto-restart cloudflared tunnel + update Vercel VITE_API_BASE + redeploy.
# Jalankan sekali: bash restart-tunnel.sh
# (Jalanin ulang tiap saat app "ga nyambung" / PC restart)

set -e
PWA_DIR="H:\\TRISULA_DIGIART\\hyperoom-v2\\apps\\pwa"
LOG="/tmp/cftunnel.log"

echo "[1/4] Stop tunnel lama..."
taskkill //F //IM cloudflared.exe 2>/dev/null || true
sleep 2

echo "[2/4] Start tunnel baru..."
cloudflared tunnel --url http://localhost:3100 > "$LOG" 2>&1 &
sleep 18
URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
if [ -z "$URL" ]; then
  echo "GAGAL dapat URL tunnel. Log:"
  tail -5 "$LOG"
  exit 1
fi
echo "Tunnel URL: $URL"

# health check
sleep 5
CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 20 "$URL/health") 
if [ "$CODE" != "200" ]; then
  echo "Health check gagal ($CODE) — coba lagi dalam 10s..."
  sleep 10
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 20 "$URL/health")
  if [ "$CODE" != "200" ]; then
    echo "Tunnel tidak sehat ($CODE). Abort."
    exit 1
  fi
fi
echo "Tunnel sehat (200)."

echo "[3/4] Update Vercel env VITE_API_BASE..."
cd "$PWA_DIR"
vercel env rm VITE_API_BASE production --yes 2>/dev/null || true
printf '%s' "$URL" | vercel env add VITE_API_BASE production 2>&1 | tail -2

echo "[4/4] Deploy ulang Vercel (biar bundle baru nunjuk tunnel baru)..."
vercel --prod --yes 2>&1 | tail -4

echo ""
echo "=== SELESAI ==="
echo "Tunnel:  $URL"
echo "App:     https://hyperoom.ngulikpc.online"
echo "Catat URL tunnel ini — VITE_API_BASE sudah di-update otomatis."