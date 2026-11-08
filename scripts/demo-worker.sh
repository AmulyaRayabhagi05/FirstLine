#!/usr/bin/env bash
# Run the agent worker against the local demo database with the live Dallas feeds on.
# Outbound SMS/calls, inbound SMS and mesh are OFF: the demo residents are synthetic and their
# phone numbers are fake, so nothing may be sent to a real phone. Comms are logged instead.
# The Nemotron endpoint and Tiger Data still come from agents/.env.
set -euo pipefail
cd "$(dirname "$0")/../agents"
export SPACETIME_HOST="${SPACETIME_HOST_LOCAL:-http://127.0.0.1:3000}"
export SPACETIME_DB_NAME="${DB:-firstline}"
export SPACETIME_TOKEN_PATH="$(pwd)/.spacetime-token-local"
export CHANNEL_SMS=0 CHANNEL_MESH=0 FEEDS=1
export TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM_NUMBER=
exec npx tsx src/index.ts
