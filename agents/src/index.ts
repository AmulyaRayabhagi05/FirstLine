// FirstLine agent worker: wires store subscriptions to the Nemotron agents.
//   new SOS            -> triage -> dispatch
//   offer timed out    -> dispatch (replan)
//   offer declined     -> dispatch (replan)
//   every N seconds    -> silent-signal sweep, reports sweep
//
// Run with `npm start`. Until the SpacetimeDB adapter is wired at integration this runs on
// the InMemoryStore with stub services (it then just waits for events).

import { pathToFileURL } from "node:url";
import { runDispatch, type DispatchOutcome, type DispatchTrigger } from "./agents/dispatch.js";
import type { AgentDeps } from "./agents/loop.js";
import { runReportsSweep } from "./agents/reports.js";
import { stubServices } from "./agents/services.js";
import { SilentSignalAgent } from "./agents/silentSignal.js";
import { runTriage, type TriageOutcome } from "./agents/triage.js";
import { OpenAICompatClient, llmConfigFromEnv } from "./llm/client.js";
import { loadEnvFile } from "./llm/env.js";
import { InMemoryStore } from "./store/memory.js";
import type { Id, Unsubscribe } from "./store/types.js";

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

async function main() {
  loadEnvFile();
  const llm = new OpenAICompatClient(llmConfigFromEnv());
  const store = new InMemoryStore();
  const worker = new AgentWorker({ store, llm, services: stubServices() }).start();
  // The in-memory store has no scheduler; simulate the module's 10-minute timeout.
  const tick = setInterval(() => store.tick(), 15_000);
  console.log("[worker] running on InMemoryStore with stub services; Ctrl+C to stop");
  process.on("SIGINT", () => {
    clearInterval(tick);
    worker.stop();
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
