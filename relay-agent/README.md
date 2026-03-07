# anybrowse relay-agent — Windows deployment

## File location on Windows PC
`C:\anybrowse-relay\agent.js`

## Deploy to Windows (from VPS jump host)
```
ssh root@188.245.220.2
ssh aikin@10.0.0.3
# Copy updated agent.js to the right place
# Or use scp/rsync from the VPS
```

## What was updated (safety controls added)
1. **Domain blocklist** — blocks adult, piracy, gambling domains
2. **Keyword filter** — blocks URLs with porn/xxx/warez/torrent etc.
3. **Private IP block** — prevents SSRF attacks (10.x, 192.168.x, etc.)
4. **Rate limiting** — 60 req/hr normally, 20 req/hr midnight-6am local time
5. **Request logging** — logs url_hash (SHA-256 truncated, not full URL) + status to relay.log

## Restart the agent after deploying
```powershell
# If running as scheduled task or pm2 on Windows:
pm2 restart relay-agent
# Or kill and restart the node process
```

## Environment variables (optional)
- `RELAY_ID` — defaults to `relay_la_windows_primary`
- `SERVER_URL` — defaults to `wss://anybrowse.dev/relay-ws`
