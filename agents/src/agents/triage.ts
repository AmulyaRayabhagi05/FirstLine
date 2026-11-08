// Triage agent: reads an SOS in any language and decides urgency, who is needed and the
// priority, then saves it with save_triage. Falls back to keyword rules if the model is down.

import { z } from "zod";
import { computePriority } from "../priority.js";
import type { Id, Needs, Person, Priority, SosEvent } from "../store/types.js";
import { confidence, defineTool, runAgentLoop, stepLogger, untrusted, type AgentDeps } from "./loop.js";
import { RESPONDER_RULES, makeLookupProtocolTool } from "../knowledge/harness.js";
import { searchProtocols } from "../knowledge/retrieve.js";
import { triageConfidence } from "./confidence.js";

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
  /** True when the model said less than P1 and the rules safety floor raised it. */
  raisedBySafetyFloor: boolean;
}

const needsEnum = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (/(prof|ems|emergency|rescue|fire|medic|911|first.?respond)/.test(t)) return "professional";
  if (/(neigh|vecin|community|volunteer)/.test(t)) return "neighbor";
  return t;
}, z.enum(["neighbor", "professional"]));

const priorityEnum = z.preprocess((v) => {
  if (typeof v === "number") return `P${v}`;
  if (typeof v !== "string") return v;
  const m = v.trim().toUpperCase().match(/^P?\s*([123])\b/);
  return m ? `P${m[1]}` : v.trim().toUpperCase();
}, z.enum(["P1", "P2", "P3"]));

const saveTriageInput = z.object({
  urgency: z.coerce.number().int().min(1).max(5),
  needs: needsEnum,
  priority: priorityEnum,
  reason: z.preprocess((v) => (Array.isArray(v) ? v.join("; ") : v), z.string().min(3)),
  confidence,
});

/** Accept a triage answer the model put in `decision` (or nested one level) instead of save_triage. */
function salvageTriage(v: unknown): z.infer<typeof saveTriageInput> | undefined {
  let obj = v;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const direct = saveTriageInput.safeParse(obj);
  if (direct.success) return direct.data;
  for (const inner of Object.values(obj as Record<string, unknown>)) {
    if (inner && typeof inner === "object") {
      const p = saveTriageInput.safeParse(inner);
      if (p.success) return p.data;
    }
  }
  return undefined;
}

const INSTRUCTIONS = `You are the TRIAGE agent for FirstLine, a disaster-response network of neighbors.
You read one SOS message (any language: Spanish, Vietnamese, English, ...) and decide:
- urgency 1-5 (5 = life threat right now)
- needs: "professional" (EMS, fire, swift-water rescue, medical) or "neighbor" (a nearby person with a truck, boat, generator or supplies can handle it)
- priority: "P1" life threat now, "P2" serious and getting worse, "P3" supplies or a ride
- reason: one short English sentence a dispatcher can read (translate the key facts)
- confidence 0..1
Priority follows urgency: urgency 5 = P1, urgency 3-4 = P2, urgency 1-2 = P3.
It is urgency 5 / P1 / professional when ANY of these is true:
- water is entering or rising in the home and anyone there cannot walk or cannot leave on their own
- someone is trapped, unconscious, not breathing, bleeding badly, has chest pain, or there is a fire
- oxygen or a powered medical device has no power
- signs of carbon monoxide: headache, dizziness, nausea or confusion with a generator, grill, heater or car running nearby
- signs of serious hypothermia: confusion, slurred speech or very sleepy in the cold
Example: "agua entrando, mi mamá no puede caminar" (water coming in, my mom cannot walk) => urgency 5, professional, P1.

Use ONLY facts in the message and the PROFILE. Never write that someone is trapped, cannot walk, is hurt or
that water is entering unless the message or the profile says so.

A check-in that only says they need help, with no details, is not by itself a life threat. Decide from the PROFILE:
- urgency 5, P1, professional: uses a powered medical device (oxygen, dialysis) or cannot walk
- urgency 4, P2, professional: age 80+ and lives alone, or limited mobility and lives alone
- urgency 3, P2, neighbor: age 65+, lives alone, or limited mobility
- urgency 2, P3, neighbor: everyone else (a neighbor checks on them)
Say in the reason which profile facts decided it, e.g. "No details; 84, lives alone, uses oxygen [power-device-backup]".

${RESPONDER_RULES}

Steps: the PROFILE is in the task. Call lookup_protocol with the hazard you see, optionally get_weather, then save_triage.
Your reason must cite 1-2 card ids from lookup_protocol in brackets, e.g. "Generator in garage and headache: possible carbon monoxide [co-symptoms-911]". Then set done=true.`;

/**
 * Safety floor: if the keyword rules see a life threat (urgency 5) the saved priority is never
 * lower than P1. Logged as its own step so the panel shows the override.
 */
function applySafetyFloor(v: z.infer<typeof saveTriageInput>, message: string, person?: Person) {
  const r = ruleTriage(message, person);
  if (r.urgency < 5 || v.priority === "P1") return { value: v, raised: false as const };
  return {
    value: { ...v, urgency: 5, priority: "P1" as const, needs: "professional" as const },
    raised: true as const,
    from: v.priority,
    why: r.reason,
  };
}

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
const CO_SOURCE = /(generator|generador|grill|parrilla|charcoal|carbon|heater|calentador|stove|estufa|horno|oven|car running|carro prendido|garage|garaje)/;
const CO_SYMPTOM = /(headache|dolor de cabeza|dizzy|mareo|marea|nause|vomit|confus|weak|debil|sleepy|somnolien|passed out|desmay)/;
const HYPO_SIGN = /(confus|slurred|arrastra|very sleepy|muy somnolien|won'?t wake|no despierta|blue lips|labios morados)/;
const COLD = /(cold|frio|freez|helad|no heat|sin calefaccion|no power|sin luz)/;

const RULES: { re: RegExp; urgency: number; needs: Needs; why: string }[] = [
  { re: /(no respira|not breathing|unconscious|inconsciente|chest pain|dolor de pecho|bleed|sangr|fire|fuego|incendio|heart|corazon)/, urgency: 5, needs: "professional", why: "possible medical emergency or fire" },
  { re: /(carbon monoxide|monoxido|co alarm|alarma de co)/, urgency: 5, needs: "professional", why: "possible carbon monoxide" },
  { re: /(pipe burst|burst pipe|tuberia reventada|se reviento|water everywhere|leak|fuga)/, urgency: 2, needs: "neighbor", why: "burst pipe" },
  // The bare word "flood" is not a life threat (every flood check-in says it); rising or entering water, or being trapped, is.
  { re: /(water (is )?(coming|rising|entering)|agua (entrando|subiendo)|flood(ing|ed)? (in|into) (the|my|our) (house|home|apartment)|inundad[oa] (la|mi) casa|nuoc (vao|dang len)|swept|atrapad|trapped)/, urgency: 5, needs: "professional", why: "rising water / trapped" },
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
  // combinations that are life threats even when neither word alone is
  if (CO_SOURCE.test(text) && CO_SYMPTOM.test(text)) {
    urgency = 5;
    needs = "professional";
    whys.push("possible carbon monoxide (fuel source + symptoms)");
  }
  if (HYPO_SIGN.test(text) && COLD.test(text)) {
    urgency = 5;
    needs = "professional";
    whys.push("hypothermia signs");
  }
  if (person && (person.mobility === "cannot_walk" || person.poweredDevice) && urgency >= 4) {
    urgency = 5;
    whys.push(person.mobility === "cannot_walk" ? "profile: cannot walk" : "profile: powered device");
  }
  // A bare "needs help" with no danger words: the profile decides, same ladder as the prompt.
  if (whys.length === 0 && person && /need(s|ing)? help|necesit/.test(text)) {
    const alone = person.livesAlone;
    if (person.poweredDevice || person.mobility === "cannot_walk") {
      urgency = 5;
      needs = "professional";
      whys.push(person.poweredDevice ? "needs help and uses a powered medical device" : "needs help and cannot walk");
    } else if ((person.age >= 80 && alone) || (person.mobility === "limited" && alone)) {
      urgency = 4;
      needs = "professional";
      whys.push(person.age >= 80 ? `needs help, ${person.age} and lives alone` : "needs help, limited mobility and lives alone");
    } else if (person.age >= 65 || alone || person.mobility === "limited") {
      urgency = 3;
      needs = "neighbor";
      whys.push(person.age >= 65 ? `needs help, age ${person.age}` : alone ? "needs help and lives alone" : "needs help, limited mobility");
    }
  }
  if (whys.length === 0) needs = "neighbor";
  const priority: Priority = urgency >= 5 ? "P1" : urgency >= 3 ? "P2" : "P3";
  // cite the guidance that backs the decision
  const cites = searchProtocols(message, {
    k: 2,
    profile: person ? { age: person.age, poweredDevice: person.poweredDevice, medicalNeeds: person.medicalNeeds, mobility: person.mobility, livesAlone: person.livesAlone } : undefined,
  }).map((c) => `[${c.id}]`);
  const base = whys.length ? `Rules: ${whys.join(", ")}.` : "Rules: no danger keywords; needs a check.";
  return {
    urgency,
    needs,
    priority,
    reason: cites.length ? `${base} ${cites.join(" ")}` : base,
    confidence: whys.length ? 0.55 : 0.3,
    whys,
  };
}

export async function runTriage(deps: AgentDeps, sos: SosEvent): Promise<TriageOutcome> {
  const { store, services } = deps;
  const subject = `sos:${sos.id}`;
  const log = stepLogger(store, "triage", subject);
  const now = deps.now ?? (() => new Date());
  let saved: TriageOutcome | undefined;
  let modelName = "unknown";
  // What the model actually did, for the evidence-based confidence.
  let readProfile = false;
  const retrievedCardIds = new Set<string>();

  const save = async (v: z.infer<typeof saveTriageInput>, source: "model" | "rules", model: string) => {
    let raised = false;
    if (source === "model") {
      const person = await store.getPerson(sos.personId);
      const modelPriority = v.priority;
      const f = applySafetyFloor(v, sos.message, person);
      if (f.raised) {
        await log("decision", `Safety floor: model said ${f.from}, raised to P1 because rules detected a life threat (${f.why})`);
        v = f.value;
        raised = true;
      }
      // Replace the model's self-reported number with one computed from checks we can verify.
      const rules = ruleTriage(sos.message, person);
      const conf = triageConfidence({
        modelPriority,
        rules: { priority: rules.priority, whys: rules.whys },
        raisedBySafetyFloor: raised,
        reason: v.reason,
        retrievedCardIds,
        readProfile,
        message: sos.message,
        signals: person ? await store.listSignals(person.id) : [],
        weatherAlert: (await store.getCell(sos.h3Cell))?.alertLevel || undefined,
        selfReported: v.confidence,
      });
      v = { ...v, confidence: conf.value };
      await log("decision", conf.summary, conf.value);
    }
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
    saved = { sosId: sos.id, personId: sos.personId, triageId, ...v, source, raisedBySafetyFloor: raised };
    return { triage_id: triageId, saved: true };
  };

  const tools = [
    defineTool({
      name: "get_person_profile",
      description: "Profile of the person who sent the SOS (age, mobility, medical needs, language).",
      input: z.object({}).passthrough(),
      run: async () => {
        const p = await store.getPerson(sos.personId);
        readProfile = !!p;
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
    recordCards(
      makeLookupProtocolTool(async () => {
        const p = await store.getPerson(sos.personId);
        return p ? { age: p.age, poweredDevice: p.poweredDevice, medicalNeeds: p.medicalNeeds, mobility: p.mobility, livesAlone: p.livesAlone } : undefined;
      }),
      retrievedCardIds,
    ),
    defineTool({
      name: "save_triage",
      description: "Save your triage decision. Call exactly once.",
      input: saveTriageInput,
      run: async (v) => {
        if (saved) return { already_saved: true };
        const invented = inventedClaims(v.reason, sos.message, await store.getPerson(sos.personId));
        if (invented.length) {
          await log("thought", `Rejected a reason with facts nobody reported (${invented.join(", ")})`);
          return {
            error: `Your reason says ${invented.join(" and ")}, but neither the message nor the PROFILE says that. Rewrite the reason and urgency using only the message and PROFILE, then call save_triage again.`,
          };
        }
        return save(v, "model", modelName);
      },
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

  // The profile goes in the task: in 121 recorded runs the model never called get_person_profile.
  const person0 = await store.getPerson(sos.personId);
  readProfile = !!person0;
  const fromCheckIn = /^(checkin|needs-help):/.test(sos.clientId);
  const task = [
    `SOS #${sos.id} from person ${sos.personId} via ${sos.channel} at ${sos.createdAt.toISOString()}:`,
    untrusted(sos.message),
    fromCheckIn ? "This SOS was opened from a check-in that only said they need help; there are no other details." : "",
    `PROFILE: ${person0 ? JSON.stringify(profileSummary(person0)) : "unknown person"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await runAgentLoop({
    agent: "triage",
    subject,
    deps: capturingDeps,
    instructions: INSTRUCTIONS,
    task,
    tools,
    requiredTools: ["save_triage"],
  });

  if (!saved) {
    const salvaged = salvageTriage(result.decisionValue);
    if (salvaged) {
      await save(salvaged, "model", modelName);
      await log(
        "decision",
        `Saved the model's final answer (it skipped save_triage): ${salvaged.priority}, urgency ${salvaged.urgency}, needs ${salvaged.needs}.`,
        salvaged.confidence,
      );
    }
  }
  if (!saved) {
    const why = result.error
      ? `model error: ${result.error.slice(0, 160)}`
      : "model finished without a valid save_triage";
    const person = await store.getPerson(sos.personId);
    const { whys: _whys, ...r } = ruleTriage(sos.message, person);
    await save(r, "rules", "rules");
    await log("decision", `Fallback rules (${why}): ${r.priority}, urgency ${r.urgency}, needs ${r.needs}. ${r.reason}`, r.confidence);
  }
  return saved!;
}

/** Wraps lookup_protocol so the ids it returns are remembered (to check the model's citations). */
function recordCards<T extends { run: (args: never) => Promise<unknown> }>(tool: T, into: Set<string>): T {
  const run = tool.run;
  return {
    ...tool,
    run: (async (args: never) => {
      const out = (await run(args)) as { cards?: { id: string }[] };
      for (const c of out?.cards ?? []) into.add(c.id.toLowerCase());
      return out;
    }) as T["run"],
  };
}

// Claims a triage reason may only make when the message or the profile supports them.
const CLAIMS: { name: string; reason: RegExp; support: RegExp; profile?: (p: Person) => boolean }[] = [
  { name: "someone is trapped", reason: /trapped|entrapment|atrapad/i, support: /trapped|atrapad|can'?t get out|cannot get out|stuck|no puedo salir/i },
  { name: "water is entering the home", reason: /water (is )?(entering|rising|coming)|flooding (the|their) home/i, support: /water|agua|nuoc|flooding (in|into)/i },
  {
    name: "someone cannot walk",
    reason: /cannot walk|can'?t walk|inability to (walk|move)|unable to (walk|move)|immobile/i,
    support: /walk|caminar|wheelchair|silla de ruedas|bedridden/i,
    profile: (p) => p.mobility === "cannot_walk",
  },
  { name: "someone is hurt", reason: /injur|hurt|bleeding|unconscious/i, support: /injur|hurt|bleed|sangr|unconscious|herid/i },
];

/** Claims in the reason that neither the message nor the profile supports. */
export function inventedClaims(reason: string, message: string, person?: Person): string[] {
  const words = reason.replace(/\[[^\]]*\]/g, " "); // cited card ids like [flood-trapped-high] are not claims
  return CLAIMS.filter((c) => c.reason.test(words) && !c.support.test(message) && !(person && c.profile?.(person))).map((c) => c.name);
}
