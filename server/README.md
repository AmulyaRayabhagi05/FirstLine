# server

Porchlight's SpacetimeDB module, written in TypeScript (SpacetimeDB CLI 2.14). It holds every
table and reducer named in [`docs/contract.md`](../docs/contract.md): people, households, safety
nets, SOS events, check-ins, triage, assignments, key passes, incident reports, the agents'
reasoning steps (`agent_step`) and the audit log. Source: [`src/index.ts`](src/index.ts).

## Run locally

```bash
spacetime start                      # terminal 1: local server on http://127.0.0.1:3000
cd server
npm install
spacetime publish porchlight --server local --module-path . --yes
```

Add `--delete-data=always` to wipe the database when the schema changes in a way that can't
migrate. Logs: `spacetime logs porchlight --server local -f`.

After the first publish, connect the agent worker (the publisher's identity is the module owner):

```bash
spacetime call --server local porchlight set_worker_identity '"0x<worker identity hex>"'
```

This works once. Worker-only reducers (`save_triage`, `assign_helper`, `escalate`,
`save_incident_report`, `log_agent_step`, `set_priority`, `set_cell_alert`, `set_cell_census`)
refuse every other identity.

Owner-only helpers for demos: `set_timing(assignment_timeout_secs, key_pass_ttl_secs)` shortens
the 10-minute assignment timeout and 4-hour key pass (0 keeps the current value), and
`recount_now()` refreshes `hex_cell` without waiting for the 30-second timer (the worker may call
it too).

Calling reducers from the CLI: strings are JSON (`'"text"'`), options are `'{"some":0.9}'` or
`'{"none":[]}'`, and put `--` before the database name when an argument is negative:
`spacetime call -s local -- porchlight press_sos '"c1"' 1 '"help"' 32.98 -96.75 '"app"'`.

## Smoke test

```bash
spacetime start                      # if not already running
cd server
npm install
node test/smoke.mjs                  # or: npm run smoke
```

It publishes a separate database, `porchlight-smoke`, with fresh data, then checks: 3 people
registered with the right res-9 `h3_cell`, input validation, safety net replace, `press_sos` and
`check_in` idempotent on `client_id`, worker-only reducers refusing an anonymous identity,
assign / decline / accept, key pass refused without an SOS for that household or without
approval, granted with both, `log_unlock`, revoke, unlock after revoke refused, the audit log
row for every key-pass call, assignment timeout and key pass expiry (timers shortened to 5 s
and 8 s), the scheduled 30-second recount, `coverage_gap`, `mark_safe`, `escalate` and
incident reports. Takes about a minute. Env: `STDB_SERVER` (default `local`), `STDB_DB`
(default `porchlight-smoke`), `SKIP_PUBLISH=1`.

## Client bindings

Generated TypeScript bindings live in `agents/src/module_bindings/` and
`sim/src/module_bindings/`. Regenerate after any schema change:

```bash
cd server
spacetime generate --lang typescript --out-dir ../agents/src/module_bindings --module-path . --yes
spacetime generate --lang typescript --out-dir ../sim/src/module_bindings --module-path . --yes
```

Wire names are exactly the contract's snake_case names. The generated client code exposes them
camelCase (row field `h3Cell` maps to column `h3_cell`, reducer `pressSos` calls `press_sos`).

## Behaviour worth knowing

- `h3_cell` is computed in the module with `h3-js` (resolution 9) from `lat`/`lng` in
  `register_person` and `press_sos`. `src/textdecoder_shim.ts` makes `h3-js` load in the module
  runtime, so keep its import above `h3-js`.
- Case conversion is turned off (`CaseConversionPolicy.None`) so names stay as in the contract.
- **Key pass refusals do not throw.** A thrown error rolls back the transaction, which would
  also drop the audit row, so `grant_key_pass`, `revoke_key_pass` and `log_unlock` record a
  refusal as an `audit_log` row (`action` like `grant_key_pass_denied:no_active_sos`,
  `log_unlock_denied:expired`) and return. Check for the `key_pass` row or the audit row, not the
  call's error. Malformed input (e.g. an over-long `approved_by`) still errors.
- `grant_key_pass` needs an `open`/`assigned`/`escalated` SOS whose person lives in that
  household, a non-empty `approved_by`, and an existing helper.
- `revoke_key_pass` is allowed for a resident of the household (by identity), the identity
  named in `approved_by`, the module owner or the worker.
- `accept_assignment` / `decline_assignment` must come from the helper's own identity (the one
  that registered them), the worker or the owner.
- `check_in` with `no_answer` stores the row but leaves `status` and `last_seen` alone.
- `mark_safe` sets the person safe, writes a `neighbor_visit` check-in, resolves their active
  SOS events and marks accepted assignments `done`.
- `coverage_gap` is true when `census_elderly_estimate >= 10` and registered people in the cell
  are under 25% of it.
- Households start with `has_smart_lock` and `lockbox` false; no reducer sets them yet.
- Scheduled reducers (`assignment_timeout`, `expire_key_pass`, `recount_cells`) are private, so
  clients cannot call them.
