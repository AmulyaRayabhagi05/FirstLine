// FirstLine agent worker: wires store subscriptions to the Nemotron agents.
//   new SOS            -> triage -> dispatch
//   offer timed out    -> dispatch (replan)
//   offer declined     -> dispatch (replan)
//   every N seconds    -> silent-signal sweep, reports sweep
//
// Run with `npm start`. With SPACETIME_DB_NAME set it runs on SpacetimeDB (store/spacetime.ts),
// otherwise on the InMemoryStore. SMS/voice, mesh, Tiger and live feeds start when their env is set.

import { pathToFileURL } from "node:url";
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
import type { FirstLineStore, Id, Unsubscribe } from "./store/types.js";

export * from "./store/types.js";
export { InMemoryStore } from "./store/memory.js";
export * from "./priority.js";
export * from "./agents/index.js";
export * from "./llm/index.js";

export interface WorkerOptions {
  silentSignalEveryMs?: number;
  reportsEveryMs?: number;
  onError?: (where: string, err: unknown) => void;
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

  constructor(
    readonly deps: AgentDeps,
    private readonly opts: WorkerOptions = {},
  ) {
    this.silentSignal = new SilentSignalAgent(deps);
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
    const next = prev.then(work, work);
    this.sosChains.set(sosId, next.catch(() => undefined));
    return this.track(next);
  }

  async handleSos(sosId: Id): Promise<void> {
    await this.onSos(sosId, async () => {
      const sos = await this.deps.store.getSos(sosId);
      if (!sos) return;
      this.triaged.push(await runTriage(this.deps, sos));
      this.dispatched.push(await runDispatch(this.deps, sosId, { kind: "new_sos" }));
    });
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
    );
    const ss = this.opts.silentSignalEveryMs ?? 60_000;
    const rp = this.opts.reportsEveryMs ?? 120_000;
    if (ss > 0) this.timers.push(setInterval(() => void this.track(this.silentSignal.sweep()), ss));
    if (rp > 0) this.timers.push(setInterval(() => void this.track(runReportsSweep(this.deps)), rp));
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
    },
  ).start();
  const caught = await catchUp(worker);
  if (caught) console.log(`[worker] catching up on ${caught} open SOS`);

  const channels = startChannels(channelStore, rt.twilio, env);

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
