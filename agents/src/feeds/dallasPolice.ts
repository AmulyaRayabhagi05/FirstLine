import { readFileSync } from 'node:fs';
import type { Feed, FeedEvent } from './types.js';
import { chicagoToIso, getJson, pointCell, MIN } from './util.js';

/**
 * Dallas Police Active Calls (Socrata 9fxf-t2tr, refreshed every few minutes).
 * Note: the brief named d7e7-envw, which is the 311 Service Requests dataset, not police calls.
 * Calls carry only a block/intersection text, beat and division, no coordinates. We map each call
 * to its beat's centroid (beat polygons from the DPD "Beats3" ArcGIS layer, precomputed into
 * data/dallas_beats.json) and fall back to the division centroid. Address geocoding was skipped:
 * the free Census geocoder does not handle intersections, and a beat centroid is a fair
 * neighborhood-level signal.
 */
export const DALLAS_POLICE_URL = 'https://www.dallasopendata.com/resource/9fxf-t2tr.json?$limit=2000';

type LatLng = { lat: number; lng: number };
const BEATS: Record<string, LatLng & { division: string }> = JSON.parse(
  readFileSync(new URL('./data/dallas_beats.json', import.meta.url), 'utf8'),
);

const DIVISIONS: Record<string, LatLng> = (() => {
  const acc: Record<string, { lat: number; lng: number; n: number }> = {};
  for (const b of Object.values(BEATS)) {
    const a = (acc[b.division] ??= { lat: 0, lng: 0, n: 0 });
    a.lat += b.lat;
    a.lng += b.lng;
    a.n++;
  }
  const out: Record<string, LatLng> = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { lat: a.lat / a.n, lng: a.lng / a.n };
  // Downtown beats (8xx) are not in the beat layer.
  out['CENTRAL BUSINESS DISTRICT'] = { lat: 32.7815, lng: -96.7985 };
  return out;
})();

export function locateCall(beat?: string, division?: string): (LatLng & { located_by: string }) | null {
  const b = beat?.trim();
  if (b && BEATS[b]) return { lat: BEATS[b].lat, lng: BEATS[b].lng, located_by: 'beat_centroid' };
  const d = division?.trim().toUpperCase();
  if (d && DIVISIONS[d]) return { ...DIVISIONS[d], located_by: 'division_centroid' };
  return null;
}

/** One event per incident (the feed has one row per responding unit). */
export function normalizeDallasPolice(raw: any[]): FeedEvent[] {
  const byIncident = new Map<string, { row: any; units: string[] }>();
  for (const r of raw ?? []) {
    const id = r.incident_number ?? `${r.date}-${r.time}-${r.location}`;
    const cur = byIncident.get(id);
    if (cur) {
      if (r.unit_number) cur.units.push(r.unit_number);
      continue;
    }
    byIncident.set(id, { row: r, units: r.unit_number ? [r.unit_number] : [] });
  }
  const out: FeedEvent[] = [];
  for (const [id, { row: r, units }] of byIncident) {
    const loc = locateCall(r.beat, r.division);
    if (!loc || !r.date) continue;
    const nature: string = r.nature_of_call ?? '';
    out.push({
      source: 'dallas_police',
      kind: 'police_call',
      time: chicagoToIso(r.date, r.time),
      h3_cells: [pointCell(loc.lat, loc.lng)],
      payload: {
        id,
        incident_number: id,
        nature_of_call: nature,
        code: nature.split(' - ')[0]?.trim() || null,
        priority: r.priority ? Number(r.priority) : null,
        location: r.location,
        beat: r.beat,
        division: r.division,
        status: r.status,
        units,
        located_by: loc.located_by,
      },
    });
  }
  return out;
}

export async function fetchDallasPolice(): Promise<FeedEvent[]> {
  return normalizeDallasPolice(await getJson<any[]>(DALLAS_POLICE_URL));
}

export const dallasPoliceFeed: Feed = { name: 'dallas_police', intervalMs: 3 * MIN, fetch: fetchDallasPolice };
