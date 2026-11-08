#!/usr/bin/env bash
# Reset the local demo database and seed the Dallas residents, the same way every time.
#
#   scripts/demo-reset.sh [dashboard-identity ...]
#
# Needs `spacetime start` running (local server on 127.0.0.1:3000) and the spacetime CLI logged
# in as the identity that owns the local `firstline` database. Pass the identity the dashboard
# shows in its bottom bar ("Grant 0x...") to make that browser staff; it survives resets because
# the browser keeps its token.
#
# Env: DB (default firstline), N residents (default 1000), SEED (default 20210214).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DB:-firstline}"
N="${N:-1000}"
SEED="${SEED:-20210214}"
ROOT="$(pwd)"

call() { spacetime call --server local -- "$DB" "$@" >/dev/null; }
whoami_at() { # token path -> identity hex
  SPACETIME_DB_NAME="$DB" SPACETIME_TOKEN_PATH="$1" npx --prefix sim tsx sim/src/cli/loadLive.ts --whoami 2>/dev/null \
    | sed -n 's/^identity \([0-9a-f]*\) .*/\1/p' | head -n1
}

echo "== publishing $DB with a clean database"
spacetime publish "$DB" --server local --module-path server --delete-data=always --yes >/dev/null

echo "== identities"
LOADER="$(whoami_at "$ROOT/sim/.spacetime-token-loader")"
WORKER="$(whoami_at "$ROOT/agents/.spacetime-token-local")"
[ -n "$LOADER" ] && [ -n "$WORKER" ] || { echo "could not read loader/worker identity"; exit 1; }
echo "loader 0x$LOADER"
echo "worker 0x$WORKER"

echo "== roles"
call set_worker_identity "\"0x$WORKER\""
call add_staff "\"0x$LOADER\""
for id in "$@"; do
  id="${id#0x}"
  call add_staff "\"0x$id\""
  echo "dashboard staff 0x$id"
done

echo "== seeding $N Dallas residents (seed $SEED)"
SPACETIME_DB_NAME="$DB" npx --prefix sim tsx sim/src/cli/loadLive.ts --n "$N" --seed "$SEED" | grep -E "^loaded|^identity"

echo "== done. Restart the worker (scripts/demo-worker.sh) and reload the dashboard."
