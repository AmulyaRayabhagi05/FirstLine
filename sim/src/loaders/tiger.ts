// Writes storm history into Tiger Data (TimescaleDB) hypertables `readings` and
// `contact_events` (schema: db/tiger/schema.sql on feat/feeds-tiger). Skips when
// TIGER_DATABASE_URL is unset. Kinds match that schema: home_temp_f, power_out (1/0),
// phone_offline_min.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eventTime, type Storm } from "../storm.js";
import type { World } from "../types.js";

// Same TLS policy as agents/src/tiger/client.ts: Tiger Cloud is verified against its own CA
// (bundled), other remote hosts against the system CAs, plaintext only for localhost or an
// explicit sslmode=disable. Certificate checks were off before (MITM could read the history).
const TIMESCALE_CA_PATH = fileURLToPath(new URL("../../../db/tiger/timescale-ca.pem", import.meta.url));
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function pgSslFor(url: string): false | { ca?: string; rejectUnauthorized: true } {
  if (/sslmode=disable/.test(url)) return false;
  if (/\.tsdb\.cloud\.timescale\.com/.test(url)) {
    return { ca: readFileSync(process.env.TIGER_CA_CERT || TIMESCALE_CA_PATH, "utf8"), rejectUnauthorized: true };
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // not a URL
  }
  const wantsSsl = /sslmode=(require|verify-ca|verify-full)/.test(url);
  return wantsSsl || (host !== "" && !LOCAL_HOSTS.has(host)) ? { rejectUnauthorized: true } : false;
}

export interface ReadingRow {
  time: string;
  person_id: number;
  h3_cell: string;
  kind: string;
  value: number;
}
export interface ContactRow {
  time: string;
  person_id: number;
  h3_cell: string;
  channel: string;
  result: string;
}

/** Builds the rows without touching a database (also used by tests and the dry run). */
export function tigerRows(world: World, storm: Storm, start = storm.start): { readings: ReadingRow[]; contacts: ContactRow[] } {
  const readings: ReadingRow[] = [];
  const contacts: ContactRow[] = [];
  const cellOf = (id: number) => world.people[id - 1]?.h3Cell ?? "";
  for (const e of storm.events) {
    const time = eventTime(storm, e.t, start);
    if (e.kind === "reading") readings.push({ time, person_id: e.personId, h3_cell: e.h3Cell, kind: e.reading, value: e.value });
    else if (e.kind === "check_in") contacts.push({ time, person_id: e.personId, h3_cell: cellOf(e.personId), channel: e.checkKind, result: e.result });
    else if (e.kind === "sos") contacts.push({ time, person_id: e.personId, h3_cell: e.h3Cell, channel: e.channel, result: "needs_help" });
  }
  // Hourly power and phone state per person (what the utility outage feed and app heartbeat show).
  const outAt = storm.truth.householdOutageAt;
  const phoneOff = storm.truth.phoneOfflineAt;
  for (let t = 0; t <= storm.minutes; t += 60) {
    const time = eventTime(storm, t, start);
    for (const p of world.people) {
      const o = outAt[p.householdId];
      readings.push({ time, person_id: p.id, h3_cell: p.h3Cell, kind: "power_out", value: o !== undefined && t >= o ? 1 : 0 });
      if (p.hasSmartphone) {
        const off = phoneOff[p.id];
        readings.push({ time, person_id: p.id, h3_cell: p.h3Cell, kind: "phone_offline_min", value: off !== undefined && t >= off ? t - off : 0 });
      }
    }
  }
  return { readings, contacts };
}

/** Minimal pg client surface so tests can pass a fake. */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end?(): Promise<void>;
}

async function insertBatches(client: PgLike, table: string, cols: string[], rows: Record<string, unknown>[], batch = 1000): Promise<void> {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values: unknown[] = [];
    const tuples = chunk.map((r, k) => {
      cols.forEach((c) => values.push(r[c]));
      return `(${cols.map((_, j) => `$${k * cols.length + j + 1}`).join(",")})`;
    });
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`, values);
  }
}

export interface TigerLoadResult {
  skipped: boolean;
  readings: number;
  contacts: number;
}

/**
 * Loads storm history. `start` shifts timestamps (e.g. so the night ends "now" for the demo).
 * Pass `client` to reuse a connection; otherwise connects to TIGER_DATABASE_URL.
 */
export async function loadTiger(world: World, storm: Storm, opts: { start?: string; client?: PgLike; clear?: boolean; log?: (s: string) => void } = {}): Promise<TigerLoadResult> {
  const { readings, contacts } = tigerRows(world, storm, opts.start);
  let client = opts.client;
  let own = false;
  if (!client) {
    const url = process.env.TIGER_DATABASE_URL;
    if (!url) {
      opts.log?.("TIGER_DATABASE_URL not set: skipping Tiger load");
      return { skipped: true, readings: readings.length, contacts: contacts.length };
    }
    const pg = await import("pg");
    // pg lets `sslmode` in the URL override `ssl`, so drop it and pass TLS settings explicitly.
    const bare = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
    const c = new pg.default.Client({ connectionString: bare, ssl: pgSslFor(url) });
    await c.connect();
    client = c;
    own = true;
  }
  try {
    if (opts.clear) {
      // Only remove rows for sim person ids in the storm window.
      const from = eventTime(storm, 0, opts.start);
      const to = eventTime(storm, storm.minutes + 1, opts.start);
      const maxId = world.people.length;
      await client.query("DELETE FROM readings WHERE time >= $1 AND time < $2 AND person_id <= $3", [from, to, maxId]);
      await client.query("DELETE FROM contact_events WHERE time >= $1 AND time < $2 AND person_id <= $3", [from, to, maxId]);
    }
    await insertBatches(client, "readings", ["time", "person_id", "h3_cell", "kind", "value"], readings as unknown as Record<string, unknown>[]);
    opts.log?.(`readings: ${readings.length} rows`);
    await insertBatches(client, "contact_events", ["time", "person_id", "h3_cell", "channel", "result"], contacts as unknown as Record<string, unknown>[]);
    opts.log?.(`contact_events: ${contacts.length} rows`);
  } finally {
    if (own) await client.end?.();
  }
  return { skipped: false, readings: readings.length, contacts: contacts.length };
}
