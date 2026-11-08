// npm run measure [-- --seeds 5 --seed 20210214 --n 5000]
// Runs calls-only vs Porchlight over the same storms and prints the numbers for the writeup.
import { DEFAULT_N, DEFAULT_SEED, generateWorld } from "../generate.js";
import { parseArgs, writeOut } from "../io.js";
import { compare, DEFAULT_PARAMS, type Comparison, type MeasureParams } from "../measure.js";
import { generateStorm } from "../storm.js";

const args = parseArgs();
const seeds = Number(args.seeds ?? 5);
const seed0 = Number(args.seed ?? DEFAULT_SEED);
const n = Number(args.n ?? DEFAULT_N);

const worlds = Array.from({ length: seeds }, (_, i) => {
  const world = generateWorld({ n, seed: seed0 + i });
  return { world, storm: generateStorm(world) };
});

function run(params: Partial<MeasureParams>): Comparison[] {
  return worlds.map(({ world, storm }) => compare(world, storm, params));
}

const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
const fmt = (xs: number[]) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.length > 1 ? `${m.toFixed(0)}% (${lo.toFixed(0)}-${hi.toFixed(0)})` : `${m.toFixed(0)}%`;
};
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function table(rs: Comparison[]) {
  const rows: [string, (c: Comparison, s: "baseline" | "porchlight") => number][] = [
    ["critical reached within 30 min", (c, s) => pct(c[s].stats.within30, c[s].stats.critical)],
    ["critical reached within 60 min", (c, s) => pct(c[s].stats.within60, c[s].stats.critical)],
    ["critical reached within 120 min", (c, s) => pct(c[s].stats.within120, c[s].stats.critical)],
    ["critical reached by morning (+3h)", (c, s) => pct(c[s].stats.reachedByEnd, c[s].stats.critical)],
    ["silent critical reached within 120 min", (c, s) => pct(c[s].stats.silentWithin120, c[s].stats.silent)],
    ["silent critical reached by morning", (c, s) => pct(c[s].stats.silentReachedByEnd, c[s].stats.silent)],
  ];
  const out: Record<string, { callsOnly: string; porchlight: string }> = {};
  for (const [label, f] of rows) out[label] = { callsOnly: fmt(rs.map((c) => f(c, "baseline"))), porchlight: fmt(rs.map((c) => f(c, "porchlight"))) };
  return out;
}

const main = run({});
const s0 = main.map((c) => c.porchlight.stats);
const b0 = main.map((c) => c.baseline.stats);
console.log(`\nPorchlight vs calls-only, ${seeds} storm(s) x ${n} residents (mean, min-max across seeds)\n`);
console.log(`critical cases per storm: ${mean(s0.map((s) => s.critical)).toFixed(0)}  (silent, never asked for help: ${mean(s0.map((s) => s.silent)).toFixed(0)})`);
console.table(table(main));
console.log(
  `median minutes onset -> someone at the door: calls-only ${mean(b0.map((s) => s.medianMin)).toFixed(0)}, porchlight ${mean(s0.map((s) => s.medianMin)).toFixed(0)}`,
);
const ps = (k: string) => mean(s0.map((s) => s[k] ?? 0)).toFixed(0);
console.log(
  `porchlight work per storm: ${ps("sosRequests")} SOS, ${ps("autoCalls")} automated check-in calls (${ps("autoCallsAnswered")} answered), ` +
    `${ps("neighborChecks")} neighbor checks (${ps("checksFoundCritical")} found a critical case), ${ps("offers")} helper offers ` +
    `(${ps("accepts")} accepted, ${ps("declines")} declined, ${ps("timeouts")} timed out), ${ps("escalations")} escalated to EMS`,
);

console.log("\nSensitivity (calls-only -> porchlight; same storms, one change per row):");
const sens: [string, Partial<MeasureParams>][] = [
  ["defaults", {}],
  ["neighbors accept half as often", { acceptScale: 0.5 }],
  ["2 EMS units instead of 3", { proUnits: 2 }],
  ["6 EMS units instead of 3", { proUnits: 6 }],
  ["no third-party 911 calls", { thirdPartyCallP: 0 }],
  ["triage misses 40% of emergencies", { triageMissP: 0.4 }],
  ["non-urgent (P3) requests wait 60 min", { p3DelayMin: 60 }],
  ["P3 waits 60 min + triage misses 40%", { p3DelayMin: 60, triageMissP: 0.4 }],
];
const sensOut: Record<string, { within60: string; byMorning: string }> = {};
for (const [label, params] of sens) {
  const rs = label === "defaults" ? main : run(params);
  const cell = (k: "within60" | "reachedByEnd") =>
    `${fmt(rs.map((c) => pct(c.baseline.stats[k], c.baseline.stats.critical)))} -> ${fmt(rs.map((c) => pct(c.porchlight.stats[k], c.porchlight.stats.critical)))}`;
  sensOut[label] = { within60: cell("within60"), byMorning: cell("reachedByEnd") };
}
console.table(sensOut);

const path = writeOut("measure.json", {
  seeds: worlds.map((w) => w.world.seed),
  n,
  params: DEFAULT_PARAMS,
  table: table(main),
  sensitivity: sensOut,
  perSeed: main.map((c) => ({ seed: c.seed, callsOnly: c.baseline.stats, porchlight: c.porchlight.stats })),
});
console.log(`\nwrote ${path}`);
