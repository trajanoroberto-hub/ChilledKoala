#!/bin/bash
# Chilled Koala — VPS deploy script
# Spawned detached by POST /api/deploy webhook. Runs independently of the
# Node.js process so it survives the systemctl restart that kills the server.
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

echo "==> Installing systemd service..."
cp chilled-koala.service /etc/systemd/system/chilled-koala.service
systemctl daemon-reload
systemctl enable chilled-koala

echo "==> Restarting service..."
pkill -f 'node /opt/chilled_koala/server.js' || true
sleep 1
systemctl restart chilled-koala

echo "=== Deploy complete: $(date) ==="
