import type { Feed, FeedEvent } from './types.js';
import { DALLAS_BBOX, getJson, pointCell, toNum, MIN } from './util.js';

/** Open-Meteo current conditions on a 3x3 grid over Dallas (no key). Docs: https://open-meteo.com/en/docs */
export function meteoGrid(n = 3, bbox = DALLAS_BBOX): Array<{ lat: number; lng: number }> {
  const pts: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      pts.push({
        lat: +(bbox.south + ((i + 0.5) * (bbox.north - bbox.south)) / n).toFixed(4),
        lng: +(bbox.west + ((j + 0.5) * (bbox.east - bbox.west)) / n).toFixed(4),
      });
  return pts;
}

export function openMeteoUrl(points = meteoGrid()): string {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    current: 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'GMT',
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

/** Accepts one location object or the array Open-Meteo returns for multiple coordinates. */
export function normalizeOpenMeteo(raw: any): FeedEvent[] {
  const locs: any[] = Array.isArray(raw) ? raw : [raw];
  const out: FeedEvent[] = [];
  for (const l of locs) {
    const c = l?.current;
    if (!c || typeof l.latitude !== 'number') continue;
    // `current.time` is wall-clock in the response timezone; utc_offset_seconds converts it back to UTC.
    const t = Date.parse(`${c.time}Z`) - (l.utc_offset_seconds ?? 0) * 1000;
    out.push({
      source: 'open_meteo',
      kind: 'weather_current',
      time: new Date(t).toISOString(),
      h3_cells: [pointCell(l.latitude, l.longitude)],
      payload: {
        temp_f: toNum(c.temperature_2m),
        feels_like_f: toNum(c.apparent_temperature),
        precip: toNum(c.precipitation),
        wind_mph: toNum(c.wind_speed_10m),
        gust_mph: toNum(c.wind_gusts_10m),
        weather_code: toNum(c.weather_code),
        lat: l.latitude,
        lng: l.longitude,
      },
    });
  }
  return out;
}

export async function fetchOpenMeteo(): Promise<FeedEvent[]> {
  return normalizeOpenMeteo(await getJson(openMeteoUrl()));
}

export const openMeteoFeed: Feed = { name: 'open_meteo', intervalMs: 15 * MIN, fetch: fetchOpenMeteo };
