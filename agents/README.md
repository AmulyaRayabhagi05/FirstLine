# agents

Node.js worker that runs the Nemotron agents (multi-step triage and planning with tool use).
It talks to the model through an OpenAI-compatible endpoint (`/v1/chat/completions`).

## Setup

1. Copy `.env.example` to `.env` and fill in the values. `.env` is git-ignored; never commit it.
2. Make sure the model endpoint is up (see `../docs/brev-setup.md`).
