#!/bin/bash
# Chilled Koala v2.0.0 — Upgrade / Fresh-Install Script
# Run from /opt/chilled_koala after uploading the zip.
# Usage: bash upgrade.sh
set -euo pipefail

ZIPFILE="chilled_koala_v2.0.0.zip"
APP="chilled_koala"
PORT=3100

# ── Verify zip ────────────────────────────────────────────────────────────────
if [ ! -f "$ZIPFILE" ]; then
    echo "ERROR: $ZIPFILE not found in $(pwd)"
    echo "Upload it first:"
    echo "  scp $ZIPFILE root@<VPS-IP>:/opt/chilled_koala/"
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   🐨  Chilled Koala — Upgrade / Install     ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Stop (NEVER pm2 delete or pm2 kill — disconnects SSH) ─────────────────
echo "[1/6] Stopping $APP..."
pm2 stop "$APP" 2>/dev/null || true
pm2 flush "$APP" 2>/dev/null || true

# ── 2. Remove old app files ───────────────────────────────────────────────────
echo "[2/6] Removing old files..."
rm -f server.js auth.js console.js library.js playlist.js \
      mixer.js player.js webrtc.js \
      config.ini package.json README.txt \
      app.js style.css index.html login.html call.html \
      mediasoup-client.js
rm -rf sessions/
# node_modules is preserved — npm install only adds/updates what changed

# ── 3. Extract ────────────────────────────────────────────────────────────────
echo "[3/6] Extracting $ZIPFILE..."
unzip -o -q "$ZIPFILE"
rm -f "$ZIPFILE"

# ── 4. npm install ────────────────────────────────────────────────────────────
echo "[4/6] Installing dependencies..."
npm install --production 2>&1 | tail -3
echo "      opusscript:       $([ -d node_modules/opusscript ]       && echo 'OK' || echo 'MISSING - FATAL')"
echo "      mediasoup:        $([ -d node_modules/mediasoup ]         && echo 'OK' || echo 'MISSING - FATAL')"
[ -d node_modules/opusscript ] || { echo "FATAL: opusscript not installed"; exit 1; }
# mediasoup-client browser bundle is pre-built and shipped inside the zip
echo "      mediasoup-client OK: $(du -sh mediasoup-client.js | cut -f1)"

# ── 5. Sessions dir (fresh — forces re-login after upgrade) ──────────────────
echo "[5/6] Preparing sessions..."
mkdir -p sessions
chmod 700 sessions

# ── 6. Start ──────────────────────────────────────────────────────────────────
echo "[6/6] Starting $APP..."
if pm2 describe "$APP" > /dev/null 2>&1; then
    pm2 restart "$APP"
else
    pm2 start server.js --name "$APP"
fi
pm2 save --force

# ── Health check ──────────────────────────────────────────────────────────────
echo ""
echo "Waiting for app to start..."
sleep 4

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/health" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ]; then
    echo ""
    echo "╔══════════════════════════════════════════════╗"
    echo "║   ✓  Chilled Koala is running               ║"
    echo "╚══════════════════════════════════════════════╝"
    curl -s "http://localhost:$PORT/api/health" | grep -E '"(version|streaming|libraryTracks|uptime)"' || true
else
    echo ""
    echo "╔══════════════════════════════════════════════╗"
    echo "║   ✗  Health check failed (HTTP $HTTP)        ║"
    echo "╚══════════════════════════════════════════════╝"
    echo ""
    pm2 logs "$APP" --lines 20 --nostream
    exit 1
fi

echo ""
pm2 status
echo ""
echo "Hard-refresh browser: Ctrl+Shift+R (Windows/Linux) | Cmd+Shift+R (Mac)"
echo ""
