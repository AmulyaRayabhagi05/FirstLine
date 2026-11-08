// Inbound calls to the FirstLine number: a spoken conversation with Nemotron.
//
//   POST /voice/inbound    Twilio's "A call comes in" webhook: greet, then listen
//   POST /voice/converse   each thing the caller says (Gather speech) -> answer -> listen again
//
// What the line knows depends on who is calling (see runtime/voiceAssistant.ts): an operator number
// gets the live situation, a registered resident gets their own household, anyone else gets cited
// safety guidance. The messaging layer only handles TwiML; the assistant is injected.

import twilio from "twilio";
import type { TwilioConfig } from "./twilio.js";

export type CallLang = "en" | "es";

export interface CallTurn {
  callSid: string;
  from: string;
  /** What the caller said (empty when Twilio heard nothing). */
  text: string;
  turn: number;
}

export interface AssistantReply {
  say: string;
  lang: CallLang;
  hangup?: boolean;
  /** Words speech recognition should expect next (names on the call, key terms). */
  hints?: string[];
}

// Terms callers use on this line; Twilio biases recognition toward them.
const BASE_HINTS = [
  "FirstLine", "who needs help", "help first", "priority one", "P1", "SOS", "neighbor", "safety net",
  "escalate", "responder", "generator", "carbon monoxide", "hypothermia", "cold", "no heat", "flood",
  "water", "pipes", "oxygen", "medical device", "shelter", "warming center", "blankets", "bye",
];

export interface VoiceAssistant {
  greet(call: { callSid: string; from: string }): Promise<AssistantReply>;
  reply(turn: CallTurn): Promise<AssistantReply>;
}

const VOICE: Record<CallLang, { voice: string; speech: string; listen: string; bye: string; nothing: string }> = {
  en: {
    voice: "Polly.Joanna",
    speech: "en-US",
    listen: "Go ahead.",
    bye: "Thank you for calling FirstLine. Goodbye.",
    nothing: "I did not hear anything.",
  },
  es: {
    voice: "Polly.Lupe",
    speech: "es-US",
    listen: "Adelante.",
    bye: "Gracias por llamar a FirstLine. Adiós.",
    nothing: "No escuché nada.",
  },
};

const MAX_TURNS = 12;

function converseUrl(cfg: TwilioConfig, turn: number, lang: CallLang, empty = 0) {
  return `${cfg.publicUrl ?? ""}/voice/converse?turn=${turn}&lang=${lang}&empty=${empty}`;
}

/** Say `text`, then listen for the caller's next sentence. */
export function speakAndListen(cfg: TwilioConfig, text: string, lang: CallLang, turn: number, empty = 0, hints: string[] = []): string {
  const v = VOICE[lang];
  const r = new twilio.twiml.VoiceResponse();
  const g = r.gather({
    input: ["speech", "dtmf"],
    // Phone-call model with a 2 s end-of-speech pause: "auto" cut callers off mid-sentence.
    speechModel: "phone_call" as never,
    enhanced: true,
    speechTimeout: "2" as never,
    hints: [...new Set([...hints, ...BASE_HINTS])].join(", ").slice(0, 1000),
    profanityFilter: false,
    timeout: 8,
    language: v.speech as never,
    actionOnEmptyResult: true,
    action: converseUrl(cfg, turn, lang, empty),
    method: "POST",
  });
  g.say({ voice: v.voice as never, language: v.speech as never }, text);
  return r.toString();
}

export function speakAndHangup(text: string, lang: CallLang): string {
  const v = VOICE[lang];
  const r = new twilio.twiml.VoiceResponse();
  r.say({ voice: v.voice as never, language: v.speech as never }, text);
  r.hangup();
  return r.toString();
}

const BYE = /\b(bye|goodbye|that'?s all|nothing else|hang up|adi[oó]s|eso es todo|gracias,? (eso es )?todo)\b/i;

export async function handleInboundCall(assistant: VoiceAssistant | undefined, cfg: TwilioConfig, p: { callSid: string; from: string }): Promise<string> {
  if (!assistant) return speakAndHangup("This is FirstLine. If this is an emergency, hang up and call 9 1 1.", "en");
  const g = await assistant.greet(p);
  return speakAndListen(cfg, g.say, g.lang, 1, 0, g.hints);
}

export async function handleConverse(
  assistant: VoiceAssistant | undefined,
  cfg: TwilioConfig,
  p: { callSid: string; from: string; speech?: string; digits?: string; turn: number; lang: CallLang; empty: number },
): Promise<string> {
  const lang = p.lang;
  if (!assistant) return speakAndHangup(VOICE[lang].bye, lang);
  const text = (p.speech ?? "").trim() || (p.digits ? `pressed ${p.digits}` : "");
  if (!text) {
    if (p.empty >= 1) return speakAndHangup(`${VOICE[lang].nothing} ${VOICE[lang].bye}`, lang);
    return speakAndListen(cfg, `${VOICE[lang].nothing} ${VOICE[lang].listen}`, lang, p.turn, p.empty + 1);
  }
  if (BYE.test(text) && text.split(/\s+/).length <= 6) return speakAndHangup(VOICE[lang].bye, lang);
  const r = await assistant.reply({ callSid: p.callSid, from: p.from, text, turn: p.turn });
  if (r.hangup || p.turn >= MAX_TURNS) return speakAndHangup(`${r.say} ${VOICE[r.lang].bye}`, r.lang);
  return speakAndListen(cfg, r.say, r.lang, p.turn + 1, 0, r.hints);
}
