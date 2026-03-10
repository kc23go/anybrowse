#!/bin/bash
# Security fixes that require direct server access
# Run: ssh root@89.167.38.219 'bash -s' < server-security-fixes.sh

set -e

echo "=== CRITICAL #1: Fix file permissions ==="
chmod 600 /agent/app/src/production-env 2>/dev/null && echo "chmod 600 /agent/app/src/production-env: OK" || echo "SKIP: not found"
chmod 600 /agent/app/production-env 2>/dev/null && echo "chmod 600 /agent/app/production-env: OK" || echo "SKIP: not found"
ls -la /agent/app/src/production-env 2>/dev/null || true
ls -la /agent/app/production-env 2>/dev/null || true

chmod 640 /agent/data/anybrowse.db 2>/dev/null || true
chmod 640 /agent/data/request-log.jsonl 2>/dev/null || true
chmod 640 /agent/data/config.json 2>/dev/null || true
chmod 640 /agent/data/leads.csv 2>/dev/null || true
chmod 640 /agent/data/scrape-log.jsonl 2>/dev/null || true
echo "Data file permissions:"
ls -la /agent/data/ 2>/dev/null || true

echo ""
echo "=== HIGH #1: Create dedicated app user (non-root) ==="
echo "NOTE: App is currently running as root under pm2."
echo "Creating user but NOT switching pm2 to avoid breaking deployment."
id anybrowse 2>/dev/null || useradd -r -s /sbin/nologin -d /agent anybrowse
echo "User 'anybrowse' exists. To switch pm2, update ecosystem.config.js with user:'anybrowse'"
echo "and test manually before enabling."

echo ""
echo "=== HIGH #2: Bind internal services to localhost ==="
echo "Checking exposed ports..."
ss -tlnp | grep -E '3100|8317' || echo "No extra exposed ports on 3100/8317"

# Check if nexus-ai is bound to 0.0.0.0 on port 3100
if ss -tlnp | grep -q ':3100.*0.0.0.0'; then
  echo "nexus-ai port 3100 is exposed on 0.0.0.0 - should bind to 127.0.0.1"
  echo "To fix: add HOST=127.0.0.1 to nexus-ai pm2 config and restart"
fi

echo ""
echo "=== MEDIUM: nginx server_tokens off ==="
grep -q 'server_tokens' /etc/nginx/nginx.conf 2>/dev/null || {
  sed -i 's/http {/http {\n    server_tokens off;/' /etc/nginx/nginx.conf
  echo "Added server_tokens off to nginx.conf"
}
nginx -t 2>&1 && nginx -s reload 2>&1 && echo "nginx reloaded OK" || echo "nginx reload failed - check config"

echo ""
echo "=== Done ==="
