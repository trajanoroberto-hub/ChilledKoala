#!/bin/bash
# Chilled Koala — VPS deploy script
# Spawned detached by POST /api/deploy webhook. Uses PM2 to restart.
set -e

LOG=/var/log/chilled-koala-deploy.log
exec >> "$LOG" 2>&1

echo ""
echo "=== Deploy started: $(date) ==="

cd /opt/chilled_koala

echo "==> git pull..."
git pull origin main

echo "==> npm install..."
npm install --production

echo "==> Restarting via PM2..."
pm2 restart chilled_koala

echo "=== Deploy complete: $(date) ==="
