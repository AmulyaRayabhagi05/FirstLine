// Automated check-in calls for people without the app. The call reads a short script, gathers
// DTMF (1 okay / 2 need help) or speech, and the webhook turns the answer into check_in / press_sos.

import twilio from "twilio";
import { z } from "zod";
import type { ChannelPerson, ChannelStore } from "./store.js";
import { xmlEscape, type MessagingTool, type TwilioConfig, type TwilioLike } from "./twilio.js";

export type ReplyClass = { result: "safe" | "needs_help" | "unclear"; note?: string };
/** Injected by the worker (Nemotron). The stub below is keyword-based. */
export type ClassifyReply = (text: string, lang: string) => Promise<ReplyClass>;

export const keywordClassifyReply: ClassifyReply = async (text) => {
  const t = text.toLowerCase();
  const help = /\b(help|hurt|sick|fell|fall|cannot|can't|no power|hot|dizzy|oxygen|ayuda|auxilio|enfermo|enferma|caí|calor|no estoy bien)\b/;
  const safe = /\b(ok|okay|fine|good|safe|alright|all right|bien|estoy bien|todo bien)\b/;
  if (help.test(t)) return { result: "needs_help", note: text };
  if (safe.test(t)) return { result: "safe", note: text };
  return { result: "unclear", note: text };
};

type Lang = "en" | "es";
const langOf = (language: string | undefined): Lang => (language?.toLowerCase().startsWith("es") ? "es" : "en");

const SCRIPT: Record<Lang, { intro: (name: string) => string; prompt: string; safe: string; help: string; unclear: string; noInput: string; voice: string; speechLang: string }> = {
  en: {
    intro: (name) =>
      `Hello ${name}, this is FirstLine, your neighborhood safety check. ` +
      "Is your home too hot, or is the power out? " +
      "If you are running a generator, keep it outside, away from windows, because of carbon monoxide. " +
      "If you use oxygen or another powered medical device, tell us if it is losing power.",
    prompt: "Press 1 if you are okay. Press 2 if you need help. Or just tell us how you are doing.",
    safe: "Thank you. We marked you safe. Goodbye.",
    help: "Thank you. We are alerting your neighbors and responders now. Stay on a safe floor and keep your phone near you. Goodbye.",
    unclear: "Sorry, I did not understand.",
    noInput: "We did not hear an answer. A neighbor may check on you. Goodbye.",
    voice: "Polly.Joanna",
    speechLang: "en-US",
  },
  es: {
    intro: (name) =>
      `Hola ${name}, le llama FirstLine, la revisión de seguridad de su vecindario. ` +
      "¿Hace demasiado calor en su casa, o no hay electricidad? " +
      "Si usa un generador, déjelo afuera, lejos de las ventanas, por el monóxido de carbono. " +
      "Si usa oxígeno u otro equipo médico eléctrico, díganos si se está quedando sin energía.",
    prompt: "Oprima 1 si está bien. Oprima 2 si necesita ayuda. O díganos cómo está.",
    safe: "Gracias. Le marcamos como a salvo. Adiós.",
    help: "Gracias. Estamos avisando a sus vecinos y a los equipos de rescate. Mantenga su teléfono cerca. Adiós.",
    unclear: "Perdón, no le entendí.",
    noInput: "No escuchamos respuesta. Es posible que un vecino pase a verle. Adiós.",
    voice: "Polly.Lupe",
    speechLang: "es-US",
  },
};

export interface VoiceDeps {
  store: ChannelStore;
  client: TwilioLike;
  cfg: TwilioConfig;
  classifyReply?: ClassifyReply;
  /** Lookup used by the webhook to get the person's language/location. */
  getPerson?: (personId: number) => Promise<ChannelPerson | undefined>;
}

function resultUrl(cfg: TwilioConfig, personId: number, lang: Lang, attempt = 0) {
  const base = cfg.publicUrl ?? "";
  return `${base}/voice/result?personId=${personId}&lang=${lang}&attempt=${attempt}`;
}

/** TwiML spoken when the person picks up (also served for retries after an unclear answer). */
export function checkInTwiml(cfg: TwilioConfig, person: { id: number; name: string; language?: string }, attempt = 0): string {
  const lang = langOf(person.language);
  const s = SCRIPT[lang];
  const r = new twilio.twiml.VoiceResponse();
  const g = r.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    timeout: 6,
    speechTimeout: "auto",
    language: s.speechLang as never,
    action: resultUrl(cfg, person.id, lang, attempt),
    method: "POST",
  });
  if (attempt === 0) g.say({ voice: s.voice as never, language: s.speechLang as never }, s.intro(person.name));
  g.say({ voice: s.voice as never, language: s.speechLang as never }, s.prompt);
  // Reached only if Gather times out with no input.
  r.redirect({ method: "POST" }, `${resultUrl(cfg, person.id, lang, attempt)}&noinput=1`);
  return r.toString();
}

function sayAndHangup(lang: Lang, text: string): string {
  const s = SCRIPT[lang];
  const r = new twilio.twiml.VoiceResponse();
  r.say({ voice: s.voice as never, language: s.speechLang as never }, text);
  r.hangup();
  return r.toString();
}

export async function placeCheckInCall(deps: VoiceDeps, person: ChannelPerson): Promise<{ callSid: string }> {
  const { cfg, client } = deps;
  if (!cfg.fromNumber) throw new Error("TWILIO_FROM_NUMBER is not set");
  if (!cfg.publicUrl) throw new Error("PUBLIC_BASE_URL is not set (Twilio must reach /voice/*)");
  const call = await client.calls.create({
    to: person.phone,
    from: cfg.fromNumber,
    twiml: checkInTwiml(cfg, person),
    statusCallback: `${cfg.publicUrl}/voice/status?personId=${person.id}`,
    statusCallbackEvent: ["completed"],
    timeout: 25,
  });
  await deps.store.logAgentStep({
    agent: "silent_signal",
    subject: `person:${person.id}`,
    kind: "tool_call",
    content: `Placed check-in call (${call.sid})`,
  });
  return { callSid: call.sid };
}

const placeCallInput = z.object({
  personId: z.number().int().positive().describe("person.id to call"),
});

/** Agent tool. Needs a person lookup because the model only knows ids. */
export function makePlaceCheckInCallTool(
  deps: VoiceDeps & { getPerson: (id: number) => Promise<ChannelPerson | undefined> },
): MessagingTool<typeof placeCallInput, { callSid: string }> {
  return {
    name: "place_check_in_call",
    description:
      "Phone a person who has not checked in. An automated voice asks about heat, generators/carbon monoxide and powered medical devices; they press 1 (okay) or 2 (help) or speak. The result arrives later as a check_in or SOS.",
    inputSchema: placeCallInput,
    run: async ({ personId }) => {
      const person = await deps.getPerson(personId);
      if (!person) throw new Error(`person ${personId} not found`);
      if (!person.phone) throw new Error(`person ${personId} has no phone`);
      return placeCheckInCall(deps, person);
    },
  };
}

export interface VoiceResultParams {
  personId: number;
  lang?: string;
  attempt?: number;
  callSid: string;
  digits?: string;
  speechResult?: string;
  noInput?: boolean;
}

export type VoiceOutcome = "safe" | "needs_help" | "no_answer" | "retry";

/** Handles the Gather action. Returns the TwiML to play next and what was recorded. */
export async function handleVoiceResult(deps: VoiceDeps, p: VoiceResultParams): Promise<{ twiml: string; outcome: VoiceOutcome }> {
  const lang = langOf(p.lang);
  const s = SCRIPT[lang];
  const clientId = `voice:${p.callSid}`;
  const person = deps.getPerson ? await deps.getPerson(p.personId) : undefined;
  const attempt = p.attempt ?? 0;

  const safe = async (note: string) => {
    await deps.store.checkIn({ clientId, personId: p.personId, kind: "voice", result: "safe", note });
    return { twiml: sayAndHangup(lang, s.safe), outcome: "safe" as const };
  };
  const help = async (message: string) => {
    await deps.store.pressSos({
      clientId,
      personId: p.personId,
      message,
      lat: person?.lastLat ?? 0,
      lng: person?.lastLng ?? 0,
      channel: "voice",
    });
    return { twiml: sayAndHangup(lang, s.help), outcome: "needs_help" as const };
  };
  const noAnswer = async (note: string) => {
    await deps.store.checkIn({ clientId, personId: p.personId, kind: "voice", result: "no_answer", note });
    return { twiml: sayAndHangup(lang, s.noInput), outcome: "no_answer" as const };
  };
  const retry = () => {
    const base = person ?? { id: p.personId, name: "", language: lang };
    const twiml = checkInTwiml(deps.cfg, { ...base, language: lang }, attempt + 1);
    // Prepend the "didn't understand" line.
    const withSorry = twiml.replace("<Gather", `<Say voice="${s.voice}" language="${s.speechLang}">${xmlEscape(s.unclear)}</Say><Gather`);
    return { twiml: withSorry, outcome: "retry" as const };
  };

  const digit = p.digits?.trim();
  if (digit === "1") return safe("Pressed 1 on check-in call");
  if (digit === "2") return help("Pressed 2 on check-in call: needs help");

  const speech = p.speechResult?.trim();
  if (speech) {
    const classify = deps.classifyReply ?? keywordClassifyReply;
    const c = await classify(speech, lang);
    await deps.store.logAgentStep({
      agent: "silent_signal",
      subject: `person:${p.personId}`,
      kind: "tool_result",
      content: `Call reply "${speech.slice(0, 120)}" -> ${c.result}`,
    });
    if (c.result === "safe") return safe(`Said: ${speech}`);
    if (c.result === "needs_help") return help(`Said on check-in call: ${speech}`);
    if (attempt < 1) return retry();
    // Unclear twice: someone answered and spoke, so treat as needing a human check.
    return help(`Unclear reply on check-in call: ${speech}`);
  }

  if (digit && attempt < 1) return retry();
  if (attempt < 1 && !p.noInput) return retry();
  return noAnswer(p.noInput ? "Answered but no response" : "No usable input");
}

/** Status callback: unanswered / busy / failed calls become check_in(no_answer). */
export async function handleVoiceStatus(
  deps: VoiceDeps,
  p: { personId: number; callSid: string; callStatus: string; answeredBy?: string },
): Promise<"no_answer" | "ignored"> {
  const unanswered = ["no-answer", "busy", "failed", "canceled"].includes(p.callStatus);
  if (!unanswered) return "ignored";
  await deps.store.checkIn({
    clientId: `voice:${p.callSid}`,
    personId: p.personId,
    kind: "voice",
    result: "no_answer",
    note: `Call ${p.callStatus}`,
  });
  return "no_answer";
}
