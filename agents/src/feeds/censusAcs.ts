import type { Feed, FeedEvent } from './types.js';
import { cachedJson, geometryCells, getJson, periodStart, toNum, DAY } from './util.js';

/**
 * Census ACS 5-year subject table S0101: people 65+ (S0101_C01_030E) by tract, Dallas County (48/113).
 * Needs CENSUS_API_KEY (free); skipped when unset. Tract shapes come from TIGERweb, cached 30 days.
 * Each tract becomes one event over its res-9 cells; payload.per_cell spreads the 65+ count evenly,
 * which the worker can pass to set_cell_census.
 */
export const ACS_YEAR = 2023;
export const TIGER_TRACTS_LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0';

export function acsUrl(key: string, state = '48', county = '113'): string {
  return `https://api.census.gov/data/${ACS_YEAR}/acs/acs5/subject?get=NAME,S0101_C01_001E,S0101_C01_030E&for=tract:*&in=state:${state}%20county:${county}&key=${encodeURIComponent(key)}`;
}

export function tractsUrl(state = '48', county = '113', offset = 0): string {
  const q = new URLSearchParams({
    where: `STATE='${state}' AND COUNTY='${county}'`,
    outFields: 'GEOID',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: '0.0005',
    resultOffset: String(offset),
    f: 'geojson',
  });
  return `${TIGER_TRACTS_LAYER}/query?${q}`;
}

/** acs: the API's array-of-arrays; tracts: GeoJSON FeatureCollection with GEOID. */
export function normalizeCensus(acs: string[][], tracts: any, now = new Date()): FeedEvent[] {
  const [header, ...rows] = acs ?? [];
  if (!header) return [];
  const ix = (k: string) => header.indexOf(k);
  const shapes = new Map<string, any>();
  for (const f of tracts?.features ?? []) shapes.set(String(f.properties?.GEOID), f.geometry);
  const time = periodStart('day', now);
  const out: FeedEvent[] = [];
  for (const r of rows) {
    const geoid = `${r[ix('state')]}${r[ix('county')]}${r[ix('tract')]}`;
    const total = toNum(r[ix('S0101_C01_001E')]);
    const older = toNum(r[ix('S0101_C01_030E')]);
    if (older === null || older < 0) continue; // Census uses large negative sentinels for missing values
    const cells = geometryCells(shapes.get(geoid));
    if (!cells.length) continue;
    out.push({
      source: 'census_acs',
      kind: 'elderly_estimate',
      time,
      h3_cells: cells,
      payload: {
        id: geoid,
        geoid,
        name: r[ix('NAME')],
        total_pop: total,
        pop_65_plus: older,
        cells: cells.length,
        per_cell: Math.round((older / cells.length) * 100) / 100,
        vintage: `ACS ${ACS_YEAR} 5-year`,
      },
    });
  }
  return out;
}

export async function fetchCensus(key = process.env.CENSUS_API_KEY): Promise<FeedEvent[]> {
  if (!key) {
    console.warn('[feeds] census_acs skipped: CENSUS_API_KEY not set');
    return [];
  }
  const acs = await getJson<string[][]>(acsUrl(key));
  const tracts = await cachedJson('dallas_tracts.json', 30 * DAY, async () => {
    const all: any[] = [];
    for (let offset = 0; offset < 5000; ) {
      const page = await getJson(tractsUrl('48', '113', offset), { timeoutMs: 60_000 });
      all.push(...(page.features ?? []));
      if (!page.features?.length || !(page.exceededTransferLimit || page.properties?.exceededTransferLimit)) break;
      offset += page.features.length;
    }
    return { type: 'FeatureCollection', features: all };
  });
  return normalizeCensus(acs, tracts);
}

export const censusAcsFeed: Feed = { name: 'census_acs', intervalMs: DAY, fetch: () => fetchCensus() };
