import { getPool, type Queryable } from './client.js';

export interface Reading {
  time?: Date | string;
  person_id: number | bigint | string;
  h3_cell: string;
  /** home_temp_f, power_out, phone_offline_min, no_motion_min, ... */
  kind: string;
  value: number;
}

export interface FeedEventRow {
  time?: Date | string;
  source: string;
  h3_cell: string;
  kind: string;
  payload?: unknown;
}

/** Normalized feed item (what feed modules produce): one item, many cells. */
export interface FeedEventInput {
  time?: Date | string;
  source: string;
  kind: string;
  h3_cells: string[];
  payload?: unknown;
}

export interface ContactEvent {
  time?: Date | string;
  person_id: number | bigint | string;
  h3_cell: string;
  /** app / voice / sms / neighbor_visit / mesh */
  channel: string;
  /** safe / needs_help / no_answer / sent / failed */
  result: string;
}

const CHUNK = 2000;

function iso(t: Date | string | undefined): string {
  if (t === undefined) return new Date().toISOString();
  return typeof t === 'string' ? new Date(t).toISOString() : t.toISOString();
}

function asArray<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

async function chunked<T>(rows: T[], fn: (chunk: T[]) => Promise<number>): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) n += await fn(rows.slice(i, i + CHUNK));
  return n;
}

/** Insert one or many readings. Returns rows inserted. */
export async function insertReading(r: Reading | Reading[], db: Queryable = getPool()): Promise<number> {
  const rows = asArray(r);
  return chunked(rows, async (c) => {
    const res = await db.query(
      `INSERT INTO readings (time, person_id, h3_cell, kind, value)
       SELECT * FROM unnest($1::timestamptz[], $2::bigint[], $3::text[], $4::text[], $5::float8[])`,
      [c.map((x) => iso(x.time)), c.map((x) => String(x.person_id)), c.map((x) => x.h3_cell), c.map((x) => x.kind), c.map((x) => x.value)],
    );
    return res.rowCount ?? 0;
  });
}

/**
 * Insert feed events. Accepts flat rows ({h3_cell}) or normalized items ({h3_cells[]}),
 * which are expanded to one row per cell. Duplicates (same time/source/kind/cell) are skipped.
 */
export async function insertFeedEvent(
  e: FeedEventRow | FeedEventInput | Array<FeedEventRow | FeedEventInput>,
  db: Queryable = getPool(),
): Promise<number> {
  const rows: Array<{ time: string; source: string; h3_cell: string; kind: string; payload: string }> = [];
  for (const x of asArray(e)) {
    const time = iso(x.time);
    const payload = JSON.stringify(x.payload ?? {});
    const cells = 'h3_cells' in x ? x.h3_cells : [x.h3_cell];
    for (const cell of new Set(cells)) rows.push({ time, source: x.source, h3_cell: cell, kind: x.kind, payload });
  }
  return chunked(rows, async (c) => {
    const res = await db.query(
      `INSERT INTO feed_events (time, source, h3_cell, kind, payload)
       SELECT t, s, h, k, p::jsonb FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[]) AS u(t, s, h, k, p)
       ON CONFLICT DO NOTHING`,
      [c.map((x) => x.time), c.map((x) => x.source), c.map((x) => x.h3_cell), c.map((x) => x.kind), c.map((x) => x.payload)],
    );
    return res.rowCount ?? 0;
  });
}

/** Insert one or many contact attempts. Returns rows inserted. */
export async function insertContactEvent(e: ContactEvent | ContactEvent[], db: Queryable = getPool()): Promise<number> {
  const rows = asArray(e);
  return chunked(rows, async (c) => {
    const res = await db.query(
      `INSERT INTO contact_events (time, person_id, h3_cell, channel, result)
       SELECT * FROM unnest($1::timestamptz[], $2::bigint[], $3::text[], $4::text[], $5::text[])`,
      [c.map((x) => iso(x.time)), c.map((x) => String(x.person_id)), c.map((x) => x.h3_cell), c.map((x) => x.channel), c.map((x) => x.result)],
    );
    return res.rowCount ?? 0;
  });
}
