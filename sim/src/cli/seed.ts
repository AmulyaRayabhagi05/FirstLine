// npm run seed [-- --n 5000 --seed 20210214]
// Writes out/people.json, households.json, safety_nets.json, world.json, storm.json.
import { DEFAULT_N, DEFAULT_SEED, generateWorld, summarize } from "../generate.js";
import { parseArgs, writeOut } from "../io.js";
import { generateStorm } from "../storm.js";

const args = parseArgs();
const n = Number(args.n ?? DEFAULT_N);
const seed = Number(args.seed ?? DEFAULT_SEED);

const world = generateWorld({ n, seed });
const storm = generateStorm(world);
writeOut("people.json", world.people);
writeOut("households.json", world.households);
writeOut("safety_nets.json", world.nets);
writeOut("world.json", world);
const path = writeOut("storm.json", storm);

console.log(`seed ${seed}: generated world`);
console.log(summarize(world));
const demo = world.people.filter((p) => p.demoRole).map((p) => `${p.id} ${p.name} (${p.demoRole}, ${p.age}, ${p.language})`);
console.log("demo characters:", demo);
const kinds: Record<string, number> = {};
for (const e of storm.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`storm: ${storm.events.length} events`, kinds, `critical cases: ${storm.truth.critical.length}`);
console.log(`wrote ${path.replace(/storm\.json$/, "")}`);
