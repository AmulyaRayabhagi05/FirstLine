// Seed the synthetic Dallas world into a running SpacetimeDB database through the module's
// reducers, then optionally play the storm night into it. No hand-written demo rows: everything
// comes from the seeded generator, so the same --seed gives the same people and the same night.
//
//   npm run load-live -- --whoami                 print this loader's identity and exit
//   npm run load-live -- --n 1000                 register 1000 residents and their safety nets
//   npm run load-live -- --n 1000 --storm --speed 600 --to 240
//                                                 ...then play storm minutes [0, 240) at 600x
//   npm run load-live -- --n 1000 --storm-only --speed 240
//                                                 play the night into an already-seeded database
//
// Target: SPACETIME_HOST (default http://127.0.0.1:3000) and SPACETIME_DB_NAME (default firstline).
// The loader keeps its own identity token in sim/.spacetime-token-loader (git-ignored). It reads
// people back through the ops_* views, so the module owner must grant it staff once:
//   spacetime call --server local firstline add_staff '"<identity from --whoami>"'
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_N, DEFAULT_SEED, generateWorld, summarize } from "../generate.js";
import { parseArgs } from "../io.js";
import { loadWorld, playIntoStore, type IdMap } from "../loaders/spacetime.js";
import type { SimStore } from "../loaders/types.js";
import { generateStorm } from "../storm.js";
import { SpacetimeStore, spacetimeConfigFromEnv } from "../../../agents/src/store/spacetime.js";

const args = parseArgs();
const n = Number(args.n ?? DEFAULT_N);
const seed = Number(args.seed ?? DEFAULT_SEED);

const TOKEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spacetime-token-loader");
const cfg = {
  ...spacetimeConfigFromEnv(),
  host: process.env.SPACETIME_HOST || "http://127.0.0.1:3000",
  dbName: process.env.SPACETIME_DB_NAME || "firstline",
  token: undefined,
  tokenPath: process.env.SPACETIME_TOKEN_PATH || TOKEN_PATH,
};

const store = await SpacetimeStore.connect(cfg);
console.log(`identity ${store.identityHex} on ${cfg.host} / ${cfg.dbName}`);
if (args.whoami) process.exit(0);

const world = generateWorld({ n, seed });
console.log(summarize(world));

let ids: IdMap;
if (args["storm-only"]) {
  // The world is already in the database: match each sim person to their row by name and phone.
  const byKey = new Map((await store.listPeople()).map((p) => [`${p.name}|${p.phone}`, p.id]));
  ids = { toStore: new Map(), fromStore: new Map() };
  for (const p of world.people) {
    const id = byKey.get(`${p.name}|${p.phone}`);
    if (id === undefined) continue;
    ids.toStore.set(p.id, id);
    ids.fromStore.set(id, p.id);
  }
  console.log(`matched ${ids.toStore.size}/${world.people.length} people already in the database`);
  if (ids.toStore.size < world.people.length) {
    console.error("some people are missing: seed first with the same --n and --seed");
    process.exit(1);
  }
} else {
  const t0 = Date.now();
  ids = await loadWorld(store as unknown as SimStore, world, {
    concurrency: 16,
    onProgress: (done, total) => {
      if (done % 100 === 0 || done === total) console.log(`registered ${done}/${total}`);
    },
  });
  console.log(`loaded ${world.people.length} people in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (args.storm || args["storm-only"]) {
  const storm = generateStorm(world);
  const speed = args.speed ? Number(args.speed) : Infinity;
  const from = args.from ? Number(args.from) : undefined;
  const to = args.to ? Number(args.to) : undefined;
  console.log(`playing storm at ${speed === Infinity ? "full speed" : `${speed}x`}${from ? ` from minute ${from}` : ""}${to ? ` until minute ${to}` : ""}`);
  const played = await playIntoStore(store as unknown as SimStore, ids, storm, { speed, from, to });
  console.log(`played ${played} storm events`);
}
process.exit(0);
