import type { Feed, FeedEvent } from './types.js';
import { DALLAS_BBOX, getJson, periodStart, pointCell, toNum, MIN } from './util.js';

/** FEMA Open Shelters (ArcGIS feature layer, refreshed ~every 20 min by FEMA). */
export const FEMA_SHELTERS_LAYER = 'https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0';

export function femaSheltersUrl(bbox = DALLAS_BBOX): string {
  const q = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outSR: '4326',
    f: 'geojson',
  });
  return `${FEMA_SHELTERS_LAYER}/query?${q}`;
}

/** Shelters have no timestamp of their own: each open shelter lands once per hour it stays open. */
export function normalizeFemaShelters(raw: any, now = new Date()): FeedEvent[] {
  const time = periodStart('hour', now);
  const out: FeedEvent[] = [];
  for (const f of raw?.features ?? []) {
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry?.coordinates ?? [toNum(p.longitude), toNum(p.latitude)];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    out.push({
      source: 'fema_shelters',
      kind: String(p.shelter_status ?? 'open').toLowerCase() === 'open' ? 'shelter_open' : `shelter_${String(p.shelter_status).toLowerCase()}`,
      time,
      h3_cells: [pointCell(lat, lng)],
      payload: {
        id: String(p.shelter_id),
        shelter_id: p.shelter_id,
        name: p.shelter_name,
        address: [p.address, p.city, p.state, p.zip].filter(Boolean).join(', '),
        status: p.shelter_status,
        capacity: toNum(p.evacuation_capacity) ?? toNum(p.post_impact_capacity),
        population: toNum(p.total_population),
        ada: p.ada_compliant,
        pets: p.pet_accommodations_code,
        wheelchair: p.wheelchair_accessible,
        org: p.org_name,
        lat, lng,
      },
    });
  }
  return out;
}

export async function fetchFemaShelters(): Promise<FeedEvent[]> {
  return normalizeFemaShelters(await getJson(femaSheltersUrl()));
}

export const femaSheltersFeed: Feed = { name: 'fema_shelters', intervalMs: 15 * MIN, fetch: fetchFemaShelters };
