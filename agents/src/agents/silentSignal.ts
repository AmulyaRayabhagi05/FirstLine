// Silent-signal agent: finds people who have NOT asked for help but probably need it.
// Plain code scores every unknown person (priority.ts); the model reviews the top ones with
// signals and history, and when it is not confident it asks a human: a call or a visit.

import { z } from "zod";
import { computePriority, type PriorityResult } from "../priority.js";
import type { Id, Person } from "../store/types.js";
import { called, confidence as confidenceSchema, defineTool, runAgentLoop, stepLogger, untrusted, type AgentDeps } from "./loop.js";

/** Below this confidence the agent must ask a human (call or visit). */
export const ASK_HUMAN_BELOW = 0.7;

export interface SilentSignalOptions {
  /** How many top-scored people the model reviews per sweep. */
  maxReviews?: number;
  /** Don't re-request contact for the same person within this window. */
  cooldownMs?: number;
}

export interface SilentSignalFinding {
  personId: Id;
  score: number;
  category: string;
  reasons: string[];
  requested?: "call" | "visit";
  confidence?: number;
  source: "model" | "rules";
}

export class SilentSignalAgent {
  /** personId -> when we last asked a human to make contact. */
  readonly lastAsked = new Map<Id, number>();
  private readonly maxReviews: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly deps: AgentDeps,
    opts: SilentSignalOptions = {},
  ) {
    this.maxReviews = opts.maxReviews ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30 * 60 * 1000;
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  async score(person: Person): Promise<PriorityResult> {
    const { store, services } = this.deps;
    const cell = await store.getCell(person.h3Cell);
    const alerts = await services.weather.alertsForCell(person.h3Cell);
    return computePriority({
      person,
      signals: await store.listSignals(person.id),
      checkIns: await store.listCheckIns(person.id),
      weatherAlert: cell?.alertLevel || alerts[0]?.headline || undefined,
      now: this.now(),
    });
  }

  async sweep(): Promise<SilentSignalFinding[]> {
    const { store } = this.deps;
    const scored: { person: Person; pr: PriorityResult }[] = [];
    for (const person of await store.listUnknownPeople()) {
      const pr = await this.score(person);
      if (pr.category !== person.priority || Math.abs(pr.score - person.priorityScore) > 0.01) {
        await store.setPriority(person.id, pr.category, pr.score);
      }
      scored.push({ person, pr });
    }
    const now = this.now().getTime();
    const review = scored
      .filter(({ pr }) => pr.category === "P2")
      .filter(({ person }) => now - (this.lastAsked.get(person.id) ?? -Infinity) >= this.cooldownMs)
      .sort((a, b) => b.pr.score - a.pr.score)
      .slice(0, this.maxReviews);

    const findings: SilentSignalFinding[] = [];
    for (const { person, pr } of review) findings.push(await this.review(person, pr));
    return findings;
  }

  async review(person: Person, pr: PriorityResult): Promise<SilentSignalFinding> {
    const { store, services } = this.deps;
    const subject = `person:${person.id}`;
    const log = stepLogger(store, "silent_signal", subject);
    let requested: "call" | "visit" | undefined;

    const requestCall = async (reason: string) => {
      if (requested) return { already_requested: requested };
      if (!person.phone) return { error: "no phone number on file; use request_visit" };
      const r = await services.comms.requestCall({ personId: person.id, phone: person.phone, reason, language: person.language });
      requested = "call";
      this.lastAsked.set(person.id, this.now().getTime());
      return { call_request_id: r.id };
    };
    const requestVisit = async (reason: string, helperId?: Id) => {
      if (requested) return { already_requested: requested };
      // The model may only route a visit to someone in this person's own safety net; otherwise a
      // crafted name or note could make the worker text any registered phone.
      if (helperId !== undefined && !(await store.getSafetyNet(person.id)).some((m) => m.memberId === helperId)) {
        return { error: `helper ${helperId} is not in this person's safety net; omit helper_id` };
      }
      const r =await services.comms.requestVisit({ personId: person.id, helperId, reason });
      requested = "visit";
      this.lastAsked.set(person.id, this.now().getTime());
      return { visit_request_id: r.id };
    };

    const tools = [
      defineTool({
        name: "get_signals",
        description: "Recent sensor and phone signals for this person (phone_offline, power_out, low_temp °F, no_motion).",
        input: z.object({}).passthrough(),
        run: async () =>
          (await store.listSignals(person.id)).map((s) => ({ kind: s.kind, value: s.value, at: s.createdAt.toISOString() })),
      }),
      defineTool({
        name: "get_history",
        description: "Contact and sensor timeline from the history database, plus past check-ins.",
        input: z.object({}).passthrough(),
        run: async () => ({
          timeline: (await services.history.personTimeline(person.id)).slice(-10),
          check_ins: (await store.listCheckIns(person.id)).map((c) => ({ kind: c.kind, result: c.result, at: c.createdAt.toISOString() })),
          last_seen: person.lastSeen?.toISOString() ?? "never",
        }),
      }),
      defineTool({
        name: "request_call",
        description: "Ask for an automated or volunteer phone call to this person in their language.",
        input: z.object({ reason: z.string().min(3) }),
        run: async ({ reason }) => requestCall(reason),
      }),
      defineTool({
        name: "request_visit",
        description: "Ask a nearby neighbor to knock on the door. Use when there is no working phone.",
        input: z.object({ reason: z.string().min(3), helper_id: z.coerce.number().int().optional() }),
        run: async ({ reason, helper_id }) => requestVisit(reason, helper_id),
      }),
      defineTool({
        name: "set_priority",
        description: "Change this person's priority if the score is wrong (P2 serious, P3 minor, unknown).",
        input: z.object({ priority: z.enum(["P2", "P3", "unknown"]), reason: z.string().min(3), confidence: confidenceSchema.optional() }),
        run: async ({ priority }) => {
          await store.setPriority(person.id, priority, pr.score);
          return { priority };
        },
      }),
    ];

    const instructions = `You are the SILENT-SIGNAL agent for FirstLine, a disaster-response network of neighbors.
You review one person who has NOT sent an SOS but whose risk score is high. Decide whether they are likely in danger.
Use get_signals and get_history. If you are not confident (confidence below ${ASK_HUMAN_BELOW}) you MUST ask a human to check:
request_call if they have a phone, request_visit if there is no working phone. Set done=true with a one-sentence decision and your confidence.`;
    const task = [
      `Person ${person.id}: ${untrusted(person.name)}, age ${person.age}, lives alone: ${person.livesAlone}, mobility: ${person.mobility}, medical: ${untrusted(person.medicalNeeds || "none")}, language: ${untrusted(person.language)}, phone: ${person.phone ? "yes" : "none"}.`,
      `Risk score ${pr.score} (vulnerability ${pr.vulnerability.value} x exposure ${pr.exposure.value} x contact gap ${pr.contactGap.value}) => ${pr.category}.`,
      `Reasons: ${pr.reasons.join("; ")}.`,
    ].join("\n");

    await log("thought", `Flagged by score: ${pr.summary}`);
    const result = await runAgentLoop({ agent: "silent_signal", subject, deps: this.deps, instructions, task, tools });
    const conf = result.confidence;
    let source: SilentSignalFinding["source"] = result.finished ? "model" : "rules";

    if (!requested && (conf === undefined || conf < ASK_HUMAN_BELOW)) {
      source = "rules";
      const reason = `Possible silent emergency: ${pr.reasons.slice(0, 4).join(", ")}`;
      if (person.phone) await requestCall(reason);
      else await requestVisit(reason);
      await log("decision", `Guard: confidence ${conf ?? "n/a"} is low, asked a human (${requested}).`, conf);
    }
    const category = called(result, "set_priority") ? ((await store.getPerson(person.id))?.priority ?? pr.category) : pr.category;
    return { personId: person.id, score: pr.score, category, reasons: pr.reasons, requested, confidence: conf, source };
  }
}
