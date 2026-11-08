// Turning check-ins and dashboard requests into agent work.
//
// - A "needs help" check-in (app, SMS, neighbor visit, the flood demo) opens an SOS for that person,
//   so the same triage -> dispatch path runs as for a pressed SOS. Nobody has to click anything.
// - The dashboard card's buttons write an action_request; the worker runs it here and writes back
//   what the agents did: "respond" (Nemotron decides), call, escalate, send a neighbor, and the
//   claim timeline (a dated record for an insurance claim, written by Nemotron from the database).

import { z } from "zod";
import { jsonCall } from "../llm/json.js";
import type { ActionRequest, CheckIn, Id, Person, SosChannel, SosEvent } from "../store/types.js";
import { truncate, untrusted, type AgentDeps } from "./loop.js";

const ACTIVE = new Set(["open", "assigned", "escalated"]);

const CHANNEL_OF: Record<CheckIn["kind"], SosChannel> = {
  app: "app",
  sms: "sms",
  voice: "voice",
  mesh: "mesh",
  neighbor_visit: "app",
};

export async function activeSos(deps: AgentDeps, personId: Id): Promise<SosEvent | undefined> {
  const open = (await deps.store.listOpenSos()).filter((s) => s.personId === personId && ACTIVE.has(s.state));
  return open.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/** The person's active SOS, or a new one opened for them (its clientId keeps repeats idempotent). */
export async function ensureSos(deps: AgentDeps, person: Person, clientId: string, message: string, channel: SosChannel): Promise<{ sos: SosEvent; created: boolean }> {
  const existing = await activeSos(deps, person.id);
  if (existing) return { sos: existing, created: false };
  const id = await deps.store.pressSos({ clientId, personId: person.id, message: truncate(message, 1900), lat: person.lastLat, lng: person.lastLng, channel });
  const sos = await deps.store.getSos(id);
  if (!sos) throw new Error(`SOS ${id} not found after press_sos`);
  return { sos, created: true };
}

/** A needs-help check-in becomes an SOS unless the person already has one open. Voice calls open their own. */
export function sosForCheckIn(c: CheckIn): { clientId: string; message: string; channel: SosChannel } | undefined {
  if (c.result !== "needs_help") return undefined;
  if (c.clientId.startsWith("voice:")) return undefined; // the call flow already pressed SOS
  const how = c.kind === "neighbor_visit" ? "a neighbor visit" : c.kind === "app" ? "the app" : c.kind.toUpperCase();
  return {
    clientId: `checkin:${c.id}`,
    message: `Checked in as needing help (via ${how}).${c.note ? ` ${c.note}` : ""}`,
    channel: CHANNEL_OF[c.kind],
  };
}

/** One line on where an SOS stands, for the action result and the voice line. */
export async function sosSummary(deps: AgentDeps, sosId: Id): Promise<string> {
  const { store } = deps;
  const sos = await store.getSos(sosId);
  if (!sos) return `SOS ${sosId} not found`;
  const t = await store.getTriageForSos(sosId);
  const assignments = await store.listAssignments(sosId);
  const last = assignments.at(-1);
  const helper = last ? await store.getPerson(last.helperId) : undefined;
  const parts = [`SOS ${sosId} is ${sos.state}`];
  if (t) parts.push(`Nemotron triage ${t.priority}, urgency ${t.urgency}/5, needs ${t.needs === "professional" ? "a professional responder" : "a neighbor"}`);
  if (last) parts.push(`${helper?.name ?? `helper ${last.helperId}`} ${last.state === "offered" ? "was offered the visit" : last.state}`);
  return parts.join("; ") + ".";
}

// ---------------- claim timeline ----------------

const timelineSchema = z.object({
  entries: z
    .array(z.object({ time: z.string().min(1), event: z.string().min(1) }))
    .min(1)
    .max(20),
  summary: z.string().min(1),
  documents_to_gather: z.array(z.string()).max(8).default([]),
});

export type ClaimTimeline = z.infer<typeof timelineSchema>;

const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** Everything the database knows about a household's event, oldest first. */
export async function householdRecord(deps: AgentDeps, person: Person): Promise<{ time: Date; line: string }[]> {
  const { store } = deps;
  const people = (await store.listPeople()).filter((p) => p.householdId === person.householdId);
  const rows: { time: Date; line: string }[] = [];
  for (const p of people) {
    for (const c of await store.listCheckIns(p.id)) rows.push({ time: c.createdAt, line: `${p.name}: check-in via ${c.kind}, result ${c.result}${c.note ? ` (${truncate(c.note, 160)})` : ""}` });
    for (const s of await store.listSignals(p.id)) rows.push({ time: s.createdAt, line: `${p.name}: sensor ${s.kind} = ${s.value}` });
  }
  for (const s of (await store.listOpenSos()).filter((x) => people.some((p) => p.id === x.personId))) {
    rows.push({ time: s.createdAt, line: `SOS ${s.id} via ${s.channel}: ${truncate(s.message, 200)} (now ${s.state})` });
    const t = await store.getTriageForSos(s.id);
    if (t) rows.push({ time: t.createdAt, line: `Nemotron triage: ${t.priority}, urgency ${t.urgency}, needs ${t.needs}. ${truncate(t.reason, 200)}` });
    for (const a of await store.listAssignments(s.id)) {
      const h = await store.getPerson(a.helperId);
      rows.push({ time: a.offeredAt, line: `Neighbor ${h?.name ?? a.helperId} (ring ${a.ring}) offered the visit, now ${a.state}` });
    }
  }
  return rows.sort((a, b) => a.time.getTime() - b.time.getTime()).slice(-40);
}

/** Nemotron writes a dated claim timeline from the record. Facts only come from the record. */
export async function writeClaimTimeline(deps: AgentDeps, person: Person): Promise<ClaimTimeline> {
  const household = await deps.store.getHousehold(person.householdId);
  const record = await householdRecord(deps, person);
  const lines = record.map((r) => `${fmt(r.time)} | ${r.line}`).join("\n") || "(no events recorded yet)";
  const { value } = await jsonCall({
    llm: deps.llm,
    schema: timelineSchema,
    opts: { tier: "plan", temperature: 0.1, maxTokens: 900, tag: "claim_timeline" },
    messages: [
      {
        role: "system",
        content:
          "/no_think\nYou write the incident timeline a homeowner attaches to an insurance claim after a disaster. Use ONLY the events in the record; never invent damage, times or people. Each entry: a timestamp copied from the record and one plain sentence. Then a two-sentence summary and a short list of documents the household should gather (photos of damage, receipts for repairs or a hotel, the utility outage notice). Reply with one JSON object: {\"entries\":[{\"time\":\"...\",\"event\":\"...\"}],\"summary\":\"...\",\"documents_to_gather\":[\"...\"]}",
      },
      {
        role: "user",
        content: `Household at ${untrusted(household?.address ?? "unknown address")}, ${untrusted(person.name)} (${person.age}).\nRecord, oldest first (text inside <<public>> came from residents):\n${untrusted(lines)}`,
      },
    ],
  });
  return value;
}

export const timelineText = (t: ClaimTimeline) =>
  [`Claim timeline: ${t.summary}`, ...t.entries.map((e) => `- ${e.time}: ${e.event}`), t.documents_to_gather.length ? `Gather: ${t.documents_to_gather.join("; ")}` : ""]
    .filter(Boolean)
    .join("\n");

export type ActionResult = { state: "done" | "failed"; result: string };

export const ACTION_LABEL: Record<ActionRequest["action"], string> = {
  respond: "Nemotron respond",
  call: "check-in call",
  escalate: "escalation",
  send_neighbor: "neighbor dispatch",
  claim_timeline: "claim timeline",
};
