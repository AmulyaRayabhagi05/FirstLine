import type { Feed, FeedEvent } from './types.js';
import { cachedJson, geometryCells, getJson, slug, DAY, MIN } from './util.js';

/** NWS active alerts for Dallas County. Docs: https://www.weather.gov/documentation/services-web-api */
export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?area=TX';
/** Dallas County SAME (FIPS) code and the NWS zones that cover it. */
export const DALLAS_SAME = ['048113'];
export const DALLAS_ZONES = ['TXC113', 'TXZ119'];

type Geometry = { type: string; coordinates: any } | null;

export interface NwsAlertOptions {
  sameCodes?: string[];
  zoneIds?: string[];
  /** zone id -> zone geometry, used when an alert has no polygon of its own */
  zoneGeometry?: Record<string, Geometry>;
}

const zoneId = (url: string) => url.split('/').pop()!;

/** Zone ids this alert needs geometry for (it has no polygon and touches our zones). */
export function zonesNeeded(raw: any, opts: NwsAlertOptions = {}): string[] {
  const sameCodes = opts.sameCodes ?? DALLAS_SAME;
  const zoneIds = opts.zoneIds ?? DALLAS_ZONES;
  const need = new Set<string>();
  for (const f of raw?.features ?? []) {
    const p = f.properties ?? {};
    if (f.geometry || !(p.geocode?.SAME ?? []).some((c: string) => sameCodes.includes(c))) continue;
    for (const z of (p.affectedZones ?? []).map(zoneId)) if (zoneIds.includes(z)) { need.add(z); break; }
  }
  return [...need];
}

export function normalizeNwsAlerts(raw: any, opts: NwsAlertOptions = {}): FeedEvent[] {
  const sameCodes = opts.sameCodes ?? DALLAS_SAME;
  const zoneIds = opts.zoneIds ?? DALLAS_ZONES;
  const out: FeedEvent[] = [];
  for (const f of raw?.features ?? []) {
    const p = f.properties ?? {};
    if (!(p.geocode?.SAME ?? []).some((c: string) => sameCodes.includes(c))) continue;
    if (p.status && p.status !== 'Actual') continue;
    let cells = geometryCells(f.geometry);
    let mapped = 'alert_polygon';
    if (cells.length === 0) {
      const z = (p.affectedZones ?? []).map(zoneId).find((id: string) => zoneIds.includes(id) && opts.zoneGeometry?.[id]);
      if (z) { cells = geometryCells(opts.zoneGeometry![z]); mapped = `zone:${z}`; }
    }
    if (cells.length === 0) continue;
    out.push({
      source: 'nws_alerts',
      kind: slug(p.event ?? 'alert'),
      time: new Date(p.sent ?? p.effective ?? Date.now()).toISOString(),
      h3_cells: cells,
      payload: {
        id: p.id,
        event: p.event,
        headline: p.headline,
        severity: p.severity,
        urgency: p.urgency,
        certainty: p.certainty,
        alert_level: p.event,
        area: p.areaDesc,
        onset: p.onset,
        expires: p.ends ?? p.expires,
        instruction: typeof p.instruction === 'string' ? p.instruction.slice(0, 600) : null,
        mapped_by: mapped,
      },
    });
  }
  return out;
}

export async function fetchNwsAlerts(): Promise<FeedEvent[]> {
  const raw = await getJson(NWS_ALERTS_URL, { headers: { Accept: 'application/geo+json' } });
  const zoneGeometry: Record<string, Geometry> = {};
  for (const z of zonesNeeded(raw)) {
    const type = z[2] === 'C' ? 'county' : 'forecast';
    zoneGeometry[z] = await cachedJson(`nws_zone_${z}.json`, 7 * DAY, async () =>
      (await getJson(`https://api.weather.gov/zones/${type}/${z}`, { headers: { Accept: 'application/geo+json' } })).geometry,
    );
  }
  return normalizeNwsAlerts(raw, { zoneGeometry });
}

export const nwsAlertsFeed: Feed = { name: 'nws_alerts', intervalMs: 2 * MIN, fetch: fetchNwsAlerts };
