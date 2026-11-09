// Where to send a Priority 1 person: a plain rule over a fixed list of real Dallas places
// (safe-places.json, built by scripts/build-safe-places.mjs from OpenStreetMap).
//   Medical (powered device, or oxygen, dialysis, injury, breathing, chest pain... in the profile,
//   SOS or triage) -> the nearest emergency room, backup the next nearest ER.
//   Everyone else (flood, cold, no power) -> the nearest warming site or shelter, backup the next
//   nearest one; the nearest ER is listed too, in case it turns medical. A rescue by professional
//   responders (trapped by water) is not by itself medical: after the rescue they go to shelter.
// web/src/data/direct.ts is the same rule for the printed reports. Keep the two in step.
import { readFileSync } from "node:fs";

export interface SafePlace {
  id: string;
  kind: "er" | "warming";
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  note: string;
}

export interface Directed {
  place: SafePlace;
  km: number;
}

export interface Direction {
  reason: "medical" | "shelter";
  why: string;
  goTo: Directed;
  backup: Directed | null;
  /** The nearest ER, when the person is sent somewhere else. */
  er: Directed | null;
}

export const SAFE_PLACES: SafePlace[] = JSON.parse(readFileSync(new URL("./safe-places.json", import.meta.url), "utf8")).places;

const MEDICAL = /oxygen|dialysis|ventilat|cpap|insulin|breath|chest|bleed|injur|hurt|unconscious|seizure|stroke|heart|fell|fall|broken|carbon monoxide|\bco\b/i;

export function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function nearest(lat: number, lng: number, kind: SafePlace["kind"], places: SafePlace[]): Directed[] {
  return places
    .filter((p) => p.kind === kind)
    .map((place) => ({ place, km: Math.round(km(lat, lng, place.lat, place.lng) * 10) / 10 }))
    .sort((a, b) => a.km - b.km);
}

export interface DirectInput {
  lat: number;
  lng: number;
  poweredDevice?: boolean;
  medicalNeeds?: string;
  /** Triage said professional responders are needed. */
  professional?: boolean;
  /** SOS text and triage reason, checked for medical words. */
  text?: string;
}

export function isMedical(p: DirectInput): boolean {
  return !!p.poweredDevice || MEDICAL.test(`${p.medicalNeeds ?? ""} ${p.text ?? ""}`);
}

export function directTo(p: DirectInput, places: SafePlace[] = SAFE_PLACES): Direction | null {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || (p.lat === 0 && p.lng === 0)) return null;
  const ers = nearest(p.lat, p.lng, "er", places);
  const warm = nearest(p.lat, p.lng, "warming", places);
  if (isMedical(p) && ers.length) {
    const why = p.poweredDevice ? "relies on a powered medical device" : "has a medical need (profile, SOS or triage)";
    return { reason: "medical", why, goTo: ers[0], backup: ers[1] ?? null, er: null };
  }
  if (warm.length) {
    const why = p.professional ? "needs rescue by responders first, then a warm, dry place with power" : "needs a warm, dry place with power";
    return { reason: "shelter", why, goTo: warm[0], backup: warm[1] ?? null, er: ers[0] ?? null };
  }
  return ers.length ? { reason: "medical", why: "no shelter listed nearby", goTo: ers[0], backup: ers[1] ?? null, er: null } : null;
}

/** One line for a briefing: "Take to X (address, 2.1 km); backup Y (3.0 km)". */
export function directionLine(d: Direction): string {
  const at = (x: Directed) => `${x.place.name}${x.place.address ? `, ${x.place.address}` : ""} (${x.km} km)`;
  return `take to ${at(d.goTo)}${d.backup ? `; backup ${at(d.backup)}` : ""}`;
}
