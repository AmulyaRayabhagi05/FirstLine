// Where to send a Priority 1 person, for the printed incident reports. Same rule and same place
// list as the reports agent (agents/src/places/direct.ts); keep the two in step.
//   Medical -> nearest emergency room, backup the next ER.
//   Otherwise -> nearest warming site or shelter, backup the next one, plus the nearest ER.
import data from './safe-places.json';

export interface SafePlace {
  id: string;
  kind: 'er' | 'warming';
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
  reason: 'medical' | 'shelter';
  why: string;
  goTo: Directed;
  backup: Directed | null;
  er: Directed | null;
}

export const SAFE_PLACES = data.places as SafePlace[];
export const SAFE_PLACES_SOURCE = `${data.source}, ${data.built}`;

const MEDICAL = /oxygen|dialysis|ventilat|cpap|insulin|breath|chest|bleed|injur|hurt|unconscious|seizure|stroke|heart|fell|fall|broken|carbon monoxide|\bco\b/i;

const km = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

const nearest = (lat: number, lng: number, kind: SafePlace['kind']): Directed[] =>
  SAFE_PLACES.filter((p) => p.kind === kind)
    .map((place) => ({ place, km: Math.round(km(lat, lng, place.lat, place.lng) * 10) / 10 }))
    .sort((a, b) => a.km - b.km);

export interface DirectInput {
  lat: number;
  lng: number;
  poweredDevice?: boolean;
  medicalNeeds?: string;
  professional?: boolean;
  text?: string;
}

export function directTo(p: DirectInput): Direction | null {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || (p.lat === 0 && p.lng === 0)) return null;
  const ers = nearest(p.lat, p.lng, 'er');
  const warm = nearest(p.lat, p.lng, 'warming');
  // A rescue by responders (trapped by water) is not by itself medical: after it, they go to shelter.
  const medical = !!p.poweredDevice || MEDICAL.test(`${p.medicalNeeds ?? ''} ${p.text ?? ''}`);
  if (medical && ers.length) {
    const why = p.poweredDevice ? 'relies on a powered medical device' : 'has a medical need (profile, SOS or triage)';
    return { reason: 'medical', why, goTo: ers[0], backup: ers[1] ?? null, er: null };
  }
  if (warm.length) {
    const why = p.professional ? 'needs rescue by responders first, then a warm, dry place with power' : 'needs a warm, dry place with power';
    return { reason: 'shelter', why, goTo: warm[0], backup: warm[1] ?? null, er: ers[0] ?? null };
  }
  return ers.length ? { reason: 'medical', why: 'no shelter listed nearby', goTo: ers[0], backup: ers[1] ?? null, er: null } : null;
}

/** A map link to the place only: the person's home location never goes into a URL. */
export const mapsLink = (to: SafePlace) => `https://www.google.com/maps/search/?api=1&query=${to.lat},${to.lng}`;
