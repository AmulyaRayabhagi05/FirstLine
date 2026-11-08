# Hosting on Vultr

| Piece | Where |
|---|---|
| Web dashboard (static) | Vultr, served by Caddy with automatic HTTPS |
| Agent worker | Vultr, systemd `firstline-worker` |
| Nemotron (vLLM) | Brev GPU box, reached through the systemd `firstline-brev-tunnel` SSH tunnel |
| Database | SpacetimeDB Maincloud, database `firstline` |

The public dashboard reads through a **viewer** identity: it can read the dashboard views
(`dash_person` without phone numbers, and the `ops_*` views except `ops_person` and
`ops_audit_log`) and cannot call any reducer. Its token is in the public JS bundle on purpose.
Rotate it with `remove_viewer` + `add_viewer`.

## First time

1. Create an Ubuntu 24.04 Cloud Compute server (2 GB) in Vultr with your SSH key.
2. Site host: a domain pointed at the IP, or free `<ip-with-dashes>.sslip.io`.
3. On the server: `curl -fsSL https://raw.githubusercontent.com/Spikestar05/FirstLine/main/deploy/vultr/setup.sh | bash -s <site-host>`
   (or copy `setup.sh` up and run `bash setup.sh <site-host>` as root).
4. Viewer token, once (owner machine):
   ```bash
   curl -s -X POST https://maincloud.spacetimedb.com/v1/identity   # {"identity":..., "token":...}
   spacetime call --server maincloud firstline add_viewer '"0x<identity>"'
   ```
   `web/.env.production.local` (git-ignored):
   ```
   VITE_SPACETIME_HOST=https://maincloud.spacetimedb.com
   VITE_SPACETIME_DB=firstline
   VITE_SPACETIME_TOKEN=<viewer token>
   ```
5. From the laptop: `deploy/vultr/deploy.sh <server-ip> --brev`

## Updates

`deploy/vultr/deploy.sh <server-ip>` rebuilds and uploads the dashboard, pulls `main` for the
worker, copies `agents/.env` and the worker token, and restarts everything.

Logs: `journalctl -u firstline-worker -f`, `journalctl -u firstline-brev-tunnel -f`.

If the Brev instance is deleted and recreated, its IP and authorized keys change: run
`deploy.sh <server-ip> --brev` again (and update `NEMOTRON_API_KEY` in `agents/.env`).
