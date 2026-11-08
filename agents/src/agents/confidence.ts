// Evidence-based confidence. Small models report a confident-sounding number (Nemotron Nano said
// 0.90 or 0.95 on every one of 203 live triages), so the number we save and show is computed here
// from checks we can verify. The model's own number is one small input.
//
// Each factor says what was checked, whether it held, and how much it moved the score, so the
// reasoning panel can show exactly why a decision is or isn't trusted.

import { LOW_TEMP_F } from "../priority.js";
import type { Priority, Signal } from "../store/types.js";

export interface Factor {
  /** Plain-language check, e.g. "keyword rules agree on P1". */
  label: string;
  ok: boolean;
  /** Signed change this factor made to the score. */
  delta: number;
}

export interface Confidence {
  value: number;
  factors: Factor[];
  /** One line for the agent log, e.g. "Confidence 0.80 from evidence: ✓ ... · ✗ ...". */
  summary: string;
}

/** How much of the final number is the model's own guess. */
export const SELF_REPORT_WEIGHT = 0.15;
const MIN = 0.05;
const MAX = 0.98;

const round2 = (n: number) => Math.round(n * 100) / 100;

function finish(base: number, factors: Factor[], selfReported?: number): Confidence {
  const evidence = Math.min(MAX, Math.max(MIN, base + factors.reduce((s, f) => s + f.delta, 0)));
  const blended = selfReported === undefined ? evidence : (1 - SELF_REPORT_WEIGHT) * evidence + SELF_REPORT_WEIGHT * selfReported;
  const value = round2(Math.min(MAX, Math.max(MIN, blended)));
  const parts = factors.map((f) => `${f.ok ? "✓" : "✗"} ${f.label}`);
  if (selfReported !== undefined) parts.push(`model said ${round2(selfReported)} (counts ${Math.round(SELF_REPORT_WEIGHT * 100)}%)`);
  return { value, factors, summary: `Confidence ${value.toFixed(2)} from evidence: ${parts.join(" · ")}` };
}

const cited = (reason: string) => [...reason.matchAll(/\[([a-z0-9][a-z0-9-]*)\]/gi)].map((m) => m[1]!.toLowerCase());

/** Signals that corroborate trouble at the home: power out, phone offline, a cold home, no motion. */
export function corroboratingSignals(signals: Pick<Signal, "kind" | "value">[]): string[] {
  const kinds = new Set<string>();
  for (const s of signals) {
    if (s.kind === "low_temp" && !(s.value < LOW_TEMP_F)) continue;
    kinds.add(s.kind.replace(/_/g, " "));
  }
  return [...kinds];
}

export interface TriageEvidence {
  /** Priority the model chose (before any safety floor). */
  modelPriority: Priority;
  /** What the keyword rules say for the same message and profile. */
  rules: { priority: Priority; whys: string[] };
  /** The safety floor had to raise the model's answer to P1. */
  raisedBySafetyFloor: boolean;
  /** The model's reason text (card ids are cited in brackets). */
  reason: string;
  /** Card ids lookup_protocol actually returned in this run. */
  retrievedCardIds: Set<string>;
  readProfile: boolean;
  message: string;
  signals: Pick<Signal, "kind" | "value">[];
  weatherAlert?: string;
  selfReported?: number;
}

export function triageConfidence(e: TriageEvidence): Confidence {
  const f: Factor[] = [];
  if (e.raisedBySafetyFloor) {
    f.push({ label: `model said ${e.modelPriority} but the rules saw a life threat`, ok: false, delta: -0.3 });
  } else if (e.rules.priority === e.modelPriority) {
    f.push({ label: `keyword rules agree on ${e.modelPriority}`, ok: true, delta: 0.2 });
  } else {
    f.push({ label: `keyword rules say ${e.rules.priority}, model said ${e.modelPriority}`, ok: false, delta: -0.2 });
  }

  const ids = cited(e.reason);
  const real = ids.filter((id) => e.retrievedCardIds.has(id));
  const invented = ids.filter((id) => !e.retrievedCardIds.has(id));
  if (invented.length) f.push({ label: `cited ${invented.map((i) => `[${i}]`).join(" ")} was not in what it looked up`, ok: false, delta: -0.15 });
  else if (real.length) f.push({ label: `cited ${real.map((i) => `[${i}]`).join(" ")} from the guidance it looked up`, ok: true, delta: 0.1 });
  else f.push({ label: "no guidance cited", ok: false, delta: -0.1 });

  f.push(e.readProfile ? { label: "read the person's profile", ok: true, delta: 0.05 } : { label: "did not read the profile", ok: false, delta: -0.05 });

  if (e.rules.whys.length) f.push({ label: `danger signs in the message: ${e.rules.whys.slice(0, 2).join(", ")}`, ok: true, delta: 0.1 });
  else f.push({ label: "no clear danger signs in the message", ok: false, delta: -0.1 });
  if (e.message.trim().length < 15) f.push({ label: "very short message", ok: false, delta: -0.1 });

  const sig = corroboratingSignals(e.signals);
  const backup = [...sig, ...(e.weatherAlert ? [`weather alert`] : [])];
  if (backup.length) f.push({ label: `backed by ${backup.slice(0, 3).join(", ")}`, ok: true, delta: 0.1 });
  else f.push({ label: "no sensor or weather data to back it up", ok: false, delta: -0.05 });

  return finish(0.4, f, e.selfReported);
}

export interface SilentEvidence {
  signals: Pick<Signal, "kind" | "value" | "createdAt">[];
  checkedSignals: boolean;
  checkedHistory: boolean;
  lastSeen?: Date;
  weatherAlert?: string;
  now: Date;
  selfReported?: number;
}

/** How much evidence the silent-signal review had. Below ASK_HUMAN_BELOW a person checks in on them. */
export function silentConfidence(e: SilentEvidence): Confidence {
  const f: Factor[] = [];
  const sig = corroboratingSignals(e.signals);
  if (sig.length) f.push({ label: `signals: ${sig.join(", ")}`, ok: true, delta: Math.min(0.3, 0.1 * sig.length) });
  else f.push({ label: "no phone or home signals", ok: false, delta: -0.1 });

  const newest = Math.max(...e.signals.map((s) => s.createdAt.getTime()), -Infinity);
  if (Number.isFinite(newest) && e.now.getTime() - newest <= 2 * 3600_000) f.push({ label: "signals from the last 2 hours", ok: true, delta: 0.05 });

  f.push(e.checkedSignals ? { label: "checked the signals", ok: true, delta: 0.1 } : { label: "did not check the signals", ok: false, delta: -0.1 });
  f.push(e.checkedHistory ? { label: "checked the contact history", ok: true, delta: 0.1 } : { label: "did not check the history", ok: false, delta: -0.1 });

  if (!e.lastSeen) f.push({ label: "never heard from", ok: false, delta: -0.05 });
  if (e.weatherAlert) f.push({ label: "weather alert in the area", ok: true, delta: 0.05 });

  return finish(0.3, f, e.selfReported);
}
