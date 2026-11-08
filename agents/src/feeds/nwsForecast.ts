import type { Feed, FeedEvent } from './types.js';
import { DALLAS_CENTER, getJson, pointCell, toNum, MIN } from './util.js';

/** NWS hourly forecast via /points. Docs: https://www.weather.gov/documentation/services-web-api */
export function pointsUrl(lat = DALLAS_CENTER.lat, lng = DALLAS_CENTER.lng): string {
  return `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/** One event per poll: the next `hours` hourly periods for the point's cell. */
export function normalizeNwsHourly(raw: any, lat = DALLAS_CENTER.lat, lng = DALLAS_CENTER.lng, hours = 12): FeedEvent[] {
  const p = raw?.properties;
  const periods: any[] = p?.periods ?? [];
  if (!periods.length) return [];
  const slim = periods.slice(0, hours).map((x) => ({
    start: x.startTime,
    temp_f: x.temperatureUnit === 'C' ? Math.round((x.temperature * 9) / 5 + 32) : x.temperature,
    precip_pct: toNum(x.probabilityOfPrecipitation?.value),
    wind: x.windSpeed,
    short: x.shortForecast,
  }));
  const temps = slim.map((s) => s.temp_f).filter((t): t is number => typeof t === 'number');
  return [{
    source: 'nws_forecast',
    kind: 'hourly_forecast',
    time: new Date(p.generatedAt ?? p.updateTime ?? periods[0].startTime).toISOString(),
    h3_cells: [pointCell(lat, lng)],
    payload: {
      headline: `next ${slim.length} h: ${Math.min(...temps)}-${Math.max(...temps)}°F, ${slim[0].short}`,
      min_temp_f: Math.min(...temps),
      max_temp_f: Math.max(...temps),
      lat, lng,
      periods: slim,
    },
  }];
}

export async function fetchNwsForecast(lat = DALLAS_CENTER.lat, lng = DALLAS_CENTER.lng): Promise<FeedEvent[]> {
  const point = await getJson(pointsUrl(lat, lng), { headers: { Accept: 'application/geo+json' } });
  const url = point?.properties?.forecastHourly;
  if (!url) throw new Error('NWS /points returned no forecastHourly URL');
  // Only follow links back to the NWS API (never to a host named in a response body).
  if (new URL(url).origin !== 'https://api.weather.gov') throw new Error('NWS forecastHourly URL is not on api.weather.gov');
  return normalizeNwsHourly(await getJson(url, { headers: { Accept: 'application/geo+json' } }), lat, lng);
}

export const nwsForecastFeed: Feed = { name: 'nws_forecast', intervalMs: 30 * MIN, fetch: () => fetchNwsForecast() };
