import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellToLatLng, getResolution, isValidCell, latLngToCell } from 'h3-js';
import {
  normalizeNwsAlerts, zonesNeeded, normalizeNwsHourly, normalizeFemaShelters, normalizeEmpower,
  normalizeDallasPolice, locateCall, normalizeOsm, normalizeCensus, normalizeOpenMeteo, meteoGrid,
  allFeeds, pointCell, geometryCells, type FeedEvent,
} from '../src/feeds/index.js';
import { chicagoToIso } from '../src/feeds/util.js';
import { createPoller } from '../src/feeds/poller.js';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-08T07:30:00Z');

function expectWellFormed(events: FeedEvent[]) {
  for (const e of events) {
    expect(typeof e.source).toBe('string');
    expect(typeof e.kind).toBe('string');
    expect(Number.isNaN(Date.parse(e.time))).toBe(false);
    expect(e.h3_cells.length).toBeGreaterThan(0);
    // One assertion per event, not per cell: polygon alerts cover thousands of cells.
    const bad = e.h3_cells.filter((c) => !isValidCell(c) || getResolution(c) !== 9);
    expect(bad).toEqual([]);
  }
}

describe('H3 mapping', () => {
  it('maps a Dallas point to a res-9 cell containing it', () => {
    const c = pointCell(32.7767, -96.797);
    expect(c).toBe(latLngToCell(32.7767, -96.797, 9));
    const [lat, lng] = cellToLatLng(c);
    expect(Math.abs(lat - 32.7767)).toBeLessThan(0.01);
    expect(Math.abs(lng - -96.797)).toBeLessThan(0.01);
  });

  it('covers a GeoJSON polygon ([lng, lat]) with res-9 cells', () => {
    // ~1.1 km square downtown: res-9 cells are ~0.1 km2, so expect on the order of 10.
    const square = { type: 'Polygon', coordinates: [[[-96.80, 32.78], [-96.79, 32.78], [-96.79, 32.79], [-96.80, 32.79], [-96.80, 32.78]]] };
    const cells = geometryCells(square);
    expect(cells.length).toBeGreaterThan(5);
    expect(cells.length).toBeLessThan(30);
    expect(cells).toContain(pointCell(32.785, -96.795));
  });

  it('falls back to one cell for a polygon smaller than a cell', () => {
    const tiny = { type: 'Polygon', coordinates: [[[-96.8, 32.78], [-96.7999, 32.78], [-96.7999, 32.7801], [-96.8, 32.78]]] };
    expect(geometryCells(tiny)).toHaveLength(1);
  });

  it('handles MultiPolygon and null geometry', () => {
    const a = [[[-96.80, 32.78], [-96.79, 32.78], [-96.79, 32.79], [-96.80, 32.78]]];
    const b = [[[-96.70, 32.88], [-96.69, 32.88], [-96.69, 32.89], [-96.70, 32.88]]];
    const multi = geometryCells({ type: 'MultiPolygon', coordinates: [a, b] });
    expect(multi.length).toBe(new Set([...geometryCells({ type: 'Polygon', coordinates: a }), ...geometryCells({ type: 'Polygon', coordinates: b })]).size);
    expect(geometryCells(null)).toEqual([]);
  });
});

describe('NWS alerts', () => {
  const raw = fx('nws_alerts_tx.json');

  it('drops alerts outside Dallas County (recorded day had none in 048113)', () => {
    expect(normalizeNwsAlerts(raw)).toEqual([]);
  });

  it('maps polygon alerts for a chosen county to cells', () => {
    const ev = normalizeNwsAlerts(raw, { sameCodes: ['048019'] });
    expect(ev.length).toBeGreaterThan(0);
    expectWellFormed(ev);
    expect(ev[0].source).toBe('nws_alerts');
    expect(ev[0].kind).toBe('flood_advisory');
    expect(ev[0].payload).toMatchObject({ event: 'Flood Advisory', alert_level: 'Flood Advisory', mapped_by: 'alert_polygon' });
    expect(ev[0].payload.expires).toBeTruthy();
  }, 20_000); // ~18k res-9 cells from two county-sized polygons

  it('uses zone geometry for Dallas alerts without a polygon', () => {
    const f = structuredClone(raw.features.find((x: any) => !x.geometry));
    f.properties.geocode = { SAME: ['048113'], UGC: ['TXC113'] };
    f.properties.affectedZones = ['https://api.weather.gov/zones/county/TXC113'];
    f.properties.event = 'Winter Storm Warning';
    const doc = { features: [f] };
    expect(zonesNeeded(doc)).toEqual(['TXC113']);
    const zoneGeometry = { TXC113: { type: 'Polygon', coordinates: [[[-96.80, 32.78], [-96.79, 32.78], [-96.79, 32.79], [-96.80, 32.79], [-96.80, 32.78]]] } };
    const ev = normalizeNwsAlerts(doc, { zoneGeometry });
    expect(ev).toHaveLength(1);
    expectWellFormed(ev);
    expect(ev[0].kind).toBe('winter_storm_warning');
    expect(ev[0].payload.mapped_by).toBe('zone:TXC113');
  });
});

describe('NWS hourly forecast', () => {
  it('summarizes the next hours into one event at the point cell', () => {
    const ev = normalizeNwsHourly(fx('nws_hourly.json'));
    expect(ev).toHaveLength(1);
    expectWellFormed(ev);
    expect(ev[0].h3_cells).toEqual([pointCell(32.7767, -96.797)]);
    expect((ev[0].payload.periods as unknown[]).length).toBe(6);
    expect(ev[0].payload.headline).toMatch(/°F/);
  });

  it('the /points fixture points at an hourly forecast URL', () => {
    expect(fx('nws_points.json').properties.forecastHourly).toMatch(/\/forecast\/hourly$/);
  });
});

describe('FEMA shelters', () => {
  it('normalizes open shelters to point cells, bucketed to the hour', () => {
    const ev = normalizeFemaShelters(fx('fema_shelters.json'), NOW);
    expect(ev.length).toBe(5);
    expectWellFormed(ev);
    expect(ev[0]).toMatchObject({ source: 'fema_shelters', kind: 'shelter_open', time: '2026-11-08T07:00:00.000Z' });
    expect(ev[0].payload.name).toBe('Cibecue Elementary School');
    expect(normalizeFemaShelters(fx('fema_shelters_tx.json'), NOW)).toEqual([]);
  });
});

describe('HHS emPOWER', () => {
  it('spreads ZIP counts over the ZIP cells', () => {
    const ev = normalizeEmpower(fx('empower_dallas.json'), NOW);
    expect(ev).toHaveLength(3);
    expectWellFormed(ev);
    const z = ev.find((e) => e.payload.zip === '75230')!;
    expect(z.payload.power_dependent).toBe(191);
    expect(z.h3_cells.length).toBeGreaterThan(50);
    expect(z.payload.per_cell).toBeCloseTo(191 / z.h3_cells.length, 2);
    expect(z.time).toBe('2026-11-08T00:00:00.000Z');
  });
});

describe('Dallas police active calls', () => {
  const raw = fx('dallas_police.json');

  it('merges unit rows into one event per incident with beat or division location', () => {
    const ev = normalizeDallasPolice(raw);
    const incidents = new Set(raw.map((r: any) => r.incident_number));
    expect(ev.length).toBe(incidents.size);
    expectWellFormed(ev);
    const multi = ev.find((e) => e.payload.incident_number === '26-2007495')!;
    expect(multi.payload.units).toEqual(['L125', 'L114']);
    expect(multi.payload.located_by).toBe('division_centroid'); // beat 813 is downtown, not in the beat layer
    expect(ev.some((e) => e.payload.located_by === 'beat_centroid')).toBe(true);
  });

  it('converts Central wall-clock time to UTC', () => {
    expect(chicagoToIso('2026-11-08T00:00:00.000', '00:21:43')).toBe('2026-11-08T06:21:43.000Z'); // CST
    expect(chicagoToIso('2026-07-04T00:00:00.000', '12:00:00')).toBe('2026-07-04T17:00:00.000Z'); // CDT
  });

  it('locates known beats and rejects unknown places', () => {
    expect(locateCall('151', 'Central')?.located_by).toBe('beat_centroid');
    expect(locateCall('999', 'Nowhere')).toBeNull();
  });
});

describe('OSM facilities', () => {
  it('normalizes hospitals and fire stations', () => {
    const ev = normalizeOsm(fx('overpass.json'), NOW);
    expect(ev.length).toBe(fx('overpass.json').elements.length);
    expectWellFormed(ev);
    expect(ev[0]).toMatchObject({ source: 'osm_facilities', kind: 'fire_station' });
    expect(ev[0].payload.name).toBe('Dallas Fire Station Number 30');
  });
});

describe('Census ACS 65+', () => {
  it('joins tract counts to TIGERweb shapes and skips missing values', () => {
    // census_s0101.json is hand-written in the API's format (no key on the recording machine);
    // tiger_tracts.json is a real TIGERweb response.
    const ev = normalizeCensus(fx('census_s0101.json'), fx('tiger_tracts.json'), NOW);
    expect(ev).toHaveLength(1);
    expectWellFormed(ev);
    expect(ev[0].payload).toMatchObject({ geoid: '48113005400', pop_65_plus: 612 });
    expect(ev[0].payload.per_cell).toBeCloseTo(612 / ev[0].h3_cells.length, 1);
  });
});

describe('Open-Meteo', () => {
  it('normalizes multi-point current conditions to UTC times', () => {
    const ev = normalizeOpenMeteo(fx('open_meteo.json'));
    expect(ev).toHaveLength(2);
    expectWellFormed(ev);
    expect(ev[0].time).toBe('2026-11-08T07:00:00.000Z'); // 01:00 at UTC-6
    expect(typeof ev[0].payload.temp_f).toBe('number');
  });

  it('builds a 3x3 grid inside the Dallas box', () => {
    expect(meteoGrid()).toHaveLength(9);
  });
});

describe('poller', () => {
  it('writes events and calls onFeedEvent once per new event, surviving feed errors', async () => {
    const ev: FeedEvent = { source: 'test', kind: 'k', time: NOW.toISOString(), h3_cells: [pointCell(32.78, -96.8)], payload: { id: 'a' } };
    const written: FeedEvent[][] = [];
    const seen: FeedEvent[] = [];
    const poller = createPoller({
      feeds: [
        { name: 'test', intervalMs: 1000, fetch: async () => [ev] },
        { name: 'broken', intervalMs: 1000, fetch: async () => { throw new Error('down'); } },
      ],
      write: async (events) => { written.push(events); return events.length; },
      onFeedEvent: (e) => { seen.push(e); },
      log: () => {},
    });
    const r1 = await poller.runAll();
    await poller.runAll();
    expect(written).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(r1.find((r) => r.feed === 'broken')?.error).toBe('down');
  });

  it('registers all eight feeds with sane intervals', () => {
    expect(allFeeds.map((f) => f.name).sort()).toEqual(
      ['census_acs', 'dallas_police', 'fema_shelters', 'hhs_empower', 'nws_alerts', 'nws_forecast', 'open_meteo', 'osm_facilities'],
    );
    for (const f of allFeeds) expect(f.intervalMs).toBeGreaterThanOrEqual(60_000);
  });
});
