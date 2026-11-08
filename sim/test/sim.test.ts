import { describe, expect, it } from "vitest";
import { DEMO, generateWorld } from "../src/generate.js";
import { DryRunStore } from "../src/loaders/dryrun.js";
import { applyEvent, loadWorld } from "../src/loaders/spacetime.js";
import { loadTiger, tigerRows, type PgLike } from "../src/loaders/tiger.js";
import { compare, runFirstLine } from "../src/measure.js";
import { NEIGHBORHOODS } from "../src/data.js";
import { generateStorm, helperDecision, playStorm } from "../src/storm.js";

const N = 1500;
const world = generateWorld({ n: N, seed: 7 });
const storm = generateStorm(world);

describe("determinism", () => {
  it("same seed gives identical world and storm", () => {
    const w2 = generateWorld({ n: N, seed: 7 });
    expect(JSON.stringify(w2)).toEqual(JSON.stringify(world));
    expect(JSON.stringify(generateStorm(w2))).toEqual(JSON.stringify(storm));
  });

  it("different seed gives a different world", () => {
    const w3 = generateWorld({ n: N, seed: 8 });
    expect(w3.people.slice(10, 20).map((p) => p.name)).not.toEqual(world.people.slice(10, 20).map((p) => p.name));
  });

  it("measurement is reproducible", () => {
    const a = compare(world, storm);
    const b = compare(world, storm);
    expect(a.firstline.stats).toEqual(b.firstline.stats);
    expect(a.baseline.stats).toEqual(b.baseline.stats);
  });
});

describe("world", () => {
  it("has the requested size, valid fields and plausible locations", () => {
    expect(world.people).toHaveLength(N);
    const ids = new Set(world.people.map((p) => p.id));
    expect(ids.size).toBe(N);
    expect(new Set(world.people.map((p) => p.phone)).size).toBe(N);
    for (const p of world.people) {
      expect(p.h3Cell).toMatch(/^89[0-9a-f]{13}$/);
      expect(["en", "es", "vi"]).toContain(p.language);
      expect(p.phone).toMatch(/^\+1\d{3}55501\d\d/);
      expect(p.lat).toBeGreaterThan(32.68);
      expect(p.lat).toBeLessThan(32.89);
      expect(p.lng).toBeGreaterThan(-96.9);
      expect(p.lng).toBeLessThan(-96.66);
    }
    expect(NEIGHBORHOODS.length).toBeGreaterThanOrEqual(3);
  });

  it("ring 1 nets have 2-4 members, never the owner or their household", () => {
    const hh = new Map(world.people.map((p) => [p.id, p.householdId]));
    const ring1 = new Map<number, number>();
    for (const m of world.nets) {
      expect(m.memberId).not.toBe(m.ownerId);
      if (m.ownerId > 5) expect(hh.get(m.memberId)).not.toBe(hh.get(m.ownerId));
      if (m.ring === 1) ring1.set(m.ownerId, (ring1.get(m.ownerId) ?? 0) + 1);
    }
    for (const [owner, k] of ring1) if (owner > 5) expect(k === 0 || (k >= 2 && k <= 4)).toBe(true);
  });

  it("some cells skew much older than the city (default 5,000 world)", () => {
    const big = generateWorld();
    const byCell = new Map<string, number[]>();
    for (const p of big.people) byCell.set(p.h3Cell, [...(byCell.get(p.h3Cell) ?? []), p.age]);
    const shares = [...byCell.values()].filter((a) => a.length >= 15).map((a) => a.filter((x) => x >= 65).length / a.length);
    expect(Math.max(...shares)).toBeGreaterThan(0.35);
  });
});

describe("demo characters", () => {
  const p = (id: number) => world.people[id - 1];

  it("Rosa and her mother share a household; mother cannot walk; both Spanish", () => {
    expect(p(DEMO.rosa).name).toBe("Rosa Martinez");
    expect(p(DEMO.rosaMother).mobility).toBe("cannot_walk");
    expect(p(DEMO.rosaMother).householdId).toBe(p(DEMO.rosa).householdId);
    expect(p(DEMO.rosa).language).toBe("es");
    expect(p(DEMO.rosaMother).language).toBe("es");
  });

  it("Marcus is first in Rosa's ring 1, has a truck and never answers; Linh accepts", () => {
    const net = world.nets.filter((m) => m.ownerId === DEMO.rosa);
    expect(net[0]).toMatchObject({ memberId: DEMO.marcus, ring: 1 });
    expect(net[0].skills).toContain("truck");
    expect(helperDecision(storm, p(DEMO.marcus), "sos:1", 150).action).toBe("no_answer");
    expect(helperDecision(storm, p(DEMO.linh), "sos:1", 150).action).toBe("accept");
  });

  it("Mr. Lee is 84, alone, on oxygen, and never sends an SOS", () => {
    const lee = p(DEMO.mrLee);
    expect(lee).toMatchObject({ age: 84, livesAlone: true, hasSmartphone: false });
    expect(lee.medicalNeeds).toContain("oxygen");
    const sos = storm.events.filter((e) => e.kind === "sos" && (e.personId === lee.id || e.aboutPersonId === lee.id));
    expect(sos).toHaveLength(0);
    expect(storm.truth.critical.find((c) => c.personId === lee.id)).toBeDefined();
  });

  it("Rosa sends the Spanish SOS for her mother at 10:30 pm", () => {
    const sos = storm.events.find((e) => e.kind === "sos" && e.personId === DEMO.rosa);
    expect(sos).toMatchObject({ t: 150, aboutPersonId: DEMO.rosaMother, channel: "app" });
    if (sos?.kind === "sos") expect(sos.message).toMatch(/Mi mamá no puede caminar/);
  });

  it("demo characters are the same in a 5,000-person world", () => {
    const big = generateWorld();
    expect(big.people.slice(0, 5).map((x) => x.name)).toEqual(world.people.slice(0, 5).map((x) => x.name));
  });

  it("FirstLine reaches Rosa's mother via Linh and finds Mr. Lee", () => {
    const r = runFirstLine(world, storm);
    const mother = r.cases.find((c) => c.personId === DEMO.rosaMother)!;
    const lee = r.cases.find((c) => c.personId === DEMO.mrLee)!;
    expect(mother.reachedAt).toBeDefined();
    expect(mother.reachedAt! - 150).toBeLessThan(60);
    expect(lee.silent).toBe(true);
    expect(lee.reachedAt).toBeDefined();
  });
});

describe("storm", () => {
  it("events are time-ordered, inside the night, and SOS mixes English and Spanish", () => {
    for (let i = 1; i < storm.events.length; i++) expect(storm.events[i].t).toBeGreaterThanOrEqual(storm.events[i - 1].t);
    expect(storm.events.every((e) => e.t >= 0 && e.t <= storm.minutes)).toBe(true);
    const sos = storm.events.filter((e) => e.kind === "sos");
    expect(sos.length).toBeGreaterThan(10);
    expect(new Set(sos.map((e) => (e.kind === "sos" ? world.people[e.personId - 1].language : "")))).toContain("en");
    expect(new Set(sos.map((e) => (e.kind === "sos" ? world.people[e.personId - 1].language : "")))).toContain("es");
    expect(new Set(sos.map((e) => (e.kind === "sos" ? e.clientId : ""))).size).toBe(sos.length);
  });

  it("playback honors from/to and speed", async () => {
    const seen: number[] = [];
    const n = await playStorm(storm, (e) => void seen.push(e.t), { from: 100, to: 200 });
    expect(n).toBe(seen.length);
    expect(seen.every((t) => t >= 100 && t < 200)).toBe(true);
    const t0 = Date.now();
    await playStorm(storm, () => {}, { from: 0, to: 1, speed: 6000 }); // 1 storm minute = 10 ms
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("loaders", () => {
  it("dry run registers everyone, sets nets and replays every non-reading event", async () => {
    const store = new DryRunStore();
    const ids = await loadWorld(store, world);
    expect(store.counts.registerPerson).toBe(N);
    expect(store.counts.netMembers).toBe(world.nets.length);
    for (const e of storm.events) await applyEvent(store, ids, e);
    expect(store.counts.pressSos).toBe(storm.events.filter((e) => e.kind === "sos").length);
  });

  it("tiger rows use the feeds schema kinds and batch inserts through pg", async () => {
    const rows = tigerRows(world, storm);
    expect(new Set(rows.readings.map((r) => r.kind))).toEqual(new Set(["home_temp_f", "power_out", "phone_offline_min"]));
    const queries: string[] = [];
    const fake: PgLike = { query: async (q: string) => void queries.push(q) };
    const r = await loadTiger(world, storm, { client: fake });
    expect(r.skipped).toBe(false);
    expect(queries.some((q) => q.startsWith("INSERT INTO readings"))).toBe(true);
    expect(queries.some((q) => q.startsWith("INSERT INTO contact_events"))).toBe(true);
  });

  it("tiger load skips without TIGER_DATABASE_URL", async () => {
    const old = process.env.TIGER_DATABASE_URL;
    delete process.env.TIGER_DATABASE_URL;
    const r = await loadTiger(world, storm);
    expect(r.skipped).toBe(true);
    if (old) process.env.TIGER_DATABASE_URL = old;
  });
});

describe("measure", () => {
  it("FirstLine reaches more critical cases within 60 minutes than calls-only", () => {
    const c = compare(world, storm);
    expect(c.firstline.stats.critical).toBe(c.baseline.stats.critical);
    expect(c.firstline.stats.within60).toBeGreaterThan(c.baseline.stats.within60);
  });

  it("every sensitivity knob reaches the model", () => {
    const base = compare(world, storm);
    const key = (r: ReturnType<typeof compare>, s: "baseline" | "firstline") => JSON.stringify(r[s].cases.map((c) => c.reachedAt));
    // EMS capacity and third-party calls change who EMS reaches (visible in the baseline).
    expect(key(compare(world, storm, { proUnits: 0 }), "baseline")).not.toEqual(key(base, "baseline"));
    expect(key(compare(world, storm, { thirdPartyCallP: 0 }), "baseline")).not.toEqual(key(base, "baseline"));
    // Triage misses change FirstLine outcomes once non-urgent requests are not dispatched at once.
    const slowP3 = compare(world, storm, { p3DelayMin: 60, triageMissP: 0 });
    const slowP3Miss = compare(world, storm, { p3DelayMin: 60, triageMissP: 1 });
    expect(slowP3Miss.firstline.stats.within60).toBeLessThan(slowP3.firstline.stats.within60);
    expect(key(compare(world, storm, { acceptScale: 0.5 }), "firstline")).not.toEqual(key(base, "firstline"));
  });
});
