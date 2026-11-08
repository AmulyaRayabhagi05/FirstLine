# Tiger Data (TimescaleDB + PostGIS) history store

`schema.sql` creates everything FirstLine keeps as history. It is idempotent: run it as often
as you like.

| Object | What it is |
|---|---|
| `readings(time, person_id, h3_cell, kind, value)` | hypertable. Kinds used by the worker/sim: `home_temp_f`, `power_out` (1/0), `phone_offline_min`, `no_motion_min`. |
| `feed_events(time, source, h3_cell, kind, payload jsonb)` | hypertable. One row per feed item per H3 res-9 cell. Unique on `(time, source, kind, h3_cell, payload->>'id')` so re-polls are no-ops. 30-day retention. |
| `contact_events(time, person_id, h3_cell, channel, result)` | hypertable. Every attempt to reach someone. `result` in `safe` / `needs_help` / `no_answer` / `sent` / `failed`. |
| `cell_5m` | continuous aggregate per `h3_cell` per 5 min: `avg_home_temp_f`, `min_home_temp_f`, `pct_power_out`, `readings`, `power_readings`, `power_out_readings`, `phone_offline_readings`. Refreshed every minute, real-time (`materialized_only = false`). |
| `person_last_contact` | continuous aggregate per person per 5 min: `last_attempt`, `last_success`, `last_channel`, `last_result`, `attempts`, `failed_attempts`. Take `max(last_success)` across buckets for "last contact". |

## Apply to Tiger Cloud

1. Create a Tiger Cloud service (Time-series + PostGIS; both extensions are available on Tiger Cloud).
2. Copy its connection string into `agents/.env` as `TIGER_DATABASE_URL=postgres://...?sslmode=require`.
3. From the repo root:

```bash
psql "$TIGER_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tiger/schema.sql
```

No `psql`? `cd agents && npx tsx src/tiger/apply-schema.ts` does the same using `TIGER_DATABASE_URL`.

## Local testing

```bash
docker run -d --name firstline-tsdb -e POSTGRES_PASSWORD=firstline -p 55432:5432 timescale/timescaledb-ha:pg17
```

Then `TIGER_TEST_DATABASE_URL=postgres://postgres:firstline@localhost:55432/postgres npm test` in
`agents/`. The SQL tests skip cleanly when that variable is unset or the database is unreachable.

## Notes for tool authors

- Continuous aggregates are refreshed by a 1-minute policy. Rows inserted into a range the policy
  already materialized stay invisible to the aggregate until its next run, so `at_risk_now` reads
  the last 24 h of `contact_events` raw and only uses `person_last_contact` for older history.
- Verified on `timescale/timescaledb-ha:pg17` (TimescaleDB 2.31, PostGIS): schema applies cleanly
  and re-applies as a no-op.
