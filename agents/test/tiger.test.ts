import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/tiger/client.js';
import { applySchema } from '../src/tiger/apply-schema.js';
import { insertContactEvent, insertFeedEvent, insertReading } from '../src/tiger/insert.js';
import { atRiskNow, cellTrend, personTimeline, scoreRow, tigerTools } from '../src/tiger/tools.js';
import { pointCell } from '../src/feeds/util.js';

describe('tool objects', () => {
  it('export name, description, zod inputSchema and run', () => {
    expect(tigerTools.map((t) => t.name)).toEqual(['at_risk_now', 'cell_trend', 'person_timeline']);
    for (const t of tigerTools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(typeof t.run).toBe('function');
      expect(typeof t.inputSchema.parse).toBe('function');
    }
    expect(atRiskNow.inputSchema.parse({})).toEqual({ limit: 10 });
    expect(() => cellTrend.inputSchema.parse({ hours: 3 })).toThrow();
  });
});

describe('scoreRow (pure)', () => {
  it('ranks a cold, unreachable person above a warm, reached one and explains why', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const cold = scoreRow({ person_id: '1', h3_cell: 'x', temp_now: 49, temp_then: 68, power_out: 1, phone_offline_min: 90, last_success: null, failed_24h: 2, alert_event: 'Winter Storm Warning' }, now);
    const warm = scoreRow({ person_id: '2', h3_cell: 'x', temp_now: 70, temp_then: 70, power_out: 0, phone_offline_min: 0, last_success: '2026-11-08T11:55:00Z', failed_24h: 0, alert_event: null }, now);
    expect(cold.score).toBeGreaterThan(warm.score * 5);
    expect(cold.summary).toBe('person 1: 68°F to 49°F in 3 h, power out, phone offline 90 min, never reached');
    expect(cold.reasons).toContain('Winter Storm Warning in cell');
    expect(warm.summary).toBe('person 2: home 70°F');
  });
});

// ---------------------------------------------------------------------------
// SQL against a real TimescaleDB. Set TIGER_TEST_DATABASE_URL to a server you can CREATE DATABASE on,
// e.g. postgres://postgres:firstline@localhost:55432/postgres (see db/tiger/README.md).
// ---------------------------------------------------------------------------
const ADMIN_URL = process.env.TIGER_TEST_DATABASE_URL;

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const dbUp = await reachable(ADMIN_URL);
if (!dbUp) console.warn('[tiger.test] SQL tests skipped: set TIGER_TEST_DATABASE_URL to a reachable TimescaleDB');

describe.skipIf(!dbUp)('Tiger SQL (local TimescaleDB)', () => {
  const dbName = `firstline_test_${Date.now()}`;
  let pool: pg.Pool;
  const cell = pointCell(32.7767, -96.797);
  const otherCell = pointCell(32.9, -96.7);
  // One fixed base time: each ago() call must return the same instant for the same offset,
  // or rows meant to be duplicates (same time/source/kind/cell/id) differ by a millisecond.
  const T0 = Date.now();
  const ago = (min: number) => new Date(T0 - min * 60_000);

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    pool = createPool(u.toString());
    await applySchema(pool);
    await applySchema(pool); // idempotent

    // Person 40: home cooling from 68 to 49 over 3 h, power out, phone offline 90 min, two failed calls.
    const temps = [68, 64, 60, 56, 52, 49];
    await insertReading(
      [
        ...temps.map((v, i) => ({ time: ago(180 - i * 36), person_id: 40, h3_cell: cell, kind: 'home_temp_f', value: v })),
        { time: ago(5), person_id: 40, h3_cell: cell, kind: 'power_out', value: 1 },
        { time: ago(1), person_id: 40, h3_cell: cell, kind: 'phone_offline_min', value: 90 },
        // Person 41: fine and recently reached.
        { time: ago(10), person_id: 41, h3_cell: otherCell, kind: 'home_temp_f', value: 71 },
        { time: ago(10), person_id: 41, h3_cell: otherCell, kind: 'power_out', value: 0 },
      ],
      pool,
    );
    await insertContactEvent(
      [
        { time: ago(400), person_id: 40, h3_cell: cell, channel: 'app', result: 'safe' },
        { time: ago(60), person_id: 40, h3_cell: cell, channel: 'voice', result: 'no_answer' },
        { time: ago(20), person_id: 40, h3_cell: cell, channel: 'sms', result: 'no_answer' },
        { time: ago(5), person_id: 41, h3_cell: otherCell, channel: 'app', result: 'safe' },
      ],
      pool,
    );
    const alert = {
      time: ago(30), source: 'nws_alerts', kind: 'winter_storm_warning', h3_cells: [cell],
      payload: { event: 'Winter Storm Warning', headline: 'Winter Storm Warning until 6 PM', expires: new Date(Date.now() + 6 * 3600_000).toISOString() },
    };
    expect(await insertFeedEvent(alert, pool)).toBe(1);
    expect(await insertFeedEvent(alert, pool)).toBe(0); // dedupe on re-poll
    // Two different items in the same cell at the same time both land.
    const h = (id: string) => ({ time: ago(1440), source: 'osm_facilities', kind: 'hospital', h3_cells: [otherCell], payload: { id } });
    expect(await insertFeedEvent([h('way/1'), h('way/2'), h('way/1')], pool)).toBe(2);
    // The 1-minute policy may have materialized before our inserts; refresh so the aggregates see them.
    await pool.query(
      `SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'`,
    );
    for (const view of ['cell_5m', 'person_last_contact']) {
      for (let attempt = 0; ; attempt++) {
        try {
          await pool.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
          break;
        } catch (e) {
          if (attempt > 20 || !/concurrent refresh/.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('creates hypertables and continuous aggregates', async () => {
    const { rows } = await pool.query(`SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`);
    expect(rows.map((r) => r.hypertable_name)).toEqual(expect.arrayContaining(['contact_events', 'feed_events', 'readings']));
    const caggs = await pool.query(`SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1`);
    expect(caggs.rows.map((r) => r.view_name)).toEqual(['cell_5m', 'person_last_contact']);
    const ext = await pool.query(`SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'timescaledb') ORDER BY 1`);
    expect(ext.rows.map((r) => r.extname)).toEqual(['postgis', 'timescaledb']);
  });

  it('at_risk_now ranks the cold, unreachable person first with a readable summary', async () => {
    const r = await atRiskNow.run({ limit: 5 }, pool);
    expect(r.people.map((p) => p.person_id)).toEqual([40, 41]);
    const top = r.people[0];
    expect(top.temp_now_f).toBe(49);
    expect(top.temp_3h_ago_f).toBe(68);
    expect(top.power_out).toBe(true);
    expect(top.failed_attempts_24h).toBe(2);
    expect(top.alert_in_cell).toBe('Winter Storm Warning');
    expect(top.minutes_since_contact).toBeGreaterThanOrEqual(399);
    expect(top.summary).toMatch(/^person 40: 68°F to 49°F in 3 h, power out, phone offline 90 min, no contact 7 h$/);
    expect(r.summary).toMatch(/^2 at risk; top: person 40/);
  });

  it('cell_trend returns 5-minute buckets and feed events', async () => {
    const r = await cellTrend.run({ h3_cell: cell, hours: 4 }, pool);
    expect(r.buckets.length).toBeGreaterThanOrEqual(6);
    expect(r.buckets[0].avg_home_temp_f).toBe(68);
    expect(r.feed_events[0].headline).toBe('Winter Storm Warning until 6 PM');
    expect(r.summary).toMatch(/avg home 68°F to 49°F in 4 h, 100% power out, Winter Storm Warning until 6 PM/);
  });

  it('person_timeline merges readings, contacts and alerts newest first', async () => {
    const r = await personTimeline.run({ person_id: 40 }, pool);
    expect(r.h3_cell).toBe(cell);
    expect(r.entries.length).toBe(6 + 2 + 3 + 1);
    expect(r.entries.map((e) => e.time)).toEqual([...r.entries.map((e) => e.time)].sort().reverse());
    expect(r.summary).toBe(
      `person 40: 68°F to 49°F in 3 h, power out, phone offline 90 min, last reached 7 h ago (safe via app), Winter Storm Warning until 6 PM`,
    );
  });
});
