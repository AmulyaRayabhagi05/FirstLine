// Compares Porchlight with a calls-only baseline over the same world and storm.
// Minute-stepped discrete simulation. The model and every assumption are documented in
// sim/README.md ("Measurement model"); defaults lean toward the baseline where unsure.
import { gridDisk } from "h3-js";
import { Rng, hashUnit } from "./rng.js";
import { helperDecision, type CriticalCase, type Storm } from "./storm.js";
import type { Person, World } from "./types.js";

export interface MeasureParams {
  /** EMS/fire units available to this area during the storm. */
  proUnits: number;
  /** Unit drive time on ice, minutes (mean, sd). */
  proTravelMean: number;
  proTravelSd: number;
  /** Time a unit is tied up after arriving (on scene + transport/return). */
  proBusyAfterArrival: number;
  /** Silent critical cases where a relative or passer-by calls 911 at some point (both strategies). */
  thirdPartyCallP: number;
  thirdPartyCallMeanDelay: number;
  /** Without any app, people who ask for help also phone family or a neighbor; share who come, and mean minutes until they are at the door. Applied in both strategies. */
  informalHelpP: number;
  informalHelpMeanMin: number;
  /** Silent people whom a neighbor or relative happens to check on during the night (both strategies). */
  informalCheckP: number;
  informalCheckMeanMin: number;
  /** Minimum minutes between automated calls to the same person. */
  recallMin: number;
  /** Porchlight triage latency and how often it under-rates a real emergency (P1 -> P2). */
  triageMin: number;
  triageMissP: number;
  /** Assignment offer timeout (contract: 10 minutes). */
  offerTimeoutMin: number;
  /** Minutes a helper needs before leaving home. */
  helperPrepMin: number;
  /** km/h on icy streets: walking vs with a truck. */
  walkKmh: number;
  truckKmh: number;
  /** Helper is busy this long after arriving. */
  helperBusyMin: number;
  /** Scale all neighbor accept probabilities (sensitivity). */
  acceptScale: number;
  /** Silent-signal sweep interval and thresholds on the observable priority score. */
  sweepMin: number;
  callThreshold: number;
  checkThreshold: number;
  /** Max concurrent neighbor checks started per sweep (avoid flooding helpers). */
  checksPerSweep: number;
  /** Simulate this many minutes past the end of the storm so late cases can finish. */
  tailMin: number;
}

export const DEFAULT_PARAMS: MeasureParams = {
  proUnits: 3,
  proTravelMean: 35,
  proTravelSd: 10,
  proBusyAfterArrival: 60,
  thirdPartyCallP: 0.3,
  thirdPartyCallMeanDelay: 120,
  informalHelpP: 0.5,
  informalHelpMeanMin: 60,
  informalCheckP: 0.25,
  informalCheckMeanMin: 240,
  recallMin: 60,
  triageMin: 1,
  triageMissP: 0.15,
  offerTimeoutMin: 10,
  helperPrepMin: 5,
  walkKmh: 3,
  truckKmh: 12,
  helperBusyMin: 45,
  acceptScale: 1,
  sweepMin: 15,
  callThreshold: 10,
  checkThreshold: 14,
  checksPerSweep: 25,
  tailMin: 180,
};

export interface CaseOutcome {
  personId: number;
  onset: number;
  cause: CriticalCase["cause"];
  silent: boolean;
  reachedAt?: number;
  by?: "neighbor" | "pro";
}

export interface StrategyResult {
  name: string;
  cases: CaseOutcome[];
  stats: Record<string, number>;
}

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------------------------------------------------------------------------------------------
// Shared: who is critical, who asked for help, and the EMS queue.

interface Ctx {
  world: World;
  storm: Storm;
  p: MeasureParams;
  critByPerson: Map<number, CriticalCase>;
  /** First SOS (or in-app needs_help) about each person. */
  firstAsk: Map<number, number>;
  thirdPartyCalls: { personId: number; t: number }[];
  /** Spontaneous visits by family/neighbors that happen with or without Porchlight. */
  informal: { personId: number; t: number }[];
  end: number;
}

function buildCtx(world: World, storm: Storm, p: MeasureParams): Ctx {
  const critByPerson = new Map(storm.truth.critical.map((c) => [c.personId, c]));
  const firstAsk = new Map<number, number>();
  for (const e of storm.events) {
    if (e.kind === "sos" && !firstAsk.has(e.aboutPersonId)) firstAsk.set(e.aboutPersonId, e.t);
  }
  const rng = new Rng(storm.seed).fork("third-party");
  const thirdPartyCalls: Ctx["thirdPartyCalls"] = [];
  for (const c of storm.truth.critical) {
    if (firstAsk.has(c.personId)) continue;
    if (rng.chance(p.thirdPartyCallP)) thirdPartyCalls.push({ personId: c.personId, t: Math.round(c.onset + rng.exp(p.thirdPartyCallMeanDelay)) });
  }
  const inf = new Rng(storm.seed).fork("informal");
  const informal: Ctx["informal"] = [];
  for (const c of storm.truth.critical) {
    const ask = firstAsk.get(c.personId);
    if (ask !== undefined) {
      if (inf.chance(p.informalHelpP)) informal.push({ personId: c.personId, t: Math.round(ask + 10 + inf.exp(p.informalHelpMeanMin)) });
    } else if (inf.chance(p.informalCheckP)) informal.push({ personId: c.personId, t: Math.round(c.onset + inf.exp(p.informalCheckMeanMin)) });
  }
  return { world, storm, p, critByPerson, firstAsk, thirdPartyCalls, informal, end: storm.minutes + p.tailMin };
}

class ProQueue {
  private unitsFreeAt: number[];
  private queue: { personId: number; prio: number; at: number; seq: number }[] = [];
  private seq = 0;
  private queued = new Set<number>();
  constructor(
    units: number,
    private p: MeasureParams,
    private seed: number,
    private onArrive: (personId: number, t: number) => void,
  ) {
    this.unitsFreeAt = Array(units).fill(0);
  }
  call(personId: number, prio: number, at: number) {
    if (this.queued.has(personId)) return;
    this.queued.add(personId);
    this.queue.push({ personId, prio, at, seq: this.seq++ });
  }
  has(personId: number) {
    return this.queued.has(personId);
  }
  /** Cancel a pending call (a neighbor got there and it was not a professional need). */
  cancel(personId: number) {
    this.queue = this.queue.filter((q) => q.personId !== personId);
  }
  step(t: number) {
    this.queue.sort((a, b) => a.prio - b.prio || a.at - b.at || a.seq - b.seq);
    for (let u = 0; u < this.unitsFreeAt.length; u++) {
      if (this.unitsFreeAt[u] > t) continue;
      const i = this.queue.findIndex((q) => q.at <= t);
      if (i < 0) return;
      const job = this.queue.splice(i, 1)[0];
      const z = hashUnit(this.seed, "pro", job.personId);
      const travel = Math.max(15, Math.round(this.p.proTravelMean + this.p.proTravelSd * Math.sqrt(-2 * Math.log(1 - z)) * Math.cos(2 * Math.PI * hashUnit(this.seed, "pro2", job.personId))));
      const arrive = t + travel;
      this.unitsFreeAt[u] = arrive + this.p.proBusyAfterArrival;
      this.onArrive(job.personId, arrive);
    }
  }
}

function finish(name: string, ctx: Ctx, reached: Map<number, { t: number; by: "neighbor" | "pro" }[]>, extra: Record<string, number> = {}): StrategyResult {
  for (const v of ctx.informal) if (v.t <= ctx.end) reached.set(v.personId, [...(reached.get(v.personId) ?? []), { t: v.t, by: "neighbor" }]);
  const cases: CaseOutcome[] = ctx.storm.truth.critical.map((c) => {
    const visits = (reached.get(c.personId) ?? []).filter((v) => v.t >= c.onset).sort((a, b) => a.t - b.t);
    const first = visits[0];
    return { personId: c.personId, onset: c.onset, cause: c.cause, silent: !ctx.firstAsk.has(c.personId), reachedAt: first?.t, by: first?.by };
  });
  return { name, cases, stats: { ...summarizeCases(cases), ...extra } };
}

export function summarizeCases(cases: CaseOutcome[]): Record<string, number> {
  const within = (cs: CaseOutcome[], m: number) => cs.filter((c) => c.reachedAt !== undefined && c.reachedAt - c.onset <= m).length;
  const silent = cases.filter((c) => c.silent);
  const times = cases.filter((c) => c.reachedAt !== undefined).map((c) => c.reachedAt! - c.onset).sort((a, b) => a - b);
  return {
    critical: cases.length,
    silent: silent.length,
    within30: within(cases, 30),
    within60: within(cases, 60),
    within120: within(cases, 120),
    reachedByEnd: times.length,
    medianMin: times.length ? times[Math.floor(times.length / 2)] : NaN,
    silentWithin120: within(silent, 120),
    silentReachedByEnd: silent.filter((c) => c.reachedAt !== undefined).length,
  };
}

// ---------------------------------------------------------------------------------------------
// Baseline: people call 911; units serve calls about critical people, P1 first.

export function runCallsOnly(world: World, storm: Storm, p: MeasureParams = DEFAULT_PARAMS): StrategyResult {
  const ctx = buildCtx(world, storm, p);
  const reached = new Map<number, { t: number; by: "neighbor" | "pro" }[]>();
  const q = new ProQueue(p.proUnits, p, storm.seed, (id, t) => reached.set(id, [...(reached.get(id) ?? []), { t, by: "pro" }]));
  const calls: { personId: number; t: number }[] = [];
  // Generous to the baseline: every SOS-sender would have reached 911 instantly, call-takers
  // triage perfectly, and non-emergency calls are sent to 311 without using a unit.
  for (const [id, t] of ctx.firstAsk) if (ctx.critByPerson.has(id)) calls.push({ personId: id, t });
  calls.push(...ctx.thirdPartyCalls);
  calls.sort((a, b) => a.t - b.t);
  let i = 0;
  for (let t = 0; t <= ctx.end; t++) {
    while (i < calls.length && calls[i].t <= t) q.call(calls[i].personId, 1, calls[i++].t);
    q.step(t);
  }
  return finish("calls-only", ctx, reached, { proCalls: calls.length });
}

// ---------------------------------------------------------------------------------------------
// Porchlight: triaged SOS -> safety-net dispatch (ring 1, 2, then nearby), escalation to EMS,
// plus the silent-signal sweep (priority score -> automated call -> neighbor check).

interface Request {
  personId: number;
  key: string;
  prio: number; // 1 = P1, 2 = P2, 3 = P3
  createdAt: number;
  candidates: number[];
  idx: number;
  /** When the current offer resolves, and how. */
  pending?: { helperId: number; at: number; action: "accept" | "decline" | "no_answer"; arriveAt?: number };
  state: "dispatching" | "enroute" | "done" | "exhausted";
  isCheck: boolean;
}

export function priorityScore(person: Person, obs: { powerOut: boolean; lowTemp: boolean; phoneOffline: boolean; minsSinceContact: number; failedCalls: number }): number {
  let v = 1;
  if (person.age >= 75) v += 1;
  else if (person.age >= 65) v += 0.5;
  if (person.livesAlone) v += 0.8;
  if (person.poweredDevice || person.medicalNeeds.includes("oxygen")) v += 1.2;
  if (person.mobility === "cannot_walk") v += 1.5;
  else if (person.mobility === "limited") v += 0.8;
  if (!person.hasSmartphone) v += 0.5;
  if (person.language !== "en") v += 0.3;
  const e = 1 + (obs.powerOut ? 1.5 : 0) + (obs.lowTemp ? 1 : 0);
  const g = 1 + Math.min(3, obs.minsSinceContact / 120) + 0.5 * obs.failedCalls + (obs.phoneOffline ? 1 : 0);
  return v * e * g;
}

export function runPorchlight(world: World, storm: Storm, p: MeasureParams = DEFAULT_PARAMS): StrategyResult {
  const ctx = buildCtx(world, storm, p);
  const people = world.people;
  const byId = (id: number) => people[id - 1];
  const reached = new Map<number, { t: number; by: "neighbor" | "pro" }[]>();
  const visit = (id: number, t: number, by: "neighbor" | "pro") => reached.set(id, [...(reached.get(id) ?? []), { t, by }]);
  const q = new ProQueue(p.proUnits, p, storm.seed, (id, t) => visit(id, t, "pro"));

  // Nets by owner, household members, people by cell.
  const net = new Map<number, { memberId: number; ring: number }[]>();
  for (const m of world.nets) net.set(m.ownerId, [...(net.get(m.ownerId) ?? []), m]);
  const household = new Map<number, Person[]>();
  for (const x of people) household.set(x.householdId, [...(household.get(x.householdId) ?? []), x]);
  const byCell = new Map<string, Person[]>();
  for (const x of people) byCell.set(x.h3Cell, [...(byCell.get(x.h3Cell) ?? []), x]);

  const candidatesFor = (target: Person): number[] => {
    const hhIds = new Set((household.get(target.householdId) ?? []).map((m) => m.id));
    const out: number[] = [];
    const add = (id: number) => {
      if (!hhIds.has(id) && !out.includes(id)) out.push(id);
    };
    // The target's own net; for children or people without one, any household member's net.
    const owners = [target, ...(household.get(target.householdId) ?? [])];
    for (const ring of [1, 2]) for (const o of owners) for (const m of net.get(o.id) ?? []) if (m.ring === ring) add(m.memberId);
    // Ring 3: nearest able adults in the surrounding cells (dispatch agent widens the search).
    const near = gridDisk(target.h3Cell, 1)
      .flatMap((c) => byCell.get(c) ?? [])
      .filter((x) => x.age >= 18 && x.age < 75 && x.mobility === "ok" && !x.demoRole)
      .sort((a, b) => km(target, a) - km(target, b) || a.id - b.id)
      .slice(0, 6);
    for (const x of near) add(x.id);
    return out;
  };

  const requests: Request[] = [];
  const activeFor = new Map<number, Request>();
  const helperBusyUntil = new Map<number, number>();
  const lastContact = new Map<number, number>();
  const failedCalls = new Map<number, number>();
  const lastCallAt = new Map<number, number>();
  const obs = { powerOut: new Set<number>(), lowTemp: new Set<number>(), phoneOffline: new Set<number>() };
  const stats = { sosRequests: 0, offers: 0, accepts: 0, declines: 0, timeouts: 0, escalations: 0, autoCalls: 0, autoCallsAnswered: 0, neighborChecks: 0, checksFoundCritical: 0, exhausted: 0 };

  const openRequest = (personId: number, prio: number, t: number, key: string, isCheck: boolean) => {
    const existing = activeFor.get(personId);
    if (existing && existing.state !== "done" && existing.state !== "exhausted") {
      existing.prio = Math.min(existing.prio, prio);
      return;
    }
    const r: Request = { personId, key, prio, createdAt: t, candidates: candidatesFor(byId(personId)), idx: 0, state: "dispatching", isCheck };
    requests.push(r);
    activeFor.set(personId, r);
  };

  const accept = (u: number) => Math.min(1, u);
  const offerNext = (r: Request, t: number) => {
    while (r.idx < r.candidates.length) {
      const hid = r.candidates[r.idx++];
      if ((helperBusyUntil.get(hid) ?? -1) > t) continue; // the dispatcher sees who is busy
      if (obs.phoneOffline.has(hid)) continue; // ...and whose app has stopped reporting
      const helper = byId(hid);
      const scaled = { ...helper, helper: { ...helper.helper, accept: accept(helper.helper.accept * p.acceptScale) } };
      const d = helperDecision(storm, scaled, r.key, t);
      stats.offers++;
      if (d.action === "accept") {
        const speed = helper.skills.includes("truck") ? p.truckKmh : p.walkKmh;
        const travel = p.helperPrepMin + Math.round((km(helper, byId(r.personId)) / speed) * 60);
        r.pending = { helperId: hid, at: t + d.afterMin, action: "accept", arriveAt: t + d.afterMin + travel };
        helperBusyUntil.set(hid, t + d.afterMin + travel + p.helperBusyMin);
      } else if (d.action === "decline") r.pending = { helperId: hid, at: t + d.afterMin, action: "decline" };
      else r.pending = { helperId: hid, at: t + p.offerTimeoutMin, action: "no_answer" };
      return;
    }
    r.pending = undefined;
    r.state = "exhausted";
    stats.exhausted++;
    if (r.prio <= 2) {
      stats.escalations++;
      q.call(r.personId, r.prio, t);
    }
  };

  // Observable events by minute.
  const evByMinute = new Map<number, typeof storm.events>();
  for (const e of storm.events) evByMinute.set(e.t, [...(evByMinute.get(e.t) ?? []), e]);
  const triageRng = new Rng(storm.seed).fork("triage");
  const tpCalls = [...ctx.thirdPartyCalls].sort((a, b) => a.t - b.t);
  let tpi = 0;
  const pendingTriage: { at: number; personId: number; prio: number; key: string; needsPro: boolean }[] = [];

  for (let t = 0; t <= ctx.end; t++) {
    for (const e of evByMinute.get(t) ?? []) {
      if (e.kind === "signal") {
        if (e.signal === "power_out") obs.powerOut.add(e.personId);
        else if (e.signal === "low_temp") obs.lowTemp.add(e.personId);
        else obs.phoneOffline.add(e.personId);
      } else if (e.kind === "check_in") {
        lastContact.set(e.personId, t);
        if (e.result === "needs_help") pendingTriage.push({ at: t + p.triageMin, personId: e.personId, prio: 1, key: `ci:${e.clientId}`, needsPro: ctx.critByPerson.get(e.personId)?.needsPro ?? false });
      } else if (e.kind === "sos") {
        stats.sosRequests++;
        lastContact.set(e.personId, t);
        const crit = ctx.critByPerson.get(e.aboutPersonId);
        const isEmergency = crit !== undefined && crit.onset <= t;
        const prio = isEmergency ? (triageRng.chance(p.triageMissP) ? 2 : 1) : triageRng.chance(0.1) ? 2 : 3;
        pendingTriage.push({ at: t + p.triageMin, personId: e.aboutPersonId, prio, key: `sos:${e.clientId}`, needsPro: isEmergency && crit!.needsPro && prio === 1 });
      }
    }
    for (let i = pendingTriage.length - 1; i >= 0; i--) {
      const x = pendingTriage[i];
      if (x.at > t) continue;
      pendingTriage.splice(i, 1);
      openRequest(x.personId, x.prio, t, x.key, false);
      if (x.needsPro) q.call(x.personId, 1, t); // call EMS in parallel; neighbor still goes
    }
    while (tpi < tpCalls.length && tpCalls[tpi].t <= t) q.call(tpCalls[tpi].personId, 1, tpCalls[tpi++].t);

    // Silent-signal sweep: score everyone without a recent contact, call, then send a neighbor.
    if (t % p.sweepMin === 0 && t <= storm.minutes) {
      const scored: { person: Person; score: number }[] = [];
      for (const person of people) {
        if (person.age < 16) continue;
        const r = activeFor.get(person.id);
        if (r && r.state !== "done" && r.state !== "exhausted") continue;
        const since = t - (lastContact.get(person.id) ?? 0);
        if (since < 60 || t - (lastCallAt.get(person.id) ?? -Infinity) < p.recallMin) continue;
        const score = priorityScore(person, {
          powerOut: obs.powerOut.has(person.id),
          lowTemp: obs.lowTemp.has(person.id),
          phoneOffline: obs.phoneOffline.has(person.id),
          minsSinceContact: since,
          failedCalls: failedCalls.get(person.id) ?? 0,
        });
        if (score >= p.callThreshold) scored.push({ person, score });
      }
      scored.sort((a, b) => b.score - a.score || a.person.id - b.person.id);
      let checks = 0;
      for (const { person, score } of scored) {
        stats.autoCalls++;
        lastCallAt.set(person.id, t);
        const crit = ctx.critByPerson.get(person.id);
        const inTrouble = crit !== undefined && crit.onset <= t;
        const off = storm.truth.phoneOfflineAt[person.id];
        const phoneUp = !(off !== undefined && t >= off);
        const canTalk = !(inTrouble && (crit!.cause === "co" || crit!.cause === "fall"));
        const answers = phoneUp && canTalk && hashUnit(storm.seed, "answer", person.id, t) < (inTrouble ? 0.6 : 0.85);
        if (answers) {
          stats.autoCallsAnswered++;
          lastContact.set(person.id, t);
          failedCalls.set(person.id, 0);
          if (inTrouble) openRequest(person.id, 1, t + 1, `call:${person.id}:${t}`, false);
          continue;
        }
        failedCalls.set(person.id, (failedCalls.get(person.id) ?? 0) + 1);
        if (score >= p.checkThreshold && checks < p.checksPerSweep) {
          checks++;
          stats.neighborChecks++;
          openRequest(person.id, 2, t, `check:${person.id}:${t}`, true);
        }
      }
    }

    // Dispatch, in priority order.
    const live = requests.filter((r) => r.state === "dispatching" || r.state === "enroute");
    live.sort((a, b) => a.prio - b.prio || a.createdAt - b.createdAt);
    for (const r of live) {
      if (r.state === "dispatching" && !r.pending) {
        offerNext(r, t);
        continue;
      }
      const pd = r.pending;
      if (!pd || pd.at > t) {
        if (r.state === "enroute" && pd?.arriveAt !== undefined && pd.arriveAt <= t) {
          r.state = "done";
          visit(r.personId, pd.arriveAt, "neighbor");
          lastContact.set(r.personId, pd.arriveAt);
          const crit = ctx.critByPerson.get(r.personId);
          if (r.isCheck && crit && crit.onset <= pd.arriveAt) {
            stats.checksFoundCritical++;
            q.call(r.personId, 1, t); // neighbor found an emergency: escalate
          } else if (!(crit && crit.needsPro)) q.cancel(r.personId);
        }
        continue;
      }
      if (pd.action === "accept") {
        stats.accepts++;
        r.state = "enroute";
        pd.at = Infinity;
      } else {
        if (pd.action === "decline") stats.declines++;
        else stats.timeouts++;
        r.pending = undefined;
        offerNext(r, t);
      }
    }
    q.step(t);
  }
  return finish("porchlight", ctx, reached, stats);
}

// ---------------------------------------------------------------------------------------------

export interface Comparison {
  seed: number;
  params: MeasureParams;
  baseline: StrategyResult;
  porchlight: StrategyResult;
}

export function compare(world: World, storm: Storm, params: Partial<MeasureParams> = {}): Comparison {
  const p = { ...DEFAULT_PARAMS, ...params };
  return { seed: storm.seed, params: p, baseline: runCallsOnly(world, storm, p), porchlight: runPorchlight(world, storm, p) };
}
