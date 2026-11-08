// Reports agent: one briefing per H3 res-8 cell for responders (counts, worst cases,
// blocked roads, weather), saved with save_incident_report.

import { cellToParent } from "h3-js";
import { z } from "zod";
import type { Id, Person } from "../store/types.js";
import { defineTool, runAgentLoop, stepLogger, type AgentDeps } from "./loop.js";

export const REPORT_RES = 8;

export interface CellStats {
  h3Cell8: string;
  people: Person[];
  p1: number;
  p2: number;
  unknown: number;
  needsHelp: number;
  safe: number;
}

export async function cellStats(deps: AgentDeps): Promise<CellStats[]> {
  const byCell = new Map<string, Person[]>();
  for (const p of await deps.store.listPeople()) {
    let c8: string;
    try {
      c8 = cellToParent(p.h3Cell, REPORT_RES);
    } catch {
      continue;
    }
    byCell.set(c8, [...(byCell.get(c8) ?? []), p]);
  }
  return [...byCell.entries()].map(([h3Cell8, people]) => ({
    h3Cell8,
    people,
    p1: people.filter((p) => p.priority === "P1" && p.status !== "safe").length,
    p2: people.filter((p) => p.priority === "P2" && p.status !== "safe").length,
    unknown: people.filter((p) => p.status === "unknown").length,
    needsHelp: people.filter((p) => p.status === "needs_help").length,
    safe: people.filter((p) => p.status === "safe").length,
  }));
}

export interface ReportOutcome {
  h3Cell8: string;
  reportId: Id;
  summary: string;
  source: "model" | "rules";
}

const INSTRUCTIONS = `You are the REPORTS agent for FirstLine, a disaster-response network of neighbors.
Write a short briefing (2-4 sentences, plain English) for professional responders about one neighborhood cell:
how many people need help or are unaccounted for, the most urgent cases and why, blocked roads, weather.
Call get_cell_overview first, then get_blocked_roads and get_weather, then save_incident_report, then done=true.`;

export async function runCellReport(deps: AgentDeps, stats: CellStats): Promise<ReportOutcome> {
  const { store, services } = deps;
  const subject = `cell:${stats.h3Cell8}`;
  const log = stepLogger(store, "reports", subject);
  let saved: ReportOutcome | undefined;
  let roads: string[] | undefined;

  const getRoads = async () => (roads ??= await services.roads.blockedRoads(stats.h3Cell8));
  const save = async (summary: string, blockedRoads: string, source: ReportOutcome["source"]) => {
    const reportId = await store.saveIncidentReport({
      h3Cell: stats.h3Cell8,
      summary,
      blockedRoads,
      p1: stats.p1,
      p2: stats.p2,
      unknown: stats.unknown,
    });
    saved = { h3Cell8: stats.h3Cell8, reportId, summary, source };
    return { report_id: reportId };
  };

  const overview = async () => {
    const urgent = [];
    for (const p of stats.people.filter((x) => x.status !== "safe" && (x.priority === "P1" || x.priority === "P2"))) {
      const sos = (await store.listOpenSos()).find((s) => s.personId === p.id);
      const triage = sos ? await store.getTriageForSos(sos.id) : undefined;
      urgent.push({
        person_id: p.id,
        name: p.name,
        age: p.age,
        priority: p.priority,
        score: p.priorityScore,
        sos: sos ? { id: sos.id, state: sos.state, message: sos.message } : null,
        triage_reason: triage?.reason ?? null,
      });
    }
    urgent.sort((a, b) => (a.priority === b.priority ? b.score - a.score : a.priority === "P1" ? -1 : 1));
    return {
      cell: stats.h3Cell8,
      total: stats.people.length,
      p1: stats.p1,
      p2: stats.p2,
      needs_help: stats.needsHelp,
      unknown: stats.unknown,
      safe: stats.safe,
      urgent: urgent.slice(0, 6),
    };
  };

  const tools = [
    defineTool({
      name: "get_cell_overview",
      description: "Counts and the most urgent people in this cell.",
      input: z.object({}).passthrough(),
      run: overview,
    }),
    defineTool({
      name: "get_blocked_roads",
      description: "Blocked or flooded roads in this cell.",
      input: z.object({}).passthrough(),
      run: async () => ({ blocked_roads: await getRoads() }),
    }),
    defineTool({
      name: "get_weather",
      description: "Active weather alerts for this area.",
      input: z.object({}).passthrough(),
      run: async () => ({ alerts: await services.weather.alertsForCell(stats.h3Cell8) }),
    }),
    defineTool({
      name: "save_incident_report",
      description: "Save the briefing. Call exactly once.",
      input: z.object({ summary: z.string().min(10), blocked_roads: z.string().optional() }),
      run: async ({ summary, blocked_roads }) =>
        saved ? { already_saved: true } : save(summary, blocked_roads ?? (await getRoads()).join(", "), "model"),
    }),
  ];

  await runAgentLoop({
    agent: "reports",
    subject,
    deps,
    instructions: INSTRUCTIONS,
    task: `Write the briefing for res-8 cell ${stats.h3Cell8}.`,
    tools,
    requiredTools: ["save_incident_report"],
  });

  if (!saved) {
    const o = await overview();
    const worst = o.urgent
      .slice(0, 3)
      .map((u) => `${u.name} (${u.age}, ${u.priority}${u.triage_reason ? `: ${u.triage_reason}` : ""})`)
      .join("; ");
    const r = await getRoads();
    const summary =
      `${o.p1} P1, ${o.p2} P2, ${o.needs_help} need help, ${o.unknown} unaccounted for, ${o.safe} safe of ${o.total}.` +
      (worst ? ` Most urgent: ${worst}.` : "") +
      (r.length ? ` Blocked: ${r.join(", ")}.` : "");
    await save(summary, r.join(", "), "rules");
    await log("decision", `Fallback briefing saved: ${summary}`);
  }
  return saved as unknown as ReportOutcome;
}

/** Briefings for every res-8 cell with anyone not marked safe. */
// What each cell's last report was written from. A cell is rewritten only when its counts or
// blocked roads change, or its report is over 30 minutes old. (Rewriting every cell every two
// minutes was 70% of all agent steps, with near-identical reports.)
const lastWritten = new Map<string, { key: string; at: number }>();
const REFRESH_MS = 30 * 60 * 1000;

export async function runReportsSweep(deps: AgentDeps, opts: { force?: boolean } = {}): Promise<ReportOutcome[]> {
  const out: ReportOutcome[] = [];
  const now = (deps.now ?? (() => new Date()))().getTime();
  for (const stats of await cellStats(deps)) {
    if (stats.p1 + stats.p2 + stats.needsHelp + stats.unknown === 0) continue;
    const roads = await deps.services.roads.blockedRoads(stats.h3Cell8).catch(() => [] as string[]);
    const key = [stats.p1, stats.p2, stats.needsHelp, stats.unknown, stats.safe, [...roads].sort().join(";")].join("|");
    const prev = lastWritten.get(stats.h3Cell8);
    if (!opts.force && prev && prev.key === key && now - prev.at < REFRESH_MS) continue;
    out.push(await runCellReport(deps, stats));
    lastWritten.set(stats.h3Cell8, { key, at: now });
  }
  return out;
}

/** Tests: forget what was written. */
export const resetReportMemory = () => lastWritten.clear();
