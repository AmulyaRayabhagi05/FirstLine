import { z } from 'zod';
import { getPool, type Queryable } from './client.js';

/** Shape every agent tool in this folder follows. `run` returns plain JSON plus a one-line summary. */
export interface TigerTool<I extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  inputSchema: I;
  run(input: z.input<I>, db?: Queryable): Promise<O & { summary: string }>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const f0 = (v: number) => `${Math.round(v)}°F`;
const minutesSince = (t: Date | string | null, now: number): number | null =>
  t ? Math.max(0, Math.round((now - new Date(t).getTime()) / 60_000)) : null;
const fmtMin = (m: number) => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

// ---------------------------------------------------------------------------
// at_risk_now
// ---------------------------------------------------------------------------

export interface AtRiskPerson {
  person_id: number;
  h3_cell: string;
  score: number;
  reasons: string[];
  temp_now_f: number | null;
  temp_3h_ago_f: number | null;
  power_out: boolean | null;
  phone_offline_min: number | null;
  no_motion_min: number | null;
  minutes_since_contact: number | null;
  failed_attempts_24h: number;
  alert_in_cell: string | null;
  summary: string;
}

const AT_RISK_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (person_id, kind) person_id, kind, value, time, h3_cell
  FROM readings
  WHERE time > now() - interval '24 hours'
  ORDER BY person_id, kind, time DESC
), people AS (
  SELECT person_id,
         (array_agg(h3_cell ORDER BY time DESC))[1]           AS h3_cell,
         max(value) FILTER (WHERE kind = 'home_temp_f')       AS temp_now,
         max(value) FILTER (WHERE kind = 'power_out')         AS power_out,
         max(value) FILTER (WHERE kind = 'phone_offline_min') AS phone_offline_min,
         max(value) FILTER (WHERE kind = 'no_motion_min')     AS no_motion_min
  FROM latest GROUP BY person_id
), early AS (
  SELECT DISTINCT ON (person_id) person_id, value AS temp_then
  FROM readings
  WHERE kind = 'home_temp_f' AND time > now() - interval '3 hours 5 minutes'
  ORDER BY person_id, time ASC
), contact AS (
  SELECT person_id,
         max(last_success) AS last_success,
         coalesce(sum(failed_attempts) FILTER (WHERE bucket > now() - interval '24 hours'), 0) AS failed_24h
  FROM person_last_contact
  GROUP BY person_id
), alerts AS (
  SELECT DISTINCT ON (h3_cell) h3_cell, coalesce(payload->>'event', kind) AS event
  FROM feed_events
  WHERE source = 'nws_alerts' AND time > now() - interval '72 hours'
    AND (payload->>'expires' IS NULL OR (payload->>'expires')::timestamptz > now())
  ORDER BY h3_cell, time DESC
)
SELECT p.*, e.temp_then, c.last_success, coalesce(c.failed_24h, 0) AS failed_24h, a.event AS alert_event
FROM people p
LEFT JOIN early e USING (person_id)
LEFT JOIN contact c USING (person_id)
LEFT JOIN alerts a ON a.h3_cell = p.h3_cell`;

/** Explainable exposure x contact-gap score from Tiger history (vulnerability lives in SpacetimeDB). */
export function scoreRow(row: Record<string, unknown>, now = Date.now()): AtRiskPerson {
  const tempNow = num(row.temp_now);
  const tempThen = num(row.temp_then);
  const powerOut = row.power_out === null || row.power_out === undefined ? null : Number(row.power_out) > 0;
  const phoneOff = num(row.phone_offline_min);
  const noMotion = num(row.no_motion_min);
  const gap = minutesSince(row.last_success as string | null, now);
  const failed = Number(row.failed_24h ?? 0);
  const alert = (row.alert_event as string | null) ?? null;

  let exposure = 1;
  const reasons: string[] = [];
  const bits: string[] = [];
  if (tempNow !== null) {
    if (tempThen !== null && Math.round(tempThen) !== Math.round(tempNow)) bits.push(`${f0(tempThen)} to ${f0(tempNow)} in 3 h`);
    else bits.push(`home ${f0(tempNow)}`);
    if (tempNow < 50) { exposure += 1.5; reasons.push(`home ${f0(tempNow)} (dangerously cold)`); }
    else if (tempNow < 60) { exposure += 0.7; reasons.push(`home ${f0(tempNow)} (cold)`); }
    else if (tempNow > 90) { exposure += 1.2; reasons.push(`home ${f0(tempNow)} (heat)`); }
    if (tempThen !== null && tempThen - tempNow >= 8) { exposure += 0.6; reasons.push(`temp fell ${Math.round(tempThen - tempNow)}°F in 3 h`); }
  }
  if (powerOut) { exposure += 0.8; reasons.push('power out'); bits.push('power out'); }
  if (alert) { exposure += 0.5; reasons.push(`${alert} in cell`); }

  let contact = 1;
  if (phoneOff !== null && phoneOff > 0) {
    contact += Math.min(phoneOff, 240) / 60;
    reasons.push(`phone offline ${fmtMin(Math.round(phoneOff))}`);
    bits.push(`phone offline ${fmtMin(Math.round(phoneOff))}`);
  }
  if (noMotion !== null && noMotion >= 60) { contact += 0.5; reasons.push(`no motion ${fmtMin(Math.round(noMotion))}`); }
  if (gap === null) { contact += 1; reasons.push('never reached'); bits.push('never reached'); }
  else if (gap >= 30) { contact += Math.min(gap, 360) / 120; reasons.push(`no contact ${fmtMin(gap)}`); bits.push(`no contact ${fmtMin(gap)}`); }
  if (failed > 0) { contact += Math.min(failed, 5) * 0.3; reasons.push(`${failed} failed attempt${failed > 1 ? 's' : ''} today`); }

  const score = Math.round(exposure * contact * 100) / 100;
  return {
    person_id: Number(row.person_id),
    h3_cell: String(row.h3_cell),
    score,
    reasons,
    temp_now_f: tempNow,
    temp_3h_ago_f: tempThen,
    power_out: powerOut,
    phone_offline_min: phoneOff,
    no_motion_min: noMotion,
    minutes_since_contact: gap,
    failed_attempts_24h: failed,
    alert_in_cell: alert,
    summary: `person ${row.person_id}: ${bits.join(', ') || 'no recent readings'}`,
  };
}

const atRiskInput = z.object({
  limit: z.number().int().min(1).max(200).default(10).describe('How many people to return, highest risk first'),
});

export const atRiskNow: TigerTool<typeof atRiskInput, { people: AtRiskPerson[] }> = {
  name: 'at_risk_now',
  description:
    'Rank people with readings in the last 24 h by exposure (home temperature and its 3 h trend, power, NWS alert in their cell) times contact gap (phone offline, minutes since last successful contact, failed attempts). Returns each person with reasons and a one-line summary.',
  inputSchema: atRiskInput,
  async run(input, db = getPool()) {
    const { limit } = atRiskInput.parse(input ?? {});
    const { rows } = await db.query(AT_RISK_SQL);
    const now = Date.now();
    const people = rows.map((r) => scoreRow(r, now)).sort((a, b) => b.score - a.score).slice(0, limit);
    const summary = people.length
      ? `${people.length} at risk; top: ${people[0].summary} (score ${people[0].score})`
      : 'No people with readings in the last 24 h';
    return { people, summary };
  },
};

// ---------------------------------------------------------------------------
// cell_trend
// ---------------------------------------------------------------------------

const cellTrendInput = z.object({
  h3_cell: z.string().min(1).describe('H3 res-9 cell (hex string)'),
  hours: z.number().min(0.25).max(168).default(6).describe('Look-back window in hours'),
});

export interface CellBucket {
  bucket: string;
  avg_home_temp_f: number | null;
  min_home_temp_f: number | null;
  pct_power_out: number | null;
  readings: number;
  phone_offline_readings: number;
}

export const cellTrend: TigerTool<
  typeof cellTrendInput,
  { h3_cell: string; hours: number; buckets: CellBucket[]; feed_events: Array<{ time: string; source: string; kind: string; headline: string | null }> }
> = {
  name: 'cell_trend',
  description:
    'Five-minute trend for one H3 cell over the last N hours: average and minimum home temperature, percent of homes with power out, phone-offline readings, plus feed events (NWS alerts, police calls, shelters) that touched the cell.',
  inputSchema: cellTrendInput,
  async run(input, db = getPool()) {
    const { h3_cell, hours } = cellTrendInput.parse(input);
    const [agg, feeds] = await Promise.all([
      db.query(
        `SELECT bucket, avg_home_temp_f, min_home_temp_f, pct_power_out, readings, phone_offline_readings
         FROM cell_5m WHERE h3_cell = $1 AND bucket > now() - make_interval(secs => $2 * 3600)
         ORDER BY bucket`,
        [h3_cell, hours],
      ),
      db.query(
        `SELECT time, source, kind, coalesce(payload->>'headline', payload->>'event', payload->>'name', payload->>'nature_of_call') AS headline
         FROM feed_events WHERE h3_cell = $1 AND time > now() - make_interval(secs => $2 * 3600)
           AND source NOT IN ('hhs_empower', 'census_acs', 'osm_facilities')
         ORDER BY time DESC LIMIT 50`,
        [h3_cell, hours],
      ),
    ]);
    const buckets: CellBucket[] = agg.rows.map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      avg_home_temp_f: num(r.avg_home_temp_f),
      min_home_temp_f: num(r.min_home_temp_f),
      pct_power_out: num(r.pct_power_out),
      readings: Number(r.readings),
      phone_offline_readings: Number(r.phone_offline_readings),
    }));
    const feed_events = feeds.rows.map((r) => ({ time: new Date(r.time).toISOString(), source: r.source, kind: r.kind, headline: r.headline }));

    const parts: string[] = [];
    const temps = buckets.filter((b) => b.avg_home_temp_f !== null);
    if (temps.length) {
      const a = temps[0].avg_home_temp_f!, b = temps[temps.length - 1].avg_home_temp_f!;
      parts.push(Math.round(a) === Math.round(b) ? `avg home ${f0(b)}` : `avg home ${f0(a)} to ${f0(b)} in ${hours} h`);
    }
    const pw = buckets.filter((b) => b.pct_power_out !== null);
    if (pw.length) parts.push(`${Math.round(pw[pw.length - 1].pct_power_out!)}% power out`);
    const alerts = [...new Set(feed_events.filter((f) => f.source === 'nws_alerts').map((f) => f.headline ?? f.kind))];
    if (alerts.length) parts.push(alerts.slice(0, 2).join('; '));
    const calls = feed_events.filter((f) => f.source === 'dallas_police').length;
    if (calls) parts.push(`${calls} police call${calls > 1 ? 's' : ''}`);
    const summary = `cell ${h3_cell}: ${parts.join(', ') || `no data in last ${hours} h`}`;
    return { h3_cell, hours, buckets, feed_events, summary };
  },
};

// ---------------------------------------------------------------------------
// person_timeline
// ---------------------------------------------------------------------------

const personTimelineInput = z.object({
  person_id: z.number().int().nonnegative().describe('Porchlight person id'),
  hours: z.number().min(1).max(168).default(24).describe('Look-back window in hours'),
});

export interface TimelineEntry {
  time: string;
  type: 'reading' | 'contact' | 'feed';
  kind: string;
  value?: number;
  detail?: string;
}

export const personTimeline: TigerTool<
  typeof personTimelineInput,
  { person_id: number; h3_cell: string | null; entries: TimelineEntry[] }
> = {
  name: 'person_timeline',
  description:
    "One person's history, newest first: readings (home temperature, power, phone offline), every contact attempt and its result, and NWS alerts in their cell. Use it to explain why someone is flagged.",
  inputSchema: personTimelineInput,
  async run(input, db = getPool()) {
    const { person_id, hours } = personTimelineInput.parse(input);
    const win = [String(person_id), hours];
    const [readings, contacts] = await Promise.all([
      db.query(
        `SELECT time, h3_cell, kind, value FROM readings
         WHERE person_id = $1 AND time > now() - make_interval(secs => $2 * 3600) ORDER BY time DESC LIMIT 500`,
        win,
      ),
      db.query(
        `SELECT time, h3_cell, channel, result FROM contact_events
         WHERE person_id = $1 AND time > now() - make_interval(secs => $2 * 3600) ORDER BY time DESC LIMIT 200`,
        win,
      ),
    ]);
    const h3_cell: string | null = readings.rows[0]?.h3_cell ?? contacts.rows[0]?.h3_cell ?? null;
    const feeds = h3_cell
      ? await db.query(
          `SELECT time, source, kind, coalesce(payload->>'headline', payload->>'event') AS headline FROM feed_events
           WHERE h3_cell = $1 AND source IN ('nws_alerts', 'dallas_police') AND time > now() - make_interval(secs => $2 * 3600)
           ORDER BY time DESC LIMIT 50`,
          [h3_cell, hours],
        )
      : { rows: [] as any[] };

    const entries: TimelineEntry[] = [
      ...readings.rows.map((r) => ({ time: new Date(r.time).toISOString(), type: 'reading' as const, kind: r.kind, value: Number(r.value) })),
      ...contacts.rows.map((r) => ({ time: new Date(r.time).toISOString(), type: 'contact' as const, kind: r.channel, detail: r.result })),
      ...feeds.rows.map((r) => ({ time: new Date(r.time).toISOString(), type: 'feed' as const, kind: `${r.source}:${r.kind}`, detail: r.headline ?? undefined })),
    ].sort((a, b) => b.time.localeCompare(a.time));

    // Summary: temp trend over ~3 h, phone offline, last contact.
    const now = Date.now();
    const temps = readings.rows.filter((r) => r.kind === 'home_temp_f');
    const parts: string[] = [];
    if (temps.length) {
      const latest = temps[0];
      const cutoff = new Date(latest.time).getTime() - 3 * 3600_000;
      const older = [...temps].reverse().find((r) => new Date(r.time).getTime() >= cutoff) ?? latest;
      const spanH = Math.max(1, Math.round((new Date(latest.time).getTime() - new Date(older.time).getTime()) / 3600_000));
      parts.push(
        Math.round(older.value) === Math.round(latest.value)
          ? `home ${f0(Number(latest.value))}`
          : `${f0(Number(older.value))} to ${f0(Number(latest.value))} in ${spanH} h`,
      );
    }
    const power = readings.rows.find((r) => r.kind === 'power_out');
    if (power && Number(power.value) > 0) parts.push('power out');
    const phone = readings.rows.find((r) => r.kind === 'phone_offline_min');
    if (phone && Number(phone.value) > 0) parts.push(`phone offline ${fmtMin(Math.round(Number(phone.value)))}`);
    const lastOk = contacts.rows.find((r) => r.result === 'safe' || r.result === 'needs_help');
    if (lastOk) parts.push(`last reached ${fmtMin(minutesSince(lastOk.time, now)!)} ago (${lastOk.result} via ${lastOk.channel})`);
    else if (contacts.rows.length) parts.push(`${contacts.rows.length} attempt${contacts.rows.length > 1 ? 's' : ''}, never reached`);
    const alert = feeds.rows.find((r) => r.source === 'nws_alerts');
    if (alert) parts.push(alert.headline ?? alert.kind);

    return { person_id, h3_cell, entries, summary: `person ${person_id}: ${parts.join(', ') || `no history in last ${hours} h`}` };
  },
};

export const tigerTools = [atRiskNow, cellTrend, personTimeline] as const;
