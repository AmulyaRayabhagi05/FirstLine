/**
 * Runs each feed on its interval, writes normalized events to Tiger (feed_events) and
 * optionally hands each new event to `onFeedEvent` (e.g. so the worker can call set_cell_alert).
 *
 * CLI: npx tsx src/feeds/poller.ts [--once] [--dry] [feed names...]
 *   --once  run every selected feed one time and exit
 *   --dry   do not write to Tiger, just print counts
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Feed, FeedEvent } from './types.js';
import { allFeeds } from './index.js';

export interface PollerOptions {
  feeds?: Feed[];
  /** Persist events; defaults to Tiger insertFeedEvent. Return value is rows written. */
  write?: (events: FeedEvent[]) => Promise<number>;
  /** Called once per new event (deduped in memory across polls). Errors are logged, not thrown. */
  onFeedEvent?: (event: FeedEvent) => void | Promise<void>;
  log?: (msg: string) => void;
  /** Run every feed immediately on start (default true). */
  runImmediately?: boolean;
}

export interface FeedRunResult {
  feed: string;
  events: number;
  rows: number;
  newEvents: number;
  error?: string;
  ms: number;
}

const eventKey = (e: FeedEvent) =>
  `${e.source}|${e.kind}|${e.time}|${(e.payload.id ?? e.payload.incident_number ?? e.payload.shelter_id ?? e.payload.osm_id ?? e.payload.geoid ?? e.payload.zip ?? '') as string}|${e.h3_cells[0] ?? ''}`;

async function defaultWrite(events: FeedEvent[]): Promise<number> {
  const { insertFeedEvent } = await import('../tiger/insert.js');
  return insertFeedEvent(events);
}

export function createPoller(opts: PollerOptions = {}) {
  const feeds = opts.feeds ?? allFeeds;
  const write = opts.write ?? defaultWrite;
  const log = opts.log ?? ((m: string) => console.log(`[feeds] ${m}`));
  const seen = new Set<string>();
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  async function runFeed(feed: Feed): Promise<FeedRunResult> {
    const t0 = Date.now();
    if (running.has(feed.name)) return { feed: feed.name, events: 0, rows: 0, newEvents: 0, error: 'still running', ms: 0 };
    running.add(feed.name);
    try {
      const events = await feed.fetch();
      const rows = events.length ? await write(events) : 0;
      let newEvents = 0;
      for (const e of events) {
        const k = eventKey(e);
        if (seen.has(k)) continue;
        seen.add(k);
        newEvents++;
        if (opts.onFeedEvent) {
          try {
            await opts.onFeedEvent(e);
          } catch (err) {
            log(`${feed.name}: onFeedEvent failed: ${(err as Error).message}`);
          }
        }
      }
      if (seen.size > 50_000) seen.clear();
      const r = { feed: feed.name, events: events.length, rows, newEvents, ms: Date.now() - t0 };
      log(`${feed.name}: ${r.events} events (${r.newEvents} new), ${r.rows} rows written in ${r.ms} ms`);
      return r;
    } catch (err) {
      const r = { feed: feed.name, events: 0, rows: 0, newEvents: 0, error: (err as Error).message, ms: Date.now() - t0 };
      log(`${feed.name}: FAILED ${r.error}`);
      return r;
    } finally {
      running.delete(feed.name);
    }
  }

  return {
    runFeed,
    runAll: () => Promise.all(feeds.map(runFeed)),
    start() {
      for (const f of feeds) {
        if (opts.runImmediately !== false) void runFeed(f);
        timers.push(setInterval(() => void runFeed(f), f.intervalMs));
      }
      log(`polling ${feeds.map((f) => `${f.name}/${Math.round(f.intervalMs / 60000)}m`).join(', ')}`);
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}

/** Convenience: create and start. Returns the poller (call .stop()). */
export function startPoller(opts: PollerOptions = {}) {
  const p = createPoller(opts);
  p.start();
  return p;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dry = args.includes('--dry') || !process.env.TIGER_DATABASE_URL;
  const names = args.filter((a) => !a.startsWith('--'));
  const feeds = names.length ? allFeeds.filter((f) => names.includes(f.name)) : allFeeds;
  if (dry && !args.includes('--dry')) console.log('[feeds] TIGER_DATABASE_URL not set: dry run (no writes)');
  const poller = createPoller({ feeds, write: dry ? async () => 0 : undefined });
  if (once) {
    poller.runAll().then(async (rs) => {
      console.table(rs);
      if (!dry) (await import('../tiger/client.js')).closePool();
    });
  } else {
    poller.start();
  }
}
