# Hosting

| Piece | Where |
|---|---|
| Web dashboard (static) | Vultr `207.148.5.196`, Caddy at **https://207-148-5-196.sslip.io** (automatic HTTPS) |
| Twilio SMS / voice webhooks | Same Caddy site, `/sms*` and `/voice*` proxied to the worker on `127.0.0.1:8787` |
| Agent worker | Vultr, systemd `firstline-worker`, code and `.env` in `/opt/firstline/app/agents` (Maincloud, live Twilio) |
| Nemotron (vLLM) | Brev `hope-nemotron`; a `cloudflared` quick tunnel on the Brev box exposes it, and the worker's `NEMOTRON_BASE_URL` is that `*.trycloudflare.com` URL (vLLM still requires the API key) |
| Database | SpacetimeDB Maincloud, database `firstline` |

`Caddyfile` here is a copy of `/etc/caddy/Caddyfile` on the server.

## Publish the dashboard

```bash
deploy/vultr/deploy.sh
```

It builds `web/` with `web/.env.production.local` and swaps `/srv/firstline/web`. Nothing else on
the server changes.

The public dashboard reads as a **viewer** identity: it can read the dashboard views (`dash_person`
without phone numbers, and the `ops_*` views except `ops_person` and `ops_audit_log`) and cannot
call any reducer. Its token is in the public bundle on purpose. One-time grant (module owner):

```bash
spacetime call --server maincloud firstline add_viewer '"0x<viewer identity>"'
```

Rotate it with `remove_viewer`, a new identity (`curl -s -X POST https://maincloud.spacetimedb.com/v1/identity`)
and `add_viewer`, then redeploy.

## Worker and Nemotron

- Logs: `ssh root@207.148.5.196 journalctl -u firstline-worker -f`
- The quick-tunnel URL changes whenever `cloudflared` restarts on the Brev box (or the instance is
  recreated). Then put the new URL in `NEMOTRON_BASE_URL` in `/opt/firstline/app/agents/.env` and
  `systemctl restart firstline-worker`. Check with `sudo -u firstline node test-nemotron.cjs` in that folder.
- The worker code in `/opt/firstline/app` was copied up by hand; update it the same way and restart.
- Phone line: the Twilio number's voice webhook is `https://207-148-5-196.sslip.io/voice/inbound`.
  Numbers in `VOICE_OPERATOR_NUMBERS` (the verified phone) get the operator briefing; a resident's
  registered phone gets their own household; anyone else gets safety guidance only.
