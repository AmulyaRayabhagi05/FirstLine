// Plain-code priority score (docs/contract.md "Priority score"). Every factor carries the
// reason strings that produced it so the UI and agents can explain the number.
//
//   score = vulnerability * exposure * contact_gap_factor
//
// Each part starts at 1.0 (no risk factors) and grows with each factor present.

import type { CheckIn, Person, PriorityCategory, Signal, Triage } from "./store/types.js";

export interface ScorePart {
  value: number;
  reasons: string[];
}

export interface PriorityInput {
  person: Pick<
    Person,
    "age" | "livesAlone" | "mobility" | "medicalNeeds" | "poweredDevice" | "hasSmartphone" | "language" | "status" | "lastSeen"
  >;
  signals?: Pick<Signal, "kind" | "value" | "createdAt">[];
  checkIns?: Pick<CheckIn, "result" | "createdAt">[];
  /** Latest triage for this person, if any (P1 comes only from triage). */
  triage?: Pick<Triage, "priority" | "needs">;
  /** Social vulnerability / emPOWER prior for the cell, 0..1. */
  cellPrior?: number;
  /** Active weather alert level in the cell ("" or undefined if none). */
  weatherAlert?: string;
  /** Home temperature trend in °F per hour (negative = cooling). */
  homeTempTrendFPerHour?: number;
  /** Distance to nearest shelter or ER in km. */
  distanceToShelterKm?: number;
  now?: Date;
}

export interface PriorityResult {
  score: number;
  category: PriorityCategory;
  vulnerability: ScorePart;
  exposure: ScorePart;
  contactGap: ScorePart;
  reasons: string[];
  /** One-line explanation, e.g. "P2 (score 9.8): age 84; lives alone; ...". */
  summary: string;
}

/** Score at or above which an uncontacted person becomes P2. */
export const P2_THRESHOLD = 4;
/** Cold home threshold for a `low_temp` signal value (°F). */
export const LOW_TEMP_F = 60;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function vulnerability(input: PriorityInput): ScorePart {
  const p = input.person;
  let v = 1;
  const reasons: string[] = [];
  if (p.age >= 75) {
    v += 0.6;
    reasons.push(`age ${p.age}`);
  } else if (p.age >= 65) {
    v += 0.3;
    reasons.push(`age ${p.age}`);
  }
  if (p.livesAlone) {
    v += 0.4;
    reasons.push("lives alone");
  }
  const oxygen = /oxygen/i.test(p.medicalNeeds);
  if (p.poweredDevice || oxygen) {
    v += 0.8;
    reasons.push(oxygen ? "depends on oxygen" : "depends on a powered medical device");
  }
  if (p.mobility === "cannot_walk") {
    v += 0.8;
    reasons.push("cannot walk");
  } else if (p.mobility === "limited") {
    v += 0.5;
    reasons.push("limited mobility");
  }
  if (!p.hasSmartphone) {
    v += 0.3;
    reasons.push("no smartphone");
  }
  if (p.language && !/^en/i.test(p.language)) {
    v += 0.2;
    reasons.push(`speaks ${p.language}`);
  }
  if (input.cellPrior && input.cellPrior > 0) {
    const add = 0.5 * Math.min(1, input.cellPrior);
    v += add;
    reasons.push(`high-vulnerability area (prior ${round(input.cellPrior)})`);
  }
  return { value: round(v), reasons };
}

function latestSignal(signals: PriorityInput["signals"], kind: Signal["kind"]) {
  return (signals ?? []).filter((s) => s.kind === kind).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

export function exposure(input: PriorityInput): ScorePart {
  let e = 1;
  const reasons: string[] = [];
  if (input.weatherAlert) {
    e += 0.5;
    reasons.push(`weather alert: ${input.weatherAlert}`);
  }
  const temp = latestSignal(input.signals, "low_temp");
  if (temp && temp.value < LOW_TEMP_F) {
    e += 0.6;
    reasons.push(`home at ${round(temp.value, 0)}°F`);
  }
  if (input.homeTempTrendFPerHour !== undefined && input.homeTempTrendFPerHour <= -1) {
    e += 0.3;
    reasons.push(`home cooling ${round(-input.homeTempTrendFPerHour, 1)}°F/h`);
  }
  if (latestSignal(input.signals, "power_out")) {
    e += 0.6;
    reasons.push("power out");
  }
  if (latestSignal(input.signals, "no_motion")) {
    e += 0.4;
    reasons.push("no motion detected");
  }
  if (input.distanceToShelterKm !== undefined && input.distanceToShelterKm > 5) {
    e += 0.3;
    reasons.push(`${round(input.distanceToShelterKm, 1)} km from shelter/ER`);
  }
  return { value: round(e), reasons };
}

export function contactGap(input: PriorityInput): ScorePart {
  const now = input.now ?? new Date();
  let g = 1;
  const reasons: string[] = [];
  const last = input.person.lastSeen;
  if (last) {
    const hours = Math.max(0, (now.getTime() - last.getTime()) / 3_600_000);
    if (hours >= 1) {
      g += 0.25 * Math.min(hours, 8);
      reasons.push(`no contact for ${round(hours, 1)} h`);
    }
  } else {
    g += 1.5;
    reasons.push("never checked in");
  }
  const failed = (input.checkIns ?? []).filter(
    (c) => c.result === "no_answer" && (!last || c.createdAt.getTime() > last.getTime()),
  ).length;
  if (failed > 0) {
    g += 0.3 * Math.min(failed, 3);
    reasons.push(`${failed} failed contact attempt${failed > 1 ? "s" : ""}`);
  }
  if (latestSignal(input.signals, "phone_offline")) {
    g += 0.3;
    reasons.push("phone offline");
  }
  return { value: round(g), reasons };
}

export function computePriority(input: PriorityInput): PriorityResult {
  const v = vulnerability(input);
  const e = exposure(input);
  const g = contactGap(input);
  const score = round(v.value * e.value * g.value);
  const reasons = [...v.reasons, ...e.reasons, ...g.reasons];

  let category: PriorityCategory;
  if (input.triage?.priority === "P1") category = "P1";
  else if (input.person.status === "safe") category = "safe";
  else if (score >= P2_THRESHOLD && g.value > 1) category = "P2";
  else if (input.triage?.priority === "P3" || input.triage?.priority === "P2") category = input.triage.priority;
  else category = "unknown";

  const summary = `${category} (score ${score}): ${reasons.join("; ") || "no risk factors"}`;
  return { score, category, vulnerability: v, exposure: e, contactGap: g, reasons, summary };
}
