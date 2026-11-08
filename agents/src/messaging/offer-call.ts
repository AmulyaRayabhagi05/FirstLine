// A neighbor offer by phone call: when dispatch offers a visit, the helper's phone rings, a voice
// reads who needs help and how far away, and the helper presses 1 to accept or 2 to decline.
// The keypress goes straight to accept_assignment / decline_assignment, so the map updates live.
// (Calls work where US carriers block unregistered SMS, and need no app.)

import twilio from "twilio";
import type { TwilioConfig, TwilioLike } from "./twilio.js";

export interface OfferCallRequest {
  assignmentId: number;
  phone: string;
  helperName: string;
  personName: string;
  distanceKm: number;
  message: string;
}

export interface OfferHandlers {
  /** Accepts the offer; returns the address to read to the helper. */
  accept(assignmentId: number): Promise<{ address?: string } | void>;
  decline(assignmentId: number): Promise<void>;
}

const VOICE = { voice: "Polly.Joanna", language: "en-US" } as const;

const meters = (km: number) => (km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} meters` : `${km.toFixed(1)} kilometers`);
const first = (name: string) => name.split(/\s+/)[0] ?? name;

function offerUrl(cfg: TwilioConfig, r: { assignmentId: number }, attempt: number) {
  return `${cfg.publicUrl ?? ""}/voice/offer?assignmentId=${r.assignmentId}&attempt=${attempt}`;
}

export function offerTwiml(cfg: TwilioConfig, r: OfferCallRequest, attempt = 0): string {
  const vr = new twilio.twiml.VoiceResponse();
  const g = vr.gather({ input: ["dtmf"], numDigits: 1, timeout: 8, action: offerUrl(cfg, r, attempt), method: "POST" });
  if (attempt === 0) {
    g.say(
      VOICE,
      `Hello ${first(r.helperName)}, this is FirstLine. Your neighbor ${r.personName} needs help, about ${meters(r.distanceKm)} from you. ` +
        (r.message ? `They said: ${r.message.slice(0, 160)}. ` : ""),
    );
  }
  g.say(VOICE, "Press 1 if you can go help now. Press 2 if you can't.");
  vr.redirect({ method: "POST" }, `${offerUrl(cfg, r, attempt)}&noinput=1`);
  return vr.toString();
}

function sayHangup(text: string) {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say(VOICE, text);
  vr.hangup();
  return vr.toString();
}

export async function placeOfferCall(client: TwilioLike, cfg: TwilioConfig, r: OfferCallRequest): Promise<{ callSid: string }> {
  if (!cfg.fromNumber) throw new Error("TWILIO_FROM_NUMBER is not set");
  if (!cfg.publicUrl) throw new Error("PUBLIC_BASE_URL is not set (Twilio must reach /voice/offer)");
  const call = await client.calls.create({ to: r.phone, from: cfg.fromNumber, twiml: offerTwiml(cfg, r), timeout: 25 });
  return { callSid: call.sid };
}

/** The Gather action: 1 accepts, 2 declines, anything else asks once more. */
export async function handleOfferResult(
  handlers: OfferHandlers | undefined,
  cfg: TwilioConfig,
  p: { assignmentId: number; digits?: string; attempt: number; noInput: boolean },
): Promise<string> {
  if (!handlers) return sayHangup("Thank you. Goodbye.");
  const d = p.digits?.trim();
  try {
    if (d === "1") {
      const r = await handlers.accept(p.assignmentId);
      const address = r && r.address ? ` The address is ${r.address}.` : "";
      return sayHangup(`Thank you. You are on the way, and the responders can see it on the map.${address} Stay out of moving water. Goodbye.`);
    }
    if (d === "2") {
      await handlers.decline(p.assignmentId);
      return sayHangup("Okay. We will ask another neighbor right away. Thank you.");
    }
  } catch {
    return sayHangup("This request was already handled by someone else. Thank you for answering. Goodbye.");
  }
  if (p.attempt < 1) {
    const vr = new twilio.twiml.VoiceResponse();
    const g = vr.gather({
      input: ["dtmf"],
      numDigits: 1,
      timeout: 8,
      action: offerUrl(cfg, { assignmentId: p.assignmentId }, p.attempt + 1),
      method: "POST",
    });
    g.say(VOICE, "Sorry, I did not get that. Press 1 if you can go help now. Press 2 if you can't.");
    vr.redirect({ method: "POST" }, `${offerUrl(cfg, { assignmentId: p.assignmentId }, p.attempt + 1)}&noinput=1`);
    return vr.toString();
  }
  return sayHangup("We did not get an answer, so we will ask another neighbor. Goodbye.");
}
