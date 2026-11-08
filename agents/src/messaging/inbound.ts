// Channel-independent handling of one inbound text (SMS or mesh). Turns a parsed message into
// press_sos / check_in calls and returns a short reply to send back on the same channel.

import { parseMessage, sosMessage, type ParsedMessage } from "./parse.js";
import type { ChannelPerson, ChannelStore } from "./store.js";

/** person_id used when the sender is not registered (contract has no nullable person_id). */
export const UNKNOWN_PERSON_ID = 0;

/** Longest SOS text / check-in note stored (the reducer refuses over 2000 characters). */
export const MAX_INBOUND_TEXT = 1000;
const clip = (s: string) => (s.length > MAX_INBOUND_TEXT ? `${s.slice(0, MAX_INBOUND_TEXT - 1)}…` : s);

export interface InboundText {
  clientId: string;
  text: string;
  channel: "sms" | "mesh";
  /** Person already resolved from the phone number or mesh node map. */
  person?: ChannelPerson;
  /** Location reported by the channel itself (mesh node position). */
  position?: { lat: number; lng: number };
}

export type InboundOutcome =
  | { action: "sos"; personId: number; reply: string }
  | { action: "check_in"; personId: number; reply: string }
  | { action: "rejected"; reply: string };

export async function handleInboundText(
  store: ChannelStore,
  msg: InboundText,
): Promise<{ parsed: ParsedMessage; outcome: InboundOutcome }> {
  const parsed = parseMessage(msg.text);
  // "#<id>" names a person explicitly (shared phones, mesh radios). The sender's own identity
  // comes from the channel (phone number / node map), which "#<id>" cannot override for a
  // check-in: anyone could otherwise text "FL OK #12" and mark a stranger safe. Naming someone
  // else is allowed only to raise an alarm (SOS / HELP), and the SOS text says so.
  const claimed = "personId" in parsed ? parsed.personId : undefined;
  const own = msg.person?.id;
  const forSomeoneElse = !!claimed && claimed !== own;
  const personId = claimed || own;

  const location = (p: ParsedMessage) => {
    if (p.kind === "sos" && p.lat !== undefined && p.lng !== undefined) return { lat: p.lat, lng: p.lng };
    if (msg.position) return msg.position;
    if (msg.person) return { lat: msg.person.lastLat, lng: msg.person.lastLng };
    return undefined;
  };

  switch (parsed.kind) {
    case "malformed":
      return {
        parsed,
        outcome: {
          action: "rejected",
          reply: `FirstLine could not read that (${parsed.reason}). Send "FL SOS lat,lng note", "FL OK" or "FL HELP what you need".`,
        },
      };

    case "ok": {
      if (forSomeoneElse) {
        return {
          parsed,
          outcome: {
            action: "rejected",
            reply: "FirstLine: you can only mark yourself safe from your own registered phone or radio. A neighbor or responder will confirm others.",
          },
        };
      }
      if (!own) {
        return { parsed, outcome: { action: "rejected", reply: "FirstLine: this number is not registered. Text FL SOS if you need help." } };
      }
      await store.checkIn({
        clientId: msg.clientId,
        personId: own,
        kind: msg.channel,
        result: "safe",
        note: clip(parsed.note),
      });
      return { parsed, outcome: { action: "check_in", personId: own, reply: "FirstLine: marked you safe. Thank you." } };
    }

    case "sos":
    case "help":
    case "free": {
      if (parsed.kind === "free" && !msg.person) {
        // Free text from an unknown number is not an SOS we can place.
        return {
          parsed,
          outcome: {
            action: "rejected",
            reply: 'FirstLine: we do not know this number. If you need help, text "FL SOS lat,lng what you need".',
          },
        };
      }
      const loc = location(parsed);
      const pid = personId || UNKNOWN_PERSON_ID;
      const text = parsed.kind === "free" ? parsed.text : sosMessage(parsed);
      const message = clip(forSomeoneElse ? `${text} [reported for #${claimed} by another ${msg.channel} sender]` : text);
      await store.pressSos({
        clientId: msg.clientId,
        personId: pid,
        message,
        lat: loc?.lat ?? 0,
        lng: loc?.lng ?? 0,
        channel: msg.channel,
      });
      const where = loc ? "" : " We have no location for you: reply with FL SOS lat,lng if you can.";
      return {
        parsed,
        outcome: { action: "sos", personId: pid, reply: `FirstLine: help request received. Neighbors are being alerted.${where}` },
      };
    }
  }
}
