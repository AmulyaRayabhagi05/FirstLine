#!/usr/bin/env bash
# Play the storm night (8 pm to 8 am, 720 storm minutes) into the seeded demo database.
# SPEED is storm minutes per real minute: 240 plays the night in 3 minutes.
#
#   scripts/demo-storm.sh            # whole night at 240x
#   SPEED=120 TO=360 scripts/demo-storm.sh
#
# Use the same N and SEED as demo-reset.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS=(--n "${N:-1000}" --seed "${SEED:-20210214}" --storm-only --speed "${SPEED:-240}")
[ -n "${FROM:-}" ] && ARGS+=(--from "$FROM")
[ -n "${TO:-}" ] && ARGS+=(--to "$TO")
SPACETIME_DB_NAME="${DB:-firstline}" exec npx --prefix sim tsx sim/src/cli/loadLive.ts "${ARGS[@]}"
