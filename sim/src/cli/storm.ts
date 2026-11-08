// npm run storm [-- --target dry|spacetime|tiger|all] [--speed 60] [--from 0 --to 720]
//                  [--no-register] [--helpers] [--end-now] [--clear]
//
// dry       (default) count every reducer call and Tiger row, no network.
// spacetime register people + nets, then play events through a SimStore. The store comes from
//           SIM_STORE_MODULE: a module exporting `createStore(): Promise<SimStore>` (for example a
//           thin wrapper around the worker's SpacetimeDB FirstLineStore adapter).
// tiger     write readings / contact_events with pg from TIGER_DATABASE_URL (skips if unset).
//
// --speed 60 plays one storm hour per wall minute (1 = real time). Default: as fast as possible.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DEFAULT_SEED, generateWorld } from "../generate.js";
import { parseArgs, readOut } from "../io.js";
import { DryRunStore } from "../loaders/dryrun.js";
import { loadWorld, playIntoStore, startHelperBot } from "../loaders/spacetime.js";
import { loadTiger, tigerRows } from "../loaders/tiger.js";
import type { HelperBotStore, SimStore } from "../loaders/types.js";
import { generateStorm, type Storm } from "../storm.js";
import type { World } from "../types.js";

const args = parseArgs();
const target = args.target ?? "dry";
const speed = args.speed ? Number(args.speed) : Infinity;
const from = Number(args.from ?? 0);
const to = args.to ? Number(args.to) : undefined;

let world = readOut<World>("world.json");
let storm = readOut<Storm>("storm.json");
if (!world || !storm || (args.seed && Number(args.seed) !== world.seed)) {
  world = generateWorld({ seed: Number(args.seed ?? DEFAULT_SEED), n: args.n ? Number(args.n) : undefined });
  storm = generateStorm(world);
  console.log("(out/ missing or different seed: generated in memory; run `npm run seed` to save)");
}

async function getStore(): Promise<SimStore> {
  const mod = process.env.SIM_STORE_MODULE;
  if (!mod) throw new Error("--target spacetime needs SIM_STORE_MODULE=<path to module exporting createStore()>");
  const m = await import(pathToFileURL(resolve(mod)).href);
  return (await m.createStore()) as SimStore;
}

async function runStore(store: SimStore, label: string) {
  const t0 = Date.now();
  const ids = args["no-register"]
    ? { toStore: new Map(world!.people.map((p) => [p.id, p.id])), fromStore: new Map(world!.people.map((p) => [p.id, p.id])) }
    : await loadWorld(store, world!, { onProgress: (d, n) => d % 1000 === 0 && console.log(`  registered ${d}/${n}`) });
  console.log(`${label}: world loaded in ${Date.now() - t0} ms`);
  let stopBot: (() => void) | undefined;
  const wall0 = Date.now();
  if (args.helpers && "listAssignments" in store) {
    stopBot = startHelperBot(store as unknown as HelperBotStore, world!, storm!, ids, {
      speed: Number.isFinite(speed) ? speed : 600,
      stormMinuteNow: () => from + ((Date.now() - wall0) / 60_000) * (Number.isFinite(speed) ? speed : 600),
      log: (s) => console.log(`  [helpers] ${s}`),
    });
  }
  let last = -1;
  const n = await playIntoStore(store, ids, storm!, {
    speed,
    from,
    to,
    onEvent: (e) => {
      if (e.kind === "sos") console.log(`  t+${e.t}m SOS ${e.channel} from ${e.personId}: ${e.message.slice(0, 70)}`);
      const hour = Math.floor(e.t / 60);
      if (hour !== last && Number.isFinite(speed)) {
        last = hour;
        console.log(`-- storm hour ${hour} (${storm!.outdoorHourly[hour]} °F outside)`);
      }
    },
  });
  console.log(`${label}: played ${n} events in ${Date.now() - wall0} ms`);
  stopBot?.();
}

if (target === "dry" || target === "all") {
  const store = new DryRunStore();
  await runStore(store, "dry run");
  console.log("reducer calls:", store.counts);
  const rows = tigerRows(world, storm);
  console.log(`tiger rows: readings ${rows.readings.length}, contact_events ${rows.contacts.length}`);
}
if (target === "spacetime" || target === "all") await runStore(await getStore(), "spacetime");
if (target === "tiger" || target === "all") {
  // --end-now shifts the night so it ends at the current time (history graphs look live).
  const start = args["end-now"] ? new Date(Date.now() - storm.minutes * 60_000).toISOString() : undefined;
  const r = await loadTiger(world, storm, { start, clear: Boolean(args.clear), log: (s) => console.log(`tiger: ${s}`) });
  if (r.skipped) console.log(`tiger: skipped (would write ${r.readings} readings, ${r.contacts} contact_events)`);
}
