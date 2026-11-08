// One Uri-like night in Dallas, 8 pm to 8 am: temperature drop, spreading power outages,
// phones dying, check-ins, SOS messages. Deterministic for a given world + seed.
//
// The storm produces two things:
//  - `events`: what the system can observe (signals, sensor readings, check-ins, SOS). Loaders
//    push these into SpacetimeDB / Tiger. Times are minutes from `start`.
//  - `truth`: what really happened (who became critical and when, when phones died). Only
//    `measure.ts` reads it, to score strategies. The live system never sees it.
import { cellToParent } from "h3-js";
import { DEMO } from "./generate.js";
import { CHECKIN_NOTES, sosMessage, type SosReason } from "./messages.js";
import { Rng, hashUnit } from "./rng.js";
import type { Household, Language, Person, World } from "./types.js";

export const STORM_START_ISO = "2021-02-15T02:00:00.000Z"; // 8 pm CST, Feb 14
export const STORM_MINUTES = 12 * 60;
const STEP = 10; // minutes per thermal step
export const HEATED_F = 68;
export const LOW_TEMP_SIGNAL_F = 55;

export type CriticalCause = "hypothermia" | "oxygen" | "dialysis" | "co" | "fall";

export interface CriticalCase {
  personId: number;
  onset: number;
  cause: CriticalCause;
  /** Needs EMS/fire, not just a neighbor (CO, injury, dialysis transport). */
  needsPro: boolean;
}

export type StormEvent =
  | { t: number; kind: "signal"; personId: number; signal: "power_out" | "phone_offline" | "low_temp"; value: number }
  | { t: number; kind: "reading"; personId: number; h3Cell: string; reading: "indoor_temp_f"; value: number }
  | { t: number; kind: "check_in"; clientId: string; personId: number; checkKind: "app" | "sms" | "voice"; result: "safe" | "needs_help"; note: string }
  | {
      t: number;
      kind: "sos";
      clientId: string;
      personId: number;
      /** Sim-only: who is actually in trouble (Rosa sends for her mother). */
      aboutPersonId: number;
      reason: SosReason;
      message: string;
      lat: number;
      lng: number;
      h3Cell: string;
      channel: "app" | "sms" | "voice";
    };

export interface Storm {
  seed: number;
  start: string;
  minutes: number;
  /** Outdoor °F at the top of each hour, city average. */
  outdoorHourly: number[];
  /** Outage start (minute) per res-8 region, absent = kept power. */
  outages: Record<string, number>;
  events: StormEvent[];
  truth: {
    critical: CriticalCase[];
    /** Minute each person's phone stops working (absent = works all night). */
    phoneOfflineAt: Record<number, number>;
    /** Minute each household lost power (absent = never). */
    householdOutageAt: Record<number, number>;
  };
}

/** City-average outdoor temperature in °F at minute t (Uri night: 24 °F at 8 pm to ~3 °F before dawn). */
export function outdoorF(t: number): number {
  const h = t / 60;
  if (h <= 10) return 24 - 21 * Math.sin((Math.PI / 2) * (h / 10)); // 24 -> 3
  return 3 + (h - 10) * 2.5; // slow rise after 6 am
}

function region(h: Household): string {
  return cellToParent(h.h3Cell, 8);
}

export function generateStorm(world: World, seed = world.seed): Storm {
  const rng = new Rng(seed).fork("storm");
  const people = world.people;
  const hh = world.households;
  const membersOf = new Map<number, Person[]>();
  for (const p of people) {
    const l = membersOf.get(p.householdId);
    if (l) l.push(p);
    else membersOf.set(p.householdId, [p]);
  }

  // --- Outages: rolling blackouts that become sustained, rolling out in waves by neighborhood.
  const outRng = rng.fork("outage");
  const regions = [...new Set(hh.map(region))].sort();
  const waveStart: Record<string, number> = {};
  for (const name of [...new Set(hh.map((h) => h.neighborhood))].sort()) waveStart[name] = outRng.range(30, 240);
  const regionHood = new Map<string, string>();
  for (const h of hh) if (!regionHood.has(region(h))) regionHood.set(region(h), h.neighborhood);
  const outages: Record<string, number> = {};
  for (const r of regions) {
    if (outRng.chance(0.72)) outages[r] = Math.round(waveStart[regionHood.get(r)!] + outRng.exp(100));
  }
  const demoRegion = region(hh[DEMO.rosaHousehold - 1]);
  outages[demoRegion] = 90; // 9:30 pm on Tyler St
  // Cell towers on battery backup fail ~4 h after their region loses power in 20% of regions.
  const towerDownAt: Record<string, number> = {};
  for (const r of regions) if (outages[r] !== undefined && outRng.chance(0.2)) towerDownAt[r] = outages[r] + Math.round(outRng.range(180, 300));

  const householdOutageAt: Record<number, number> = {};
  for (const h of hh) {
    const o = outages[region(h)];
    if (o !== undefined && o < STORM_MINUTES) householdOutageAt[h.id] = o;
  }

  // --- Indoor temperature per household on a 10-minute grid (Newton cooling once heat is lost).
  const cellOffset = new Map<string, number>();
  const offRng = rng.fork("cell-temp");
  for (const c of [...new Set(hh.map((h) => h.h3Cell))].sort()) cellOffset.set(c, offRng.normal(0, 1.2));
  const steps = STORM_MINUTES / STEP + 1;
  const indoor = new Map<number, Float32Array>();
  for (const h of hh) {
    const arr = new Float32Array(steps);
    let temp = HEATED_F;
    const out = householdOutageAt[h.id];
    for (let i = 0; i < steps; i++) {
      const t = i * STEP;
      const outside = outdoorF(t) + (cellOffset.get(h.h3Cell) ?? 0);
      if (out !== undefined && t >= out) temp += (outside - temp) * (1 - Math.exp(-STEP / 60 / h.insulationTauHours));
      arr[i] = temp;
    }
    indoor.set(h.id, arr);
  }
  const indoorAt = (hid: number, t: number) => indoor.get(hid)![Math.min(steps - 1, Math.max(0, Math.floor(t / STEP)))];
  const firstBelow = (hid: number, f: number): number | undefined => {
    const arr = indoor.get(hid)!;
    for (let i = 0; i < steps; i++) if (arr[i] < f) return i * STEP;
    return undefined;
  };

  // --- Phones.
  const phoneRng = rng.fork("phones");
  const phoneOfflineAt: Record<number, number> = {};
  for (const p of people) {
    const h = hh[p.householdId - 1];
    const out = householdOutageAt[h.id];
    let off: number | undefined;
    if (out !== undefined) {
      if (p.phoneType === "cordless_landline") off = out; // base station needs mains power
      else {
        const battery = phoneRng.range(0.35, 1); // charge when the power went out
        const drainPerHour = p.phoneType === "smartphone" ? phoneRng.range(0.07, 0.12) : 0.04; // cold drains faster
        off = out + Math.round((battery / drainPerHour) * 60);
        const tower = towerDownAt[region(h)];
        if (tower !== undefined) off = Math.min(off, tower);
      }
    }
    if (p.id === DEMO.mrLee) off = 90;
    if (off !== undefined && off < STORM_MINUTES) phoneOfflineAt[p.id] = off;
  }
  const phoneOnline = (p: Person, t: number) => !(phoneOfflineAt[p.id] !== undefined && t >= phoneOfflineAt[p.id]);

  // --- Ground truth: who becomes critical, and when.
  const critRng = rng.fork("critical");
  const critical: CriticalCase[] = [];
  const critByPerson = new Map<number, CriticalCase>();
  const addCrit = (c: CriticalCase) => {
    if (c.onset >= STORM_MINUTES || critByPerson.has(c.personId)) return;
    critical.push(c);
    critByPerson.set(c.personId, c);
  };
  for (const p of people) {
    if (p.demoRole) continue;
    const h = hh[p.householdId - 1];
    const out = householdOutageAt[h.id];
    if (out === undefined) continue;
    const needs = p.medicalNeeds;
    const cands: CriticalCase[] = [];
    if (needs.includes("oxygen")) cands.push({ personId: p.id, onset: out + Math.round(critRng.range(30, 240)), cause: "oxygen", needsPro: false });
    if (needs.includes("dialysis")) cands.push({ personId: p.id, onset: out + Math.round(critRng.range(300, 480)), cause: "dialysis", needsPro: true });
    const frail = p.mobility === "cannot_walk" || p.age >= 80 || (p.age >= 70 && (p.livesAlone || p.mobility === "limited"));
    if (frail) {
      // Indoor 52 °F for the frail is a hypothermia risk; younger, mobile people leave or manage.
      const below = firstBelow(h.id, p.mobility === "cannot_walk" ? 54 : 52);
      if (below !== undefined && critRng.chance(0.55)) cands.push({ personId: p.id, onset: below, cause: "hypothermia", needsPro: false });
    }
    // Carbon monoxide from cars/grills/generators used for heat (a leading Uri cause of death).
    if (critRng.chance(0.0015)) cands.push({ personId: p.id, onset: out + Math.round(critRng.range(60, 480)), cause: "co", needsPro: true });
    if (p.age >= 70 && critRng.chance(0.012)) cands.push({ personId: p.id, onset: out + Math.round(critRng.range(30, 600)), cause: "fall", needsPro: true });
    cands.sort((a, b) => a.onset - b.onset);
    if (cands.length) addCrit(cands[0]);
  }
  // Scripted demo cases.
  addCrit({ personId: DEMO.rosaMother, onset: 140, cause: "hypothermia", needsPro: false });
  addCrit({ personId: DEMO.mrLee, onset: 180, cause: "oxygen", needsPro: false });
  critical.sort((a, b) => a.onset - b.onset || a.personId - b.personId);

  // --- Observable events.
  const events: StormEvent[] = [];
  const evRng = rng.fork("events");
  let seq = 0;
  const cid = (prefix: string) => `sim-${seed}-${prefix}-${++seq}`;
  const channelFor = (p: Person): "app" | "sms" | "voice" => (p.hasSmartphone ? "app" : p.phoneType === "feature" ? "sms" : "voice");

  for (const p of people) {
    const h = hh[p.householdId - 1];
    const out = householdOutageAt[h.id];
    // Utility outage feed: one power_out signal per person.
    if (out !== undefined) events.push({ t: out, kind: "signal", personId: p.id, signal: "power_out", value: 1 });
    // App heartbeat lost: only observable for smartphone users.
    const off = phoneOfflineAt[p.id];
    if (off !== undefined && p.hasSmartphone) events.push({ t: off, kind: "signal", personId: p.id, signal: "phone_offline", value: 1 });
    // Smart thermostat readings every 30 min and a low_temp signal when it crosses 55 °F.
    if (h.hasTempSensor) {
      for (let t = 0; t <= STORM_MINUTES; t += 30) {
        events.push({ t, kind: "reading", personId: p.id, h3Cell: p.h3Cell, reading: "indoor_temp_f", value: Math.round(indoorAt(h.id, t) * 10) / 10 });
      }
      const low = firstBelow(h.id, LOW_TEMP_SIGNAL_F);
      if (low !== undefined) events.push({ t: low, kind: "signal", personId: p.id, signal: "low_temp", value: Math.round(indoorAt(h.id, low) * 10) / 10 });
    }
  }

  // Check-ins: Porchlight pings everyone with the app at 9 pm, 12 am and 4 am.
  for (const ping of [60, 240, 480]) {
    for (const p of people) {
      if (!p.hasSmartphone || p.age < 14 || p.demoRole === "mr_lee") continue;
      const t = ping + Math.round(evRng.exp(25));
      if (t >= STORM_MINUTES || !phoneOnline(p, t)) continue;
      const crit = critByPerson.get(p.id);
      const inTrouble = crit !== undefined && crit.onset <= t;
      if (!evRng.chance(inTrouble ? 0.5 : 0.6)) continue;
      events.push({
        t,
        kind: "check_in",
        clientId: cid("ci"),
        personId: p.id,
        checkKind: "app",
        result: inTrouble ? "needs_help" : "safe",
        note: inTrouble ? "" : evRng.pick(CHECKIN_NOTES[p.language as Language]),
      });
    }
  }

  // SOS from critical cases: the person themselves, or another adult in the household.
  const reasonFor = (c: CriticalCase, self: boolean): SosReason =>
    c.cause === "hypothermia" ? (self ? "hypothermia_self" : "hypothermia_relative") : c.cause;
  for (const c of critical) {
    if (c.personId === DEMO.rosaMother || c.personId === DEMO.mrLee) continue;
    const p = people[c.personId - 1];
    const t = c.onset + Math.round(evRng.exp(25));
    if (t >= STORM_MINUTES) continue;
    const incapacitated = c.cause === "co" ? evRng.chance(0.7) : c.cause === "fall" ? evRng.chance(0.3) : false;
    // Older people living alone often do not ask for help ("didn't want to bother anyone").
    const pSelf = p.age >= 75 && p.livesAlone ? 0.45 : 0.75;
    let sender: Person | undefined;
    if (!incapacitated && p.age >= 12 && phoneOnline(p, t) && evRng.chance(pSelf)) sender = p;
    else {
      const other = (membersOf.get(p.householdId) ?? []).find((m) => m.id !== p.id && m.age >= 14 && phoneOnline(m, t));
      if (other && evRng.chance(0.85)) sender = other;
    }
    if (!sender) continue; // silent case
    events.push({
      t,
      kind: "sos",
      clientId: cid("sos"),
      personId: sender.id,
      aboutPersonId: p.id,
      reason: reasonFor(c, sender.id === p.id),
      message: sosMessage(reasonFor(c, sender.id === p.id), sender.language, evRng.next()),
      lat: sender.lat,
      lng: sender.lng,
      h3Cell: sender.h3Cell,
      channel: channelFor(sender),
    });
  }

  // Non-critical SOS (supplies, burst pipes, rides, worried relatives): the noise triage must sort.
  for (const p of people) {
    if (p.age < 16 || p.demoRole || critByPerson.has(p.id)) continue;
    const out = householdOutageAt[p.householdId];
    if (out === undefined) continue;
    const kids = (membersOf.get(p.householdId) ?? []).some((m) => m.age < 10);
    const pAsk = 0.012 + (kids ? 0.02 : 0) + (p.medicalNeeds.includes("insulin") ? 0.03 : 0);
    if (!evRng.chance(pAsk)) continue;
    const t = out + Math.round(evRng.range(30, 420));
    if (t >= STORM_MINUTES || !phoneOnline(p, t)) continue;
    const reason = evRng.weighted<SosReason>({ supplies: 0.4, pipes: 0.2, ride: 0.25, worried: 0.15 } as Record<SosReason, number>);
    events.push({
      t,
      kind: "sos",
      clientId: cid("sos"),
      personId: p.id,
      aboutPersonId: p.id,
      reason,
      message: sosMessage(reason, p.language, evRng.next()),
      lat: p.lat,
      lng: p.lng,
      h3Cell: p.h3Cell,
      channel: channelFor(p),
    });
  }

  // Scripted: Rosa's SOS for her mother at 10:30 pm. Mr. Lee never sends one.
  const rosa = people[DEMO.rosa - 1];
  events.push({
    t: 150,
    kind: "sos",
    clientId: `sim-${seed}-demo-rosa`,
    personId: rosa.id,
    aboutPersonId: DEMO.rosaMother,
    reason: "hypothermia_relative",
    message: "Se fue la luz y hace mucho frío. Mi mamá no puede caminar y no tenemos calefacción. Por favor ayuda.",
    lat: rosa.lat,
    lng: rosa.lng,
    h3Cell: rosa.h3Cell,
    channel: "app",
  });

  const order: Record<StormEvent["kind"], number> = { signal: 0, reading: 1, check_in: 2, sos: 3 };
  events.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind] || a.personId - b.personId);

  return {
    seed,
    start: STORM_START_ISO,
    minutes: STORM_MINUTES,
    outdoorHourly: Array.from({ length: 13 }, (_, h) => Math.round(outdoorF(h * 60) * 10) / 10),
    outages,
    events,
    truth: { critical, phoneOfflineAt, householdOutageAt },
  };
}

// --- Helper behavior ------------------------------------------------------------------------

export type HelperAction = "accept" | "decline" | "no_answer";

/**
 * How helper `helper` answers request `requestKey`. Deterministic per (seed, helper, request), so
 * `measure.ts`, tests and a live helper bot all see the same answer.
 * A helper whose phone is dead or who is in trouble themselves never answers.
 */
export function helperDecision(
  storm: Storm,
  helper: Person,
  requestKey: string,
  t: number,
): { action: HelperAction; afterMin: number } {
  const off = storm.truth.phoneOfflineAt[helper.id];
  if (off !== undefined && t >= off) return { action: "no_answer", afterMin: 0 };
  const crit = storm.truth.critical.find((c) => c.personId === helper.id);
  if (crit && crit.onset <= t) return { action: "no_answer", afterMin: 0 };
  const u = hashUnit(storm.seed, "help", helper.id, requestKey);
  const v = hashUnit(storm.seed, "help-lat", helper.id, requestKey);
  const afterMin = Math.max(1, Math.round(-Math.log(1 - v) * helper.helper.meanAnswerMin));
  if (u < helper.helper.accept) return { action: "accept", afterMin };
  if (u < helper.helper.accept + helper.helper.decline) return { action: "decline", afterMin };
  return { action: "no_answer", afterMin: 0 };
}

export function eventTime(storm: Storm, t: number, start = storm.start): string {
  return new Date(Date.parse(start) + t * 60_000).toISOString();
}

export interface PlayOptions {
  /** 1 = real time, 60 = one storm hour per minute, Infinity = as fast as possible. */
  speed?: number;
  /** Only play events in [from, to) minutes. */
  from?: number;
  to?: number;
  signal?: AbortSignal;
}

/** Plays events in order, waiting between them according to `speed`. */
export async function playStorm(storm: Storm, onEvent: (e: StormEvent, isoTime: string) => Promise<void> | void, opts: PlayOptions = {}): Promise<number> {
  const speed = opts.speed ?? Infinity;
  const from = opts.from ?? 0;
  const to = opts.to ?? storm.minutes;
  const wallStart = Date.now();
  // Live mode stamps events relative to now so the dashboard shows "just now".
  const isoStart = Number.isFinite(speed) ? new Date(wallStart - from * 60_000).toISOString() : storm.start;
  let n = 0;
  for (const e of storm.events) {
    if (e.t < from || e.t >= to) continue;
    if (opts.signal?.aborted) break;
    if (Number.isFinite(speed)) {
      const due = wallStart + ((e.t - from) * 60_000) / speed;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await onEvent(e, eventTime(storm, e.t, isoStart));
    n++;
  }
  return n;
}
