-- Porchlight history store on Tiger Data (TimescaleDB + PostGIS).
-- Idempotent: safe to run again on an existing database.
-- Names follow docs/contract.md ("Tiger Data (history)").

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- readings: per-person sensor / derived readings.
-- kind: home_temp_f, power_out (1/0), phone_offline_min, no_motion_min, battery_pct, ...
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readings (
  time       timestamptz      NOT NULL,
  person_id  bigint           NOT NULL,
  h3_cell    text             NOT NULL,
  kind       text             NOT NULL,
  value      double precision NOT NULL
);
SELECT create_hypertable('readings', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS readings_person_time_idx ON readings (person_id, time DESC);
CREATE INDEX IF NOT EXISTS readings_cell_time_idx   ON readings (h3_cell, time DESC);
CREATE INDEX IF NOT EXISTS readings_kind_time_idx   ON readings (kind, time DESC);

-- ---------------------------------------------------------------------------
-- feed_events: one row per (feed item, H3 res-9 cell) it touches.
-- source: nws_alerts, nws_forecast, fema_shelters, hhs_empower, dallas_police,
--         osm_facilities, census_acs, open_meteo
-- payload: the normalized item (event id, headline, severity, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_events (
  time     timestamptz NOT NULL,
  source   text        NOT NULL,
  h3_cell  text        NOT NULL,
  kind     text        NOT NULL,
  payload  jsonb       NOT NULL DEFAULT '{}'::jsonb
);
SELECT create_hypertable('feed_events', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
-- Re-polling the same item is a no-op (inserts use ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS feed_events_dedupe_idx ON feed_events (time, source, kind, h3_cell);
CREATE INDEX IF NOT EXISTS feed_events_cell_time_idx ON feed_events (h3_cell, time DESC);

-- ---------------------------------------------------------------------------
-- contact_events: every attempt to reach a person.
-- channel: app / voice / sms / neighbor_visit / mesh
-- result:  safe / needs_help / no_answer / sent / failed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_events (
  time       timestamptz NOT NULL,
  person_id  bigint      NOT NULL,
  h3_cell    text        NOT NULL,
  channel    text        NOT NULL,
  result     text        NOT NULL
);
SELECT create_hypertable('contact_events', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS contact_events_person_time_idx ON contact_events (person_id, time DESC);

-- ---------------------------------------------------------------------------
-- cell_5m: per H3 cell per 5 minutes.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS cell_5m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time)                          AS bucket,
  h3_cell,
  avg(value) FILTER (WHERE kind = 'home_temp_f')                   AS avg_home_temp_f,
  min(value) FILTER (WHERE kind = 'home_temp_f')                   AS min_home_temp_f,
  100.0 * avg(CASE WHEN value > 0 THEN 1 ELSE 0 END)
        FILTER (WHERE kind = 'power_out')                          AS pct_power_out,
  count(*)                                                         AS readings,
  count(*) FILTER (WHERE kind = 'power_out')                       AS power_readings,
  count(*) FILTER (WHERE kind = 'power_out' AND value > 0)         AS power_out_readings,
  count(*) FILTER (WHERE kind = 'phone_offline_min' AND value > 0) AS phone_offline_readings
FROM readings
GROUP BY bucket, h3_cell
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cell_5m',
  start_offset      => INTERVAL '1 day',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- ---------------------------------------------------------------------------
-- person_last_contact: per person per 5 minutes, latest attempt and latest success.
-- Read "last contact" as max(last_success) over buckets (see at_risk_now).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS person_last_contact
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time)                     AS bucket,
  person_id,
  last(h3_cell, time)                                         AS h3_cell,
  max(time)                                                   AS last_attempt,
  max(time) FILTER (WHERE result IN ('safe', 'needs_help'))   AS last_success,
  last(channel, time)                                         AS last_channel,
  last(result, time)                                          AS last_result,
  count(*)                                                    AS attempts,
  count(*) FILTER (WHERE result IN ('no_answer', 'failed'))   AS failed_attempts
FROM contact_events
GROUP BY bucket, person_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('person_last_contact',
  start_offset      => INTERVAL '1 day',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- ---------------------------------------------------------------------------
-- Retention (optional; raw rows only, aggregates keep their own history).
-- ---------------------------------------------------------------------------
SELECT add_retention_policy('feed_events', INTERVAL '30 days', if_not_exists => TRUE);
