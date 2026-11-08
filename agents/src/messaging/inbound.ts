// Channel-independent handling of one inbound text (SMS or mesh). Turns a parsed message into
// press_sos / check_in calls and returns a short reply to send back on the same channel.

import { parseMessage, sosMessage, type ParsedMessage } from "./parse.js";
import type { ChannelPerson, ChannelStore } from "./store.js";

/** person_id used when the sender is not registered (contract has no nullable person_id). */
export const UNKNOWN_PERSON_ID = 0;

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
  const personId = ("personId" in parsed && parsed.personId) || msg.person?.id;

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
          reply: `Porchlight could not read that (${parsed.reason}). Send "PL SOS lat,lng note", "PL OK" or "PL HELP what you need".`,
        },
      };

    case "ok": {
      if (!personId) {
        return { parsed, outcome: { action: "rejected", reply: "Porchlight: this number is not registered. Add #<your id> or text PL SOS if you need help." } };
      }
      await store.checkIn({
        clientId: msg.clientId,
        personId,
        kind: msg.channel,
        result: "safe",
        note: parsed.note,
      });
      return { parsed, outcome: { action: "check_in", personId, reply: "Porchlight: marked you safe. Thank you." } };
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
            reply: 'Porchlight: we do not know this number. If you need help, text "PL SOS lat,lng what you need".',
          },
        };
      }
      const loc = location(parsed);
      const pid = personId || UNKNOWN_PERSON_ID;
      const message = parsed.kind === "free" ? parsed.text : sosMessage(parsed);
      await store.pressSos({
        clientId: msg.clientId,
        personId: pid,
        message,
        lat: loc?.lat ?? 0,
        lng: loc?.lng ?? 0,
        channel: msg.channel,
      });
      const where = loc ? "" : " We have no location for you: reply with PL SOS lat,lng if you can.";
      return {
        parsed,
        outcome: { action: "sos", personId: pid, reply: `Porchlight: help request received. Neighbors are being alerted.${where}` },
      };
    }
  }
}
