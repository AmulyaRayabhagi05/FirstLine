// Dispatch agent: decides neighbor vs professional for an SOS, picks a helper from the
// person's safety net by ring, skills and distance, and replans when an offer is declined
// or times out (next helper in the ring, then the next ring, then escalate).

import { z } from "zod";
import type { Assignment, Id, Person, SafetyNetMember, SosEvent, Triage } from "../store/types.js";
import { called, defineTool, runAgentLoop, stepLogger, untrusted, type AgentDeps } from "./loop.js";

export type DispatchTrigger =
  | { kind: "new_sos" }
  | { kind: "timeout"; assignment: Assignment }
  | { kind: "declined"; assignment: Assignment };

export interface Candidate {
  helper_id: Id;
  name: string;
  ring: number;
  skills: string[];
  skill_match: string[];
  distance_km: number;
}

export interface DispatchOutcome {
  sosId: Id;
  escalated: boolean;
  assignmentId?: Id;
  helperId?: Id;
  ring?: number;
  source: "model" | "rules" | "skipped";
  note: string;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Skills that help with this SOS, from its text and triage reason. */
export function wantedSkills(text: string): string[] {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const out = new Set<string>();
  if (/(water|agua|flood|inunda|nuoc|river|rio)/.test(t)) out.add("boat").add("truck");
  if (/(walk|caminar|wheelchair|silla|carry|lift|mobility)/.test(t)) out.add("truck");
  if (/(power|luz|electric|oxygen|oxigeno|cold|frio|heat|calor)/.test(t)) out.add("generator");
  if (/(medical|medic|insulin|insulina|injur|herid|bleed|sangr|oxygen|oxigeno)/.test(t)) out.add("medical");
  return [...out];
}

/** Untried helpers from the owner's net, best first: ring, then skill match, then distance. */
export function rankCandidates(
  net: SafetyNetMember[],
  helpers: Map<Id, Person>,
  sos: SosEvent,
  tried: Set<Id>,
  wanted: string[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const m of net) {
    const h = helpers.get(m.memberId);
    if (!h || tried.has(h.id) || h.id === sos.personId || h.status === "needs_help") continue;
    const skills = m.skills
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    out.push({
      helper_id: h.id,
      name: h.name,
      ring: m.ring,
      skills,
      skill_match: skills.filter((s) => wanted.includes(s)),
      distance_km: Math.round(haversineKm(sos.lat, sos.lng, h.lastLat, h.lastLng) * 100) / 100,
    });
  }
  return out.sort((a, b) => a.ring - b.ring || b.skill_match.length - a.skill_match.length || a.distance_km - b.distance_km);
}

const INSTRUCTIONS = `You are the DISPATCH agent for FirstLine, a disaster-response network of neighbors.
For one SOS you decide who goes. Rules:
- If triage says needs=professional or priority P1, call escalate (professional responders), AND still offer the job to the best neighbor so someone nearby can help until they arrive.
- Otherwise offer it to one neighbor with assign_helper.
- Pick helpers with list_helpers: lower ring first (1 = chosen by the person, 2 = next block, 3 = wider), then useful skills (boat/truck for water, generator for power, medical), then distance.
- When an offer timed out or was declined, replan: offer to the next helper in the same ring, then the next ring. list_helpers already skips helpers who were tried. If it returns nobody, escalate.
- helper_id must be a number taken from list_helpers; never invent one.
- Offer to one helper at a time. Never offer to someone not returned by list_helpers.
- The person who sent the SOS is never their own helper; only use helper_id values listed under "Available helpers" or returned by list_helpers.
- An offer is not an acceptance. After assign_helper, say the helper was offered the request and is waiting to answer, never that they accepted.
Then set done=true with a one-sentence decision.`;

export async function runDispatch(deps: AgentDeps, sosId: Id, trigger: DispatchTrigger): Promise<DispatchOutcome> {
  const { store } = deps;
  const subject = `sos:${sosId}`;
  const log = stepLogger(store, "dispatch", subject);

  const sos = await store.getSos(sosId);
  if (!sos) throw new Error(`no sos ${sosId}`);
  const before = await store.listAssignments(sosId);
  if (sos.state === "resolved" || before.some((a) => a.state === "accepted")) {
    await log("decision", `No dispatch needed: SOS is ${sos.state === "resolved" ? "resolved" : "already accepted by a helper"}.`);
    return { sosId, escalated: sos.state === "escalated", source: "skipped", note: "nothing to do" };
  }
  if (trigger.kind === "new_sos" && before.some((a) => a.state === "offered")) {
    return { sosId, escalated: sos.state === "escalated", source: "skipped", note: "offer already pending" };
  }

  const triage = await store.getTriageForSos(sosId);
  const person = await store.getPerson(sos.personId);
  const net = await store.getSafetyNet(sos.personId);
  const helpers = new Map<Id, Person>();
  for (const m of net) {
    const h = await store.getPerson(m.memberId);
    if (h) helpers.set(h.id, h);
  }
  const wanted = wantedSkills(`${sos.message} ${triage?.reason ?? ""} ${person?.medicalNeeds ?? ""}`);

  const tried = async () => new Set((await store.listAssignments(sosId)).map((a) => a.helperId));
  const candidates = async () => rankCandidates(net, helpers, sos, await tried(), wanted);
  let escalated = sos.state === "escalated";
  let assigned: { assignmentId: Id; helperId: Id; ring: number } | undefined;

  const doEscalate = async (reason: string) => {
    if (escalated) return { already_escalated: true };
    await store.escalate(sosId, reason);
    escalated = true;
    return { escalated: true };
  };
  const doAssign = async (helperId: Id) => {
    if (assigned) return { error: "already offered this round; finish now" };
    const c = (await candidates()).find((x) => x.helper_id === helperId);
    if (!c) return { error: `helper ${helperId} is not an available candidate; call list_helpers` };
    const assignmentId = await store.assignHelper(sosId, helperId, c.ring);
    assigned = { assignmentId, helperId, ring: c.ring };
    // Tell the helper by SMS (Twilio when configured, a logging stub otherwise).
    let texted = false;
    const phone = helpers.get(helperId)?.phone;
    if (phone) {
      try {
        await deps.services.comms.sendSms(
          phone,
          `FirstLine: ${person?.name ?? "a neighbor"} needs help ${c.distance_km} km from you: "${sos.message}". Open FirstLine to accept (offer expires in 10 min).`.slice(0, 320),
        );
        texted = true;
      } catch (err) {
        await log("thought", `Could not text ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // And ring them: a call reaches phones where unregistered SMS is blocked, and they accept with a key.
    let called = false;
    if (phone && deps.services.comms.offerCall) {
      try {
        await deps.services.comms.offerCall({
          assignmentId,
          phone,
          helperName: c.name,
          personName: person?.name ?? "a neighbor",
          distanceKm: c.distance_km,
          message: sos.message,
        });
        called = true;
        await log("tool_result", `Calling ${c.name} with the offer (press 1 to accept, 2 to decline)`);
      } catch (err) {
        await log("thought", `Could not call ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { assignment_id: assignmentId, helper: c.name, ring: c.ring, texted, called, note: "offered; times out if not answered" };
  };

  const tools = [
    defineTool({
      name: "list_helpers",
      description: "Untried helpers from this person's safety net, best first. Optional ring filter.",
      input: z.object({ ring: z.coerce.number().int().min(1).max(3).optional() }).passthrough(),
      run: async ({ ring }) => {
        const all = await candidates();
        const list = ring ? all.filter((c) => c.ring === ring) : all;
        return { wanted_skills: wanted, helpers: list };
      },
    }),
    defineTool({
      name: "assign_helper",
      description: "Offer this SOS to one helper (from list_helpers).",
      input: z.object({ helper_id: z.coerce.number().int(), reason: z.string().optional() }),
      run: async ({ helper_id }) => doAssign(helper_id),
    }),
    defineTool({
      name: "escalate",
      description: "Send this SOS to professional responders (EMS, fire, rescue).",
      input: z.object({ reason: z.string().min(3) }),
      run: async ({ reason }) => doEscalate(reason),
    }),
  ];

  const history = before.map((a) => `helper ${a.helperId} (ring ${a.ring}): ${a.state}`).join("; ") || "none";
  const event =
    trigger.kind === "new_sos"
      ? "New SOS, nobody offered yet."
      : `REPLAN: the offer to helper ${trigger.assignment.helperId} (ring ${trigger.assignment.ring}) ${trigger.kind === "timeout" ? "timed out without an answer" : "was declined"}. Call list_helpers with NO ring filter (it already skips everyone tried, best first) and offer to the first helper it returns, whatever their ring.`;
  const pool = await candidates();
  const helperLines = pool.length
    ? pool
        .slice(0, 5)
        .map((c) => `helper_id ${c.helper_id}: ${untrusted(c.name)}, ring ${c.ring}, skills ${c.skills.join("/") || "none"}, ${c.distance_km} km`)
        .join("; ")
    : "none (escalate instead of offering)";
  const task = [
    `SOS #${sosId} from ${untrusted(person?.name ?? `person ${sos.personId}`)} (person ${sos.personId}, age ${person?.age ?? "?"}, mobility ${person?.mobility ?? "?"}): ${untrusted(sos.message)}`,
    `Person ${sos.personId} is the one who needs help and is never a helper.`,
    `Available helpers, best first: ${helperLines}.`,
    triage
      ? `Triage: ${triage.priority}, urgency ${triage.urgency}, needs ${triage.needs}, confidence ${triage.confidence}. ${untrusted(triage.reason)}`
      : "Triage: not available.",
    `SOS state: ${sos.state}. Previous offers: ${history}.`,
    event,
  ].join("\n");

  const required = [
    ...(mustEscalate(triage) && !escalated ? ["escalate"] : []),
    ...((await candidates()).length > 0 ? ["assign_helper"] : []),
  ];
  const result = await runAgentLoop({
    agent: "dispatch",
    subject,
    deps,
    instructions: INSTRUCTIONS,
    task,
    tools,
    tier: "plan",
    requiredTools: required,
  });
  let source: DispatchOutcome["source"] = "model";

  // Guards: the plan must end with professionals called when needed and someone offered.
  if (mustEscalate(triage) && !escalated) {
    source = "rules";
    await doEscalate(`P1/professional: ${triage?.reason ?? "triage"}`);
    await log("decision", "Guard: triage needs professionals, escalated.");
  }
  if (!assigned) {
    const next = (await candidates())[0];
    if (next) {
      source = "rules";
      await doAssign(next.helper_id);
      await log("decision", `Guard: offered to ${next.name} (ring ${next.ring}, ${next.distance_km} km).`);
    } else if (!escalated) {
      source = "rules";
      await doEscalate("No helpers left in the safety net.");
      await log("decision", "Guard: no helpers left, escalated.");
    } else if (!called(result, "escalate")) {
      await log("decision", "No helpers left in the safety net; waiting on professional responders.");
    }
  }
  if (!result.finished && source === "model") source = "rules";

  const final = assigned as { assignmentId: Id; helperId: Id; ring: number } | undefined;
  return {
    sosId,
    escalated,
    assignmentId: final?.assignmentId,
    helperId: final?.helperId,
    ring: final?.ring,
    source,
    note: result.decision ?? "",
  };
}

const mustEscalate = (t: Triage | undefined) => !!t && (t.priority === "P1" || t.needs === "professional");
