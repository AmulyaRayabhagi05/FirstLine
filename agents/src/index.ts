// FirstLine agent worker: wires store subscriptions to the Nemotron agents.
//   new SOS            -> triage -> dispatch
//   offer timed out    -> dispatch (replan)
//   offer declined     -> dispatch (replan)
//   needs_help check-in -> opens an SOS for that person (then triage -> dispatch as above)
//   dashboard request  -> respond / call / escalate / send neighbor / claim timeline (agents/actions.ts)
//   every N seconds    -> silent-signal sweep, reports sweep
//
// Run with `npm start`. With SPACETIME_DB_NAME set it runs on SpacetimeDB (store/spacetime.ts),
// otherwise on the InMemoryStore. SMS/voice, mesh, Tiger and live feeds start when their env is set.

import { pathToFileURL } from "node:url";
import { ACTION_LABEL, activeSos, ensureSos, sosForCheckIn, sosSummary, timelineText, writeClaimTimeline, type ActionResult } from "./agents/actions.js";
import { runDispatch, type DispatchOutcome, type DispatchTrigger } from "./agents/dispatch.js";
import type { AgentDeps } from "./agents/loop.js";
import { runReportsSweep } from "./agents/reports.js";
import { SilentSignalAgent } from "./agents/silentSignal.js";
import { runTriage, type TriageOutcome } from "./agents/triage.js";
import { OpenAICompatClient, llmConfigFromEnv } from "./llm/client.js";
import { loadEnvFile } from "./llm/env.js";
import { channelStoreFor, startChannels } from "./runtime/channels.js";
import { buildServices } from "./runtime/services.js";
import { InMemoryStore } from "./store/memory.js";
import { SpacetimeStore, spacetimeConfigFromEnv } from "./store/spacetime.js";
import type { ActionRequest, CheckIn, FirstLineStore, Id, SosChannel, Unsubscribe } from "./store/types.js";

export * from "./store/types.js";
export { InMemoryStore } from "./store/memory.js";
export * from "./priority.js";
export * from "./agents/index.js";
export * from "./llm/index.js";

export interface WorkerOptions {
  silentSignalEveryMs?: number;
  reportsEveryMs?: number;
  /** How often to give an SOS to needs_help people who have none (0 = off). Default 30 s. */
  needsHelpEveryMs?: number;
  /** Agent runs at once across SOS events (the flood demo opens dozens). Default 4. */
  concurrency?: number;
  onError?: (where: string, err: unknown) => void;
}

/** A tiny counting semaphore so a burst of SOS events queues instead of flooding the model. */
class Gate {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class AgentWorker {
  readonly silentSignal: SilentSignalAgent;
  readonly triaged: TriageOutcome[] = [];
  readonly dispatched: DispatchOutcome[] = [];
  private subs: Unsubscribe[] = [];
  private timers: NodeJS.Timeout[] = [];
  private pending = new Set<Promise<unknown>>();
  /** Serialize work per SOS so a timeout and a decline never dispatch concurrently. */
  private sosChains = new Map<Id, Promise<unknown>>();
  private readonly gate: Gate;
  readonly actionsRun: (ActionRequest & ActionResult)[] = [];

  constructor(
    readonly deps: AgentDeps,
    private readonly opts: WorkerOptions = {},
  ) {
    this.silentSignal = new SilentSignalAgent(deps);
    this.gate = new Gate(Math.max(1, opts.concurrency ?? 4));
  }

  private onError(where: string, err: unknown) {
    (this.opts.onError ?? ((w, e) => console.error(`[worker] ${w} failed:`, e)))(where, err);
  }

  private track<T>(p: Promise<T>): Promise<T | undefined> {
    const tracked = p.catch((err) => {
      this.onError("task", err);
      return undefined;
    });
    this.pending.add(tracked);
    tracked.finally(() => this.pending.delete(tracked));
    return tracked;
  }

  private onSos<T>(sosId: Id, work: () => Promise<T>): Promise<T | undefined> {
    const prev = this.sosChains.get(sosId) ?? Promise.resolve();
    const gated = () => this.gate.run(work);
    const next = prev.then(gated, gated);
    this.sosChains.set(sosId, next.catch(() => undefined));
    return this.track(next);
  }

  /** Triage, then dispatch. Idempotent: skips triage that exists and dispatch while an offer is live. */
  async handleSos(sosId: Id, opts: { retriage?: boolean; redispatch?: boolean } = {}): Promise<void> {
    await this.onSos(sosId, async () => {
      const { store } = this.deps;
      const sos = await store.getSos(sosId);
      if (!sos || sos.state === "resolved") return;
      if (opts.retriage || !(await store.getTriageForSos(sosId))) this.triaged.push(await runTriage(this.deps, sos));
      const live = (await store.listAssignments(sosId)).some((a) => a.state === "offered" || a.state === "accepted");
      if (!live || opts.redispatch) this.dispatched.push(await runDispatch(this.deps, sosId, { kind: "new_sos" }));
    });
  }

  /** A needs-help check-in opens an SOS; triage and dispatch then run on it as for a pressed SOS. */
  async handleCheckIn(c: CheckIn): Promise<void> {
    const want = sosForCheckIn(c);
    if (!want) return;
    // The onSos listener picks the new SOS up.
    await this.track(this.openFor(c.personId, want.clientId, want.message, want.channel));
  }

  /** A dashboard button: run it with the agents and write the outcome back to action_request. */
  async handleAction(req: ActionRequest): Promise<ActionResult | undefined> {
    const { store, services } = this.deps;
    const finish = async (r: ActionResult) => {
      this.actionsRun.push({ ...req, ...r });
      await store.finishAction(req.id, r.state, r.result).catch((err) => this.onError("finishAction", err));
      await store
        .logAgentStep({
          agent: req.action === "claim_timeline" ? "reports" : "dispatch",
          subject: `person:${req.personId}`,
          kind: "decision",
          content: r.result.slice(0, 1900),
        })
        .catch(() => undefined);
      return r;
    };
    return this.track(
      (async () => {
        const person = await store.getPerson(req.personId);
        if (!person) return finish({ state: "failed", result: `Person ${req.personId} not found` });
        const note = req.note ? ` Staff note: ${req.note}` : "";
        const open = (msg: string) => ensureSos(this.deps, person, `action:${req.id}`, msg, "app");
        try {
          switch (req.action) {
            case "respond": {
              const { sos, created } = await open(`Staff asked Nemotron to respond for ${person.name}.${note}`);
              await this.handleSos(sos.id, { retriage: !created });
              return finish({ state: "done", result: `Nemotron responded for ${person.name}: ${await sosSummary(this.deps, sos.id)}` });
            }
            case "send_neighbor": {
              const { sos } = await open(`Staff asked for a neighbor to check on ${person.name}.${note}`);
              await this.handleSos(sos.id, { redispatch: true });
              return finish({ state: "done", result: `Neighbor dispatch for ${person.name}: ${await sosSummary(this.deps, sos.id)}` });
            }
            case "escalate": {
              const { sos } = await open(`Staff escalated ${person.name} to professional responders.${note}`);
              await this.onSos(sos.id, async () => {
                const s = await store.getSos(sos.id);
                if (!s) return;
                if (!(await store.getTriageForSos(sos.id))) this.triaged.push(await runTriage(this.deps, s));
                await store.escalate(sos.id, `Staff escalation from the dashboard.${note}`.slice(0, 1900));
              });
              return finish({ state: "done", result: `Escalated ${person.name} to professional responders. ${await sosSummary(this.deps, sos.id)}` });
            }
            case "call": {
              if (!person.phone) return finish({ state: "failed", result: `${person.name} has no phone on file` });
              const r = await services.comms.requestCall({
                personId: person.id,
                phone: person.phone,
                language: person.language,
                reason: `Staff asked for a check-in call.${note}`,
              });
              return finish({ state: "done", result: `Check-in call placed to ${person.name} (${r.id}). The answer arrives as a check-in or SOS.` });
            }
            case "claim_timeline": {
              const t = await this.gate.run(() => writeClaimTimeline(this.deps, person));
              return finish({ state: "done", result: timelineText(t) });
            }
          }
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          return finish({ state: "failed", result: `${ACTION_LABEL[req.action]} failed: ${why}`.slice(0, 500) });
        }
      })(),
    );
  }

  /** People already being given an SOS (check-in handler and sweep must not both open one). */
  private opening = new Set<Id>();

  private async openFor(personId: Id, clientId: string, message: string, channel: SosChannel): Promise<boolean> {
    if (this.opening.has(personId)) return false;
    this.opening.add(personId);
    try {
      const person = await this.deps.store.getPerson(personId);
      if (!person || person.status !== "needs_help" || (await activeSos(this.deps, personId))) return false;
      return (await ensureSos(this.deps, person, clientId, message, channel)).created;
    } finally {
      this.opening.delete(personId);
    }
  }

  /**
   * Everyone marked needs_help with no active SOS gets one, so the agents triage the whole flood,
   * including check-ins that arrived while the worker was down. Returns how many were opened.
   */
  async sweepNeedsHelp(): Promise<number> {
    const { store } = this.deps;
    let opened = 0;
    for (const p of (await store.listPeople()).filter((x) => x.status === "needs_help")) {
      if (await activeSos(this.deps, p.id)) continue;
      const last = (await store.listCheckIns(p.id)).filter((c) => c.result === "needs_help").at(-1);
      const want = last ? sosForCheckIn(last) : undefined;
      const stamp = p.lastSeen?.getTime() ?? 0;
      const ok = await this.openFor(
        p.id,
        `needs-help:${p.id}:${stamp}`,
        want?.message ?? `Marked as needing help${last?.note ? `: ${last.note}` : "."}`,
        want?.channel ?? "app",
      ).catch((err) => (this.onError("sweepNeedsHelp", err), false));
      if (ok) opened++;
    }
    return opened;
  }

  async handleReplan(sosId: Id, trigger: DispatchTrigger): Promise<void> {
    await this.onSos(sosId, async () => {
      this.dispatched.push(await runDispatch(this.deps, sosId, trigger));
    });
  }

  start(): this {
    const { store } = this.deps;
    this.subs.push(
      store.onSos((sos) => void this.handleSos(sos.id)),
      store.onAssignmentTimeout((a) => void this.handleReplan(a.sosId, { kind: "timeout", assignment: a })),
      store.onAssignmentDeclined((a) => void this.handleReplan(a.sosId, { kind: "declined", assignment: a })),
      store.onCheckIn((c) => void this.handleCheckIn(c)),
      store.onActionRequest((r) => void this.handleAction(r)),
    );
    const ss = this.opts.silentSignalEveryMs ?? 60_000;
    const rp = this.opts.reportsEveryMs ?? 120_000;
    if (ss > 0) this.timers.push(setInterval(() => void this.track(this.silentSignal.sweep()), ss));
    if (rp > 0) this.timers.push(setInterval(() => void this.track(runReportsSweep(this.deps)), rp));
    const nh = this.opts.needsHelpEveryMs ?? 30_000;
    if (nh > 0) this.timers.push(setInterval(() => void this.track(this.sweepNeedsHelp()), nh));
    return this;
  }

  stop(): void {
    for (const u of this.subs) u();
    for (const t of this.timers) clearInterval(t);
    this.subs = [];
    this.timers = [];
  }

  /** Resolves when every in-flight agent run has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

/** Process anything that arrived while the worker was down: untriaged SOS, stalled offers. */
export async function catchUp(worker: AgentWorker): Promise<number> {
  const { store } = worker.deps;
  let n = 0;
  for (const req of await store.listPendingActions()) {
    void worker.handleAction(req);
    n++;
  }
  n += await worker.sweepNeedsHelp();
  for (const sos of await store.listOpenSos()) {
    const triage = await store.getTriageForSos(sos.id);
    const live = (await store.listAssignments(sos.id)).some((a) => a.state === "offered" || a.state === "accepted");
    if (!triage) {
      void worker.handleSos(sos.id);
      n++;
    } else if (!live) {
      const last = (await store.listAssignments(sos.id)).at(-1);
      void worker.handleReplan(
        sos.id,
        last && (last.state === "timed_out" || last.state === "declined")
          ? { kind: last.state === "timed_out" ? "timeout" : "declined", assignment: last }
          : { kind: "new_sos" },
      );
      n++;
    }
  }
  return n;
}

const flagOn = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : v !== "0" && v !== "false");

export async function main(env: NodeJS.ProcessEnv = process.env) {
  loadEnvFile();
  const llm = new OpenAICompatClient(llmConfigFromEnv(env));

  let store: FirstLineStore;
  let spacetime: SpacetimeStore | undefined;
  if (env.SPACETIME_DB_NAME) {
    const cfg = spacetimeConfigFromEnv(env);
    spacetime = await SpacetimeStore.connect(cfg);
    store = spacetime;
    console.log(`[worker] SpacetimeDB ${cfg.host} database ${cfg.dbName}`);
    console.log(`[worker] worker identity: 0x${spacetime.identityHex}`);
    console.log(
      `[worker] if not done yet, the module owner runs once:
  spacetime call --server ${/maincloud/.test(cfg.host) ? "maincloud" : cfg.host} ${cfg.dbName} set_worker_identity '"0x${spacetime.identityHex}"'`,
    );
  } else {
    const mem = new InMemoryStore();
    store = mem;
    // The in-memory store has no scheduler; simulate the module's 10-minute timeout.
    setInterval(() => mem.tick(), 15_000).unref();
    console.log("[worker] SPACETIME_DB_NAME not set: using InMemoryStore");
  }

  const channelStore = channelStoreFor(store);
  const rt = buildServices(store, channelStore, env);
  const worker = new AgentWorker(
    { store, llm, services: rt.services },
    {
      silentSignalEveryMs: Number(env.SILENT_SIGNAL_EVERY_MS ?? 60_000),
      reportsEveryMs: Number(env.REPORTS_EVERY_MS ?? 120_000),
      concurrency: Number(env.AGENT_CONCURRENCY ?? 4),
    },
  ).start();
  const caught = await catchUp(worker);
  if (caught) console.log(`[worker] catching up on ${caught} open SOS`);

  const { FirstLineVoiceAssistant, operatorNumbersFromEnv } = await import("./runtime/voiceAssistant.js");
  const assistant = new FirstLineVoiceAssistant(worker.deps, { operatorNumbers: operatorNumbersFromEnv(env) });
  const channels = startChannels(channelStore, rt.twilio, env, assistant);

  // Live feeds: weather alerts -> set_cell_alert for cells with people; road hazards -> reports.
  let poller: { stop(): void } | undefined;
  if (flagOn(env.FEEDS, !!env.TIGER_DATABASE_URL)) {
    const { startPoller } = await import("./feeds/poller.js");
    const alerted = new Map<string, string>();
    poller = startPoller({
      write: env.TIGER_DATABASE_URL ? undefined : async () => 0,
      onFeedEvent: async (e) => {
        rt.roads.ingest(e);
        if (!rt.weather.ingest(e)) return;
        const level = String((e.payload as Record<string, unknown>).event ?? e.kind).slice(0, 100);
        const ours = new Set((await store.listPeople()).map((p) => p.h3Cell));
        for (const cell of e.h3_cells) {
          if (!ours.has(cell) || alerted.get(cell) === level) continue;
          alerted.set(cell, level);
          await store.setCellAlert(cell, level);
        }
      },
    });
  }

  for (const line of [
    ...rt.describe,
    ...channels.describe,
    `feeds: ${poller ? `polling (${env.TIGER_DATABASE_URL ? "writing to Tiger" : "dry, no Tiger"})` : "off (FEEDS=1 to enable)"}`,
  ]) {
    console.log(`[worker] ${line}`);
  }
  console.log("[worker] running; Ctrl+C to stop");

  const shutdown = () => {
    worker.stop();
    poller?.stop();
    channels.stop();
    spacetime?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { worker, store, channels };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
