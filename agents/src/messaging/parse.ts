// Parser for the compact text format shared by SMS and Meshtastic:
//   PL SOS 32.78,-96.80 2ppl insulin
//   PL OK
//   PL HELP <free text>
// Optional "#<personId>" anywhere after the verb names the person (used from mesh radios and
// shared phones). Anything without the "PL" prefix is free text.

export type ParsedMessage =
  | {
      kind: "sos";
      lat?: number;
      lng?: number;
      people?: number;
      personId?: number;
      note: string;
    }
  | { kind: "ok"; personId?: number; note: string }
  | { kind: "help"; personId?: number; note: string }
  | { kind: "free"; text: string }
  | { kind: "malformed"; text: string; reason: string };

const COORD = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/;
const PEOPLE = /\b(\d{1,3})\s*(?:ppl|people|persons?|personas?)\b/i;
const PERSON_ID = /#(\d+)\b/;

const SOS_WORDS = new Set(["sos", "auxilio", "socorro", "emergencia"]);
const OK_WORDS = new Set(["ok", "okay", "safe", "bien", "seguro", "segura"]);
const HELP_WORDS = new Set(["help", "ayuda"]);

export function parseMessage(raw: string): ParsedMessage {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { kind: "malformed", text: raw, reason: "empty message" };

  const prefix = /^pl\b[\s:.-]*/i.exec(text);
  if (!prefix) return { kind: "free", text };

  let rest = text.slice(prefix[0].length);
  const verbMatch = /^(\S+)\s*/.exec(rest);
  if (!verbMatch) return { kind: "malformed", text, reason: "missing command after PL" };
  const verb = verbMatch[1].toLowerCase();
  rest = rest.slice(verbMatch[0].length);

  let personId: number | undefined;
  const pid = PERSON_ID.exec(rest);
  if (pid) {
    personId = Number(pid[1]);
    rest = (rest.slice(0, pid.index) + rest.slice(pid.index + pid[0].length)).replace(/\s+/g, " ").trim();
  }

  if (SOS_WORDS.has(verb)) {
    let lat: number | undefined;
    let lng: number | undefined;
    const c = COORD.exec(rest);
    if (c) {
      const a = Number(c[1]);
      const b = Number(c[2]);
      if (Math.abs(a) > 90 || Math.abs(b) > 180) {
        return { kind: "malformed", text, reason: "coordinates out of range" };
      }
      lat = a;
      lng = b;
      rest = (rest.slice(0, c.index) + rest.slice(c.index + c[0].length)).trim();
    } else if (/\d+\.\d+/.test(rest) && /,/.test(rest.split(" ")[0] ?? "")) {
      return { kind: "malformed", text, reason: "could not read coordinates" };
    }
    let people: number | undefined;
    const p = PEOPLE.exec(rest);
    if (p) people = Number(p[1]);
    return { kind: "sos", lat, lng, people, personId, note: rest.trim() };
  }
  if (OK_WORDS.has(verb)) return { kind: "ok", personId, note: rest.trim() };
  if (HELP_WORDS.has(verb)) {
    if (!rest.trim()) return { kind: "malformed", text, reason: "HELP needs a description" };
    return { kind: "help", personId, note: rest.trim() };
  }
  return { kind: "malformed", text, reason: `unknown command "${verbMatch[1]}"` };
}

/** Human-readable message stored on the sos_event. */
export function sosMessage(p: Extract<ParsedMessage, { kind: "sos" | "help" }>): string {
  if (p.kind === "help") return p.note;
  const note = p.note.replace(PEOPLE, "").replace(/\s+/g, " ").trim();
  let msg = "SOS";
  if (p.people) msg += ` (${p.people} people)`;
  if (note) msg += `: ${note}`;
  return msg;
}
