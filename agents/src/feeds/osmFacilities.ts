import type { Feed, FeedEvent } from './types.js';
import { cachedJson, DALLAS_BBOX, getJson, periodStart, pointCell, DAY } from './util.js';

/** OSM hospitals, fire and ambulance stations via Overpass, cached to FEEDS_CACHE_DIR/osm_facilities.json for a week. */
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export function overpassQuery(bbox = DALLAS_BBOX): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:90];(nwr["amenity"="hospital"](${b});nwr["amenity"="fire_station"](${b});nwr["emergency"="ambulance_station"](${b}););out center tags;`;
}

export function normalizeOsm(raw: any, now = new Date()): FeedEvent[] {
  const time = periodStart('day', now);
  const out: FeedEvent[] = [];
  for (const el of raw?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const t = el.tags ?? {};
    const kind = t.amenity === 'hospital' ? 'hospital' : t.amenity === 'fire_station' ? 'fire_station' : 'ambulance_station';
    out.push({
      source: 'osm_facilities',
      kind,
      time,
      h3_cells: [pointCell(lat, lng)],
      payload: {
        osm_id: `${el.type}/${el.id}`,
        name: t.name ?? null,
        emergency: t.emergency ?? null,
        address: [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).join(' ') || null,
        lat,
        lng,
      },
    });
  }
  return out;
}

export async function fetchOsm(): Promise<FeedEvent[]> {
  const raw = await cachedJson('osm_facilities.json', 7 * DAY, () =>
    getJson(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: overpassQuery() }).toString(),
      timeoutMs: 120_000,
    }),
  );
  return normalizeOsm(raw);
}

export const osmFacilitiesFeed: Feed = { name: 'osm_facilities', intervalMs: DAY, fetch: fetchOsm };
