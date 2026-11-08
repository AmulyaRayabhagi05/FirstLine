import type { Feed, FeedEvent } from './types.js';
import { geometryCells, getJson, periodStart, toNum, DAY } from './util.js';

/**
 * HHS emPOWER: Medicare beneficiaries using electricity-dependent equipment, by ZIP.
 * Public ArcGIS service behind https://empowerprogram.hhs.gov/empowermap (layer 1 = ZIP level, all DME).
 */
export const EMPOWER_ZIP_LAYER =
  'https://services2.arcgis.com/ZQ4jTQn6k7VPXEwO/arcgis/rest/services/HHS_emPOWER_REST_Service_Public/FeatureServer/1';

export function empowerUrl(countyFips = '48113'): string {
  const q = new URLSearchParams({
    where: `FIPS_Code='${countyFips}'`,
    outFields: 'Zip_Code,COUNTY,FIPS_Code,Medicare_Benes,Power_Dependent_Devices_DME,O2_Services_Any_DME,Facility_ESRD_Dialysis_Any_DME,Home_Health_Services_Any_DME',
    outSR: '4326',
    geometryPrecision: '5',
    maxAllowableOffset: '0.0005',
    f: 'geojson',
  });
  return `${EMPOWER_ZIP_LAYER}/query?${q}`;
}

/** One event per ZIP, covering the ZIP's res-9 cells. `per_cell` spreads the ZIP count evenly. */
export function normalizeEmpower(raw: any, now = new Date()): FeedEvent[] {
  const time = periodStart('day', now);
  const out: FeedEvent[] = [];
  for (const f of raw?.features ?? []) {
    const p = f.properties ?? {};
    const cells = geometryCells(f.geometry);
    if (!cells.length) continue;
    const dependent = toNum(p.Power_Dependent_Devices_DME);
    out.push({
      source: 'hhs_empower',
      kind: 'empower_zip',
      time,
      h3_cells: cells,
      payload: {
        id: String(p.Zip_Code),
        zip: p.Zip_Code,
        county_fips: p.FIPS_Code,
        medicare_benes: toNum(p.Medicare_Benes),
        power_dependent: dependent,
        oxygen: toNum(p.O2_Services_Any_DME),
        dialysis: toNum(p.Facility_ESRD_Dialysis_Any_DME),
        home_health: toNum(p.Home_Health_Services_Any_DME),
        cells: cells.length,
        per_cell: dependent === null ? null : Math.round((dependent / cells.length) * 1000) / 1000,
      },
    });
  }
  return out;
}

export async function fetchEmpower(): Promise<FeedEvent[]> {
  return normalizeEmpower(await getJson(empowerUrl(), { timeoutMs: 60_000 }));
}

export const hhsEmpowerFeed: Feed = { name: 'hhs_empower', intervalMs: DAY, fetch: fetchEmpower };
