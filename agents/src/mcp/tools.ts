// The tools FirstLine serves over MCP. They are built with the same defineTool() the agents use,
// and they are read-only: nothing here sends a message, offers a helper or changes a record.
// Those actions stay inside the worker, where each one goes through a reducer with its own checks.

import { z } from "zod";
import { defineTool, type AgentDeps, type Tool } from "../agents/loop.js";
import { profileSummary, ruleTriage } from "../agents/triage.js";
import { cellStats } from "../agents/reports.js";
import { makeLookupProtocolTool } from "../knowledge/harness.js";
import { computePriority } from "../priority.js";
import type { Id } from "../store/types.js";

const personArg = z.object({ person_id: z.coerce.number().int().positive().describe("FirstLine person id") });
const cellArg = z.object({ h3_cell: z.string().min(5).describe("H3 cell id (any resolution the map uses)") });

/** Lanes of the trace, the same ones the dashboard's Trace page draws. */
export type Lane = "resident" | "triage" | "dispatch" | "silent_signal" | "reports" | "tools" | "database" | "people";

export interface TraceEvent {
  at: string;
  from: Lane;
  to: Lane;
  kind: string;
  label: string;
}

const SAVE_TOOLS = /^(save_|set_priority)/;
const CONTACT_TOOLS = /^(request_call|request_visit|offer_|escalate)/;

/** Where an agent's tool call goes: a save hits the database, a call or visit reaches people. */
export function laneForTool(tool: string): Lane {
  if (SAVE_TOOLS.test(tool)) return "database";
  if (CONTACT_TOOLS.test(tool)) return "people";
  return "tools";
}

/** One person's case as a sequence of hops between lanes: who called what, in order. */
export async function caseTrace(deps: AgentDeps, personId: Id): Promise<TraceEvent[]> {
  const { store } = deps;
  const sos = (await store.listOpenSos()).filter((s) => s.personId === personId);
  const subjects = new Set([`person:${personId}`, ...sos.map((s) => `sos:${s.id}`)]);
  const ev: TraceEvent[] = [];
  for (const s of sos) ev.push({ at: s.createdAt.toISOString(), from: "resident", to: "triage", kind: "sos", label: `SOS via ${s.channel}: "${s.message}"` });
  for (const c of await store.listCheckIns(personId))
    ev.push({ at: c.createdAt.toISOString(), from: "resident", to: "database", kind: "check_in", label: `check-in (${c.kind}): ${c.result}` });
  for (const s of sos)
    for (const a of await store.listAssignments(s.id)) {
      const helper = (await store.getPerson(a.helperId))?.name ?? `#${a.helperId}`;
      ev.push({ at: a.offeredAt.toISOString(), from: "dispatch", to: "people", kind: "offer", label: `offered to ${helper} (ring ${a.ring})` });
      if (a.state !== "offered") ev.push({ at: a.offeredAt.toISOString(), from: "people", to: "dispatch", kind: a.state, label: `${helper}: ${a.state.replace("_", " ")}` });
    }
  for (const st of (await store.listAgentSteps()).filter((x) => subjects.has(x.subject))) {
    const agent = st.agent as Lane;
    const at = st.createdAt.toISOString();
    if (st.kind === "tool_call") {
      const name = st.content.split("(")[0]!;
      ev.push({ at, from: agent, to: laneForTool(name), kind: "tool_call", label: st.content });
    } else if (st.kind === "tool_result") {
      const name = st.content.split(" → ")[0]!;
      ev.push({ at, from: laneForTool(name), to: agent, kind: "tool_result", label: st.content });
    } else ev.push({ at, from: agent, to: agent, kind: st.kind, label: st.content });
  }
  return ev.sort((a, b) => a.at.localeCompare(b.at));
}

export function buildMcpTools(deps: AgentDeps): Tool[] {
  const { store, services } = deps;
  const person = async (id: Id) => {
    const p = await store.getPerson(id);
    if (!p) throw new Error(`no person ${id}`);
    return p;
  };
  return [
    makeLookupProtocolTool() as unknown as Tool,
    defineTool({
      name: "get_person_profile",
      description: "A registered person's profile: age, lives alone, mobility, medical needs, powered device, language, status.",
      input: personArg,
      run: async ({ person_id }) => profileSummary(await person(person_id)),
    }),
    defineTool({
      name: "explain_priority",
      description: "The plain-code risk score for a person (vulnerability x exposure x contact gap) with every reason behind it.",
      input: personArg,
      run: async ({ person_id }) => {
        const p = await person(person_id);
        const cell = await store.getCell(p.h3Cell);
        const r = computePriority({ person: p, signals: await store.listSignals(p.id), checkIns: await store.listCheckIns(p.id), weatherAlert: cell?.alertLevel || undefined });
        return { category: r.category, score: r.score, summary: r.summary, vulnerability: r.vulnerability, exposure: r.exposure, contact_gap: r.contactGap };
      },
    }),
    defineTool({
      name: "get_signals",
      description: "Recent phone and home signals for a person (phone_offline, power_out, low_temp °F, no_motion).",
      input: personArg,
      run: async ({ person_id }) => (await store.listSignals(person_id)).map((s) => ({ kind: s.kind, value: s.value, at: s.createdAt })),
    }),
    defineTool({
      name: "get_history",
      description: "A person's contact and sensor timeline from the history database, plus their check-ins.",
      input: personArg,
      run: async ({ person_id }) => ({
        timeline: (await services.history.personTimeline(person_id)).slice(-20),
        check_ins: (await store.listCheckIns(person_id)).map((c) => ({ kind: c.kind, result: c.result, at: c.createdAt })),
      }),
    }),
    defineTool({
      name: "get_case_trace",
      description:
        "Everything that happened on one person's case, in order, as hops between lanes (resident, triage, dispatch, silent_signal, reports, tools, database, people): the SOS, each agent's thoughts, tool calls and results, decisions, helper offers and check-ins.",
      input: personArg,
      run: async ({ person_id }) => ({ person_id, events: await caseTrace(deps, person_id) }),
    }),
    defineTool({
      name: "list_open_sos",
      description: "Open SOS events with their latest triage (priority, urgency, needs, confidence, reason).",
      input: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      run: async ({ limit }) => {
        const out = [];
        for (const s of (await store.listOpenSos()).slice(0, limit)) {
          const t = await store.getTriageForSos(s.id);
          out.push({ sos_id: s.id, person_id: s.personId, channel: s.channel, state: s.state, message: s.message, at: s.createdAt, triage: t ? { priority: t.priority, urgency: t.urgency, needs: t.needs, confidence: t.confidence, reason: t.reason } : null });
        }
        return out;
      },
    }),
    defineTool({
      name: "check_message",
      description: "Run the offline keyword rules on any message (no model): the priority, urgency and danger signs they find. Useful to compare with an agent's triage.",
      input: z.object({ message: z.string().min(1), person_id: z.coerce.number().int().positive().optional() }),
      run: async ({ message, person_id }) => {
        const { whys, ...r } = ruleTriage(message, person_id ? await store.getPerson(person_id) : undefined);
        return { ...r, danger_signs: whys };
      },
    }),
    defineTool({
      name: "get_cell_overview",
      description: "Counts for one neighborhood cell (P1, P2, needs help, unaccounted for, safe), active weather alerts and blocked roads.",
      input: cellArg,
      run: async ({ h3_cell }) => {
        const stats = (await cellStats(deps)).find((c) => c.h3Cell8 === h3_cell);
        return {
          cell: h3_cell,
          counts: stats ? { total: stats.people.length, p1: stats.p1, p2: stats.p2, needs_help: stats.needsHelp, unknown: stats.unknown, safe: stats.safe } : null,
          alerts: await services.weather.alertsForCell(h3_cell),
          blocked_roads: await services.roads.blockedRoads(h3_cell),
        };
      },
    }),
  ];
}
