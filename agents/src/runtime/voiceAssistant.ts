// The FirstLine phone line: Nemotron answers spoken questions with live data plus the cited
// protocol pack (the RAG in knowledge/). Who is calling decides what it may know:
//
//   operator  a number in VOICE_OPERATOR_NUMBERS (the coordinator's phone): the live situation,
//             open SOS events, P1 households, reports, and any household the caller names
//   resident  a registered person's phone: their own household, SOS, helper and check-ins;
//             "I need help" opens an SOS, "I'm fine" checks them in safe
//   public    anyone else: safety guidance only, no personal data
//
// Every answer is built from (1) that context, (2) the protocol cards retrieved for what was
// said, and (3) the last few turns of the call.

import { z } from "zod";
import { sosSummary } from "../agents/actions.js";
import type { AgentDeps } from "../agents/loop.js";
import { untrusted } from "../agents/loop.js";
import { retrieve } from "../knowledge/harness.js";
import { forPrompt } from "../knowledge/retrieve.js";
import { jsonCall } from "../llm/json.js";
import type { ChatMessage } from "../llm/client.js";
import type { AssistantReply, CallLang, CallTurn, VoiceAssistant } from "../messaging/inbound-voice.js";
import { normalizePhone } from "../messaging/store.js";
import type { Person } from "../store/types.js";

type Mode = "operator" | "resident" | "public";

interface CallState {
  mode: Mode;
  personId?: number;
  lang: CallLang;
  history: ChatMessage[];
  at: number;
}

const replySchema = z.object({
  say: z.string().min(1).max(700),
  action: z.enum(["none", "sos", "safe", "hangup"]).default("none"),
});

const langOf = (p?: Person): CallLang => (p?.language?.toLowerCase().startsWith("es") ? "es" : "en");
const ago = (d?: Date) => (d ? `${Math.max(0, Math.round((Date.now() - d.getTime()) / 60000))} min ago` : "never");

export interface VoiceAssistantOptions {
  operatorNumbers?: string[];
  /** Reply budget; Twilio gives a webhook 15 s. */
  timeoutMs?: number;
}

export function operatorNumbersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.VOICE_OPERATOR_NUMBERS ?? "")
    .split(",")
    .map((s) => normalizePhone(s.trim()))
    .filter(Boolean);
}

export class FirstLineVoiceAssistant implements VoiceAssistant {
  private calls = new Map<string, CallState>();
  private readonly operators: Set<string>;
  private readonly timeoutMs: number;

  constructor(
    private readonly deps: AgentDeps,
    opts: VoiceAssistantOptions = {},
  ) {
    this.operators = new Set((opts.operatorNumbers ?? []).map(normalizePhone));
    this.timeoutMs = opts.timeoutMs ?? 9_000;
  }

  private async identify(from: string): Promise<{ mode: Mode; person?: Person }> {
    const n = normalizePhone(from);
    if (n && this.operators.has(n)) return { mode: "operator" };
    const person = n ? (await this.deps.store.listPeople()).find((p) => p.phone && normalizePhone(p.phone) === n) : undefined;
    return person ? { mode: "resident", person } : { mode: "public" };
  }

  private prune() {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.calls) if (v.at < cutoff) this.calls.delete(k);
  }

  // ---------------- context ----------------

  private async personBlock(p: Person): Promise<string> {
    const { store, services } = this.deps;
    const household = await store.getHousehold(p.householdId);
    const members = (await store.listPeople()).filter((x) => x.householdId === p.householdId);
    const sos = (await store.listOpenSos()).filter((s) => members.some((m) => m.id === s.personId));
    const checkIns = (await store.listCheckIns(p.id)).slice(-3);
    const cell = await store.getCell(p.h3Cell);
    const alerts = await services.weather.alertsForCell(p.h3Cell).catch(() => []);
    const lines = [
      `${p.name}, age ${p.age}, ${p.livesAlone ? "lives alone" : "lives with others"}, mobility ${p.mobility}${p.medicalNeeds ? `, medical: ${p.medicalNeeds}` : ""}${p.poweredDevice ? ", uses a powered medical device" : ""}. Language ${p.language}.`,
      `Address: ${household?.address ?? "unknown"}. Household: ${members.map((m) => `${m.name} (${m.status})`).join(", ")}.`,
      `Status ${p.status}, priority ${p.priority}, last heard from ${ago(p.lastSeen)}.`,
    ];
    for (const s of sos) lines.push(`Open SOS: "${s.message.slice(0, 160)}". ${await sosSummary(this.deps, s.id)}`);
    if (!sos.length) lines.push("No open SOS.");
    for (const c of checkIns) lines.push(`Check-in ${ago(c.createdAt)} via ${c.kind}: ${c.result}${c.note ? ` (${c.note.slice(0, 100)})` : ""}.`);
    if (cell?.alertLevel) lines.push(`Area alert: ${cell.alertLevel}.`);
    for (const a of alerts.slice(0, 2)) lines.push(`Weather: ${a.headline}.`);
    return lines.join("\n");
  }

  private async operatorBlock(text: string): Promise<string> {
    const { store } = this.deps;
    const people = await store.listPeople();
    const households = new Set(people.map((p) => p.householdId)).size;
    const count = (s: Person["status"]) => people.filter((p) => p.status === s).length;
    const p1 = people.filter((p) => p.priority === "P1");
    const p2 = people.filter((p) => p.priority === "P2");
    const open = (await store.listOpenSos()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const cells = await store.listCells();
    const reports = (await store.listIncidentReports()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 2);
    const lines = [
      `Right now: ${people.length} people in ${households} households. ${count("safe")} safe, ${count("needs_help")} need help, ${count("unknown")} not reached.`,
      `Priority: ${p1.length} P1, ${p2.length} P2. Coverage gaps in ${cells.filter((c) => c.coverageGap).length} areas. Weather alerts in ${cells.filter((c) => c.alertLevel).length} areas.`,
      `${open.length} open SOS events.`,
    ];
    for (const s of open.slice(0, 8)) {
      const who = people.find((p) => p.id === s.personId);
      const hh = who ? await store.getHousehold(who.householdId) : undefined;
      lines.push(`- ${who?.name ?? `person ${s.personId}`}, ${hh?.address ?? "?"}: "${s.message.slice(0, 100)}" ${await sosSummary(this.deps, s.id)}`);
    }
    if (p1.length) lines.push(`P1 people: ${p1.slice(0, 8).map((p) => p.name).join(", ")}.`);
    for (const r of reports) lines.push(`Latest report (${ago(r.createdAt)}): ${r.summary.slice(0, 300)}${r.blockedRoads ? ` Blocked roads: ${r.blockedRoads.slice(0, 120)}.` : ""}`);
    // Anyone the caller names gets their full record.
    const t = text.toLowerCase();
    const named = people.filter((p) => p.name.split(/\s+/).some((w) => w.length > 2 && t.includes(w.toLowerCase()))).slice(0, 2);
    for (const p of named) lines.push(`\nRecord for ${p.name}:\n${await this.personBlock(p)}`);
    return lines.join("\n");
  }

  // ---------------- turns ----------------

  async greet({ callSid, from }: { callSid: string; from: string }): Promise<AssistantReply> {
    this.prune();
    const { mode, person } = await this.identify(from);
    const lang = langOf(person);
    this.calls.set(callSid, { mode, personId: person?.id, lang, history: [], at: Date.now() });
    await this.log(person?.id, `Inbound call answered (${mode} line).`);
    if (mode === "operator") {
      const people = await this.deps.store.listPeople();
      const open = (await this.deps.store.listOpenSos()).length;
      const p1 = people.filter((p) => p.priority === "P1").length;
      const unknown = people.filter((p) => p.status === "unknown").length;
      return {
        lang: "en",
        say: `FirstLine operations. Right now there are ${open} open S O S events, ${p1} priority one people, and ${unknown} people we have not reached. Ask me about any household, what to do next, or safety guidance.`,
      };
    }
    if (mode === "resident" && person) {
      const sos = (await this.deps.store.listOpenSos()).find((s) => s.personId === person.id);
      const first = person.name.split(/\s+/)[0];
      if (lang === "es") {
        return { lang, say: `Hola ${first}, habla FirstLine. ${sos ? "Tenemos su pedido de ayuda abierto y estamos trabajando en ello." : "Le tenemos registrado."} ¿Cómo está? Dígame si necesita ayuda.` };
      }
      return { lang, say: `Hi ${first}, this is FirstLine. ${sos ? "We have your help request open and we are working on it." : "We have you on our list."} How are you doing? Tell me if you need help.` };
    }
    return {
      lang: "en",
      say: "This is FirstLine, the neighborhood safety line. If anyone is in danger right now, hang up and call 9 1 1. Otherwise, ask me what to do about cold, carbon monoxide, flooding, burst pipes or medical devices.",
    };
  }

  async reply(turn: CallTurn): Promise<AssistantReply> {
    let state = this.calls.get(turn.callSid);
    if (!state) {
      await this.greet({ callSid: turn.callSid, from: turn.from });
      state = this.calls.get(turn.callSid)!;
    }
    state.at = Date.now();
    const person = state.personId ? await this.deps.store.getPerson(state.personId) : undefined;
    const profile = person ? { age: person.age, poweredDevice: person.poweredDevice, medicalNeeds: person.medicalNeeds, mobility: person.mobility, livesAlone: person.livesAlone } : undefined;
    const cards = forPrompt(await retrieve(turn.text, { k: 3, profile }).catch(() => []));
    const context =
      state.mode === "operator" ? await this.operatorBlock(turn.text) : state.mode === "resident" && person ? await this.personBlock(person) : "Caller is not registered. Share no personal data about anyone.";

    const rules: Record<Mode, string> = {
      operator:
        "The caller is the FirstLine coordinator. Brief them like a dispatcher: lead with the most urgent household, use names and addresses from CONTEXT, say what the agents already did and what is still open. action is always none or hangup.",
      resident:
        "The caller is the resident in CONTEXT. Tell them where their help request stands (who is coming, what was decided) and what to do now. If they describe being hurt, trapped, very cold, water coming in, a medical device losing power, or anything urgent, set action to sos. If they say they are fine and need nothing, set action to safe.",
      public: "The caller is not registered. Give general safety guidance only. Never reveal anything about any resident.",
    };
    const system = [
      "/no_think",
      "You are FirstLine's phone line during a disaster. Your words are read aloud by text to speech.",
      rules[state.mode],
      "Rules: at most three short sentences. Plain speech, no lists, no markdown, no card ids, no URLs. Use only facts from CONTEXT and GUIDANCE; if you do not know, say so. If anything sounds life threatening, tell them to call 9 1 1 first.",
      `Answer in ${state.lang === "es" ? "Spanish" : "English"} unless the caller switches language.`,
      'Reply with one JSON object: {"say": "...", "action": "none" | "sos" | "safe" | "hangup"}',
      `CONTEXT (live from the FirstLine database):\n${context}`,
      `GUIDANCE (official protocol cards retrieved for what the caller said):\n${JSON.stringify(cards.map((c) => ({ severity: c.severity, guidance: c.guidance, source: c.source })))}`,
    ].join("\n\n");

    const messages: ChatMessage[] = [{ role: "system", content: system }, ...state.history.slice(-6), { role: "user", content: untrusted(turn.text) }];
    let out: z.infer<typeof replySchema>;
    try {
      out = (
        await withTimeout(
          jsonCall({ llm: this.deps.llm, schema: replySchema, messages, opts: { tier: "fast", temperature: 0.2, maxTokens: 350, tag: "voice" } }),
          this.timeoutMs,
        )
      ).value;
    } catch (err) {
      // Model slow or down: fall back to the top retrieved card so the caller still hears guidance.
      console.error("[voice] assistant fallback:", err instanceof Error ? err.message : err);
      const top = cards[0];
      out = {
        say: top
          ? `${top.guidance.split(/(?<=\.)\s/).slice(0, 2).join(" ")} If anyone is in danger, call 9 1 1.`
          : "I could not look that up right now. If anyone is in danger, call 9 1 1.",
        action: /help|hurt|trapped|ayuda|emergenc/i.test(turn.text) && state.mode === "resident" ? "sos" : "none",
      };
    }

    let say = out.say.replace(/\[[a-z0-9-]+\]/gi, "").trim();
    if (state.mode === "resident" && person) {
      if (out.action === "sos") {
        await this.deps.store.pressSos({
          clientId: `voice:${turn.callSid}:${turn.turn}`,
          personId: person.id,
          message: `Said on a call to FirstLine: ${turn.text}`.slice(0, 1900),
          lat: person.lastLat,
          lng: person.lastLng,
          channel: "voice",
        });
        say += state.lang === "es" ? " Abrí un pedido de ayuda y ya estamos avisando a sus vecinos." : " I opened a help request and we are alerting your neighbors now.";
      } else if (out.action === "safe") {
        await this.deps.store.checkIn({ clientId: `voice:${turn.callSid}:${turn.turn}`, personId: person.id, kind: "voice", result: "safe", note: `Said on a call: ${turn.text}`.slice(0, 500) });
      }
    }
    state.history.push({ role: "user", content: untrusted(turn.text) }, { role: "assistant", content: JSON.stringify({ say, action: out.action }) });
    await this.log(person?.id, `Call (${state.mode}): "${turn.text.slice(0, 160)}" -> ${out.action}; said "${say.slice(0, 200)}"`);
    return { say, lang: state.lang, hangup: out.action === "hangup" };
  }

  private async log(personId: number | undefined, content: string) {
    await this.deps.store
      .logAgentStep({ agent: "silent_signal", subject: personId ? `person:${personId}` : "voice:line", kind: "tool_result", content: content.slice(0, 500) })
      .catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
