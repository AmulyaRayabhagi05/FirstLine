# Porchlight (repo: Hope)

Disaster-response app built at HackUTD. People in trouble send an SOS from their phone,
responders see it on a live map, and Nemotron agents help triage and plan.

## Layout

| Folder | What lives there |
|---|---|
| `server/` | SpacetimeDB module (TypeScript): tables, reducers and timers, the backend |
| `web/` | React map dashboard for responders |
| `mobile/` | SOS app for people who need help |
| `agents/` | Node.js worker that runs the Nemotron agents (triage, planning, tool use) |
| `db/` | Tiger Data (Timescale) SQL: hypertables and aggregates |
| `sim/` | Scripts that generate fake disaster data for demos and testing |
| `docs/` | Setup guides and notes |

## Model hosting

The agents call NVIDIA Nemotron through an OpenAI-compatible API served by vLLM on an
NVIDIA Brev GPU instance. See [docs/brev-setup.md](docs/brev-setup.md).

## Secrets

This repo is public. Never commit keys, tokens or URLs with credentials.
Real values go only in `agents/.env` (git-ignored). Copy `agents/.env.example` to start.
