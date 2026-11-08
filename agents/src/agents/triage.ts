// Triage agent: reads an SOS in any language and decides urgency, who is needed and the
// priority, then saves it with save_triage. Falls back to keyword rules if the model is down.

import { z } from "zod";
import { computePriority } from "../priority.js";
import type { Id, Needs, Person, Priority, SosEvent } from "../store/types.js";
import { called, confidence, defineTool, runAgentLoop, stepLogger, type AgentDeps } from "./loop.js";

export interface TriageOutcome {
  sosId: Id;
  personId: Id;
  triageId: Id;
  urgency: number;
  needs: Needs;
  priority: Priority;
  reason: string;
  confidence: number;
  source: "model" | "rules";
}

const saveTriageInput = z.object({
  urgency: z.coerce.number().int().min(1).max(5),
  needs: z.enum(["neighbor", "professional"]),
  priority: z.enum(["P1", "P2", "P3"]),
  reason: z.string().min(3),
  confidence,
});

const INSTRUCTIONS = `You are the TRIAGE agent for Porchlight, a disaster-response network of neighbors.
You read one SOS message (any language: Spanish, Vietnamese, English, ...) and decide:
- urgency 1-5 (5 = life threat right now)
- needs: "professional" (EMS, fire, swift-water rescue, medical) or "neighbor" (a nearby person with a truck, boat, generator or supplies can handle it)
- priority: "P1" life threat now, "P2" serious and getting worse, "P3" supplies or a ride
- reason: one short English sentence a dispatcher can read (translate the key facts)
- confidence 0..1
Rising water, someone who cannot walk, oxygen or powered medical devices without power, chest pain, fire or injury push toward P1 and professional.
Steps: first call get_person_profile, then optionally get_weather, then call save_triage, then set done=true.`;

export const profileSummary = (p: Person) => ({
  person_id: p.id,
  name: p.name,
  age: p.age,
  lives_alone: p.livesAlone,
  mobility: p.mobility,
  medical_needs: p.medicalNeeds || "none",
  powered_device: p.poweredDevice,
  language: p.language,
  status: p.status,
});

// Lowercased, accent-stripped keyword rules for the offline fallback.
const RULES: { re: RegExp; urgency: number; needs: Needs; why: string }[] = [
  { re: /(no respira|not breathing|unconscious|inconsciente|chest pain|dolor de pecho|bleed|sangr|fire|fuego|incendio|heart|corazon)/, urgency: 5, needs: "professional", why: "possible medical emergency or fire" },
  { re: /(water (is )?(coming|rising)|agua (entrando|subiendo)|flood|inunda|nuoc|swept|atrapad|trapped)/, urgency: 5, needs: "professional", why: "rising water / trapped" },
  { re: /(oxygen|oxigeno|ventilator|dialysis|dialisis|insulin|insulina)/, urgency: 4, needs: "professional", why: "medical device or medication at risk" },
  { re: /(can'?t walk|cannot walk|no puede caminar|wheelchair|silla de ruedas|bedridden)/, urgency: 4, needs: "neighbor", why: "person cannot walk" },
  { re: /(no power|sin luz|sin electricidad|cold|frio|heat|calor)/, urgency: 3, needs: "neighbor", why: "power or temperature problem" },
];

export function ruleTriage(message: string, person?: Person) {
  const text = message.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const hits = RULES.filter((r) => r.re.test(text));
  let urgency = Math.max(2, ...hits.map((h) => h.urgency));
  let needs: Needs = hits.some((h) => h.needs === "professional") ? "professional" : "neighbor";
  const whys = hits.map((h) => h.why);
  if (person && (person.mobility === "cannot_walk" || person.poweredDevice) && urgency >= 4) {
    urgency = 5;
    whys.push(person.mobility === "cannot_walk" ? "profile: cannot walk" : "profile: powered device");
  }
  if (hits.length === 0) needs = "neighbor";
  const priority: Priority = urgency >= 5 ? "P1" : urgency >= 3 ? "P2" : "P3";
  return {
    urgency,
    needs,
    priority,
    reason: whys.length ? `Rules: ${whys.join(", ")}.` : "Rules: no danger keywords; needs a check.",
    confidence: hits.length ? 0.55 : 0.3,
  };
}

export async function runTriage(deps: AgentDeps, sos: SosEvent): Promise<TriageOutcome> {
  const { store, services } = deps;
  const subject = `sos:${sos.id}`;
  const log = stepLogger(store, "triage", subject);
  const now = deps.now ?? (() => new Date());
  let saved: TriageOutcome | undefined;
  let modelName = "unknown";

  const save = async (v: z.infer<typeof saveTriageInput>, source: "model" | "rules", model: string) => {
    const triageId = await store.saveTriage({ sosId: sos.id, personId: sos.personId, ...v, model });
    const person = await store.getPerson(sos.personId);
    if (person) {
      const pr = computePriority({
        person,
        signals: await store.listSignals(person.id),
        checkIns: await store.listCheckIns(person.id),
        triage: { priority: v.priority, needs: v.needs },
        now: now(),
      });
      await store.setPriority(person.id, v.priority, pr.score);
    }
    saved = { sosId: sos.id, personId: sos.personId, triageId, ...v, source };
    return { triage_id: triageId, saved: true };
  };

  const tools = [
    defineTool({
      name: "get_person_profile",
      description: "Profile of the person who sent the SOS (age, mobility, medical needs, language).",
      input: z.object({}).passthrough(),
      run: async () => {
        const p = await store.getPerson(sos.personId);
        return p ? profileSummary(p) : { error: "unknown person" };
      },
    }),
    defineTool({
      name: "get_weather",
      description: "Active weather alerts where the SOS was sent.",
      input: z.object({}).passthrough(),
      run: async () => {
        const cell = await store.getCell(sos.h3Cell);
        const alerts = await services.weather.alertsForCell(sos.h3Cell);
        return { cell_alert: cell?.alertLevel || "none", alerts };
      },
    }),
    defineTool({
      name: "save_triage",
      description: "Save your triage decision. Call exactly once.",
      input: saveTriageInput,
      run: (v) => (saved ? Promise.resolve({ already_saved: true }) : save(v, "model", modelName)),
    }),
  ];

  // The model name is only known after the first reply; wrap llm to capture it.
  const llm = deps.llm;
  const capturingDeps: AgentDeps = {
    ...deps,
    llm: {
      chat: async (m, o) => {
        const r = await llm.chat(m, o);
        modelName = r.model;
        return r;
      },
    },
  };

  const task = `SOS #${sos.id} from person ${sos.personId} via ${sos.channel} at ${sos.createdAt.toISOString()}:\n"${sos.message}"`;
  const result = await runAgentLoop({ agent: "triage", subject, deps: capturingDeps, instructions: INSTRUCTIONS, task, tools });

  if (!saved || !called(result, "save_triage")) {
    const person = await store.getPerson(sos.personId);
    const r = ruleTriage(sos.message, person);
    await save(r, "rules", "rules");
    await log("decision", `Fallback rules: ${r.priority}, urgency ${r.urgency}, needs ${r.needs}. ${r.reason}`, r.confidence);
  }
  return saved!;
}
