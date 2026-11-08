import { latLngToCell, polygonToCells } from 'h3-js';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const H3_RES = 9;
export const USER_AGENT = 'FirstLine-HackUTD (github.com/Spikestar05/FirstLine)';

/** Dallas-area bounding box (lng/lat) used to scope queries. */
export const DALLAS_BBOX = { west: -97.05, south: 32.55, east: -96.46, north: 33.03 };
export const DALLAS_CENTER = { lat: 32.7767, lng: -96.797 };

export function pointCell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, H3_RES);
}

type Ring = number[][];
interface GeoJsonGeometry { type: string; coordinates: any }

/**
 * Cells covering a GeoJSON Polygon / MultiPolygon (coordinates in [lng, lat]).
 * Small polygons that contain no cell center fall back to the cell of their first vertex.
 */
export function geometryCells(geom: GeoJsonGeometry | null | undefined): string[] {
  if (!geom) return [];
  if (geom.type === 'Point') return [pointCell(geom.coordinates[1], geom.coordinates[0])];
  const polys: Ring[][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const out = new Set<string>();
  for (const rings of polys) {
    const cells = polygonToCells(rings, H3_RES, true);
    if (cells.length === 0 && rings[0]?.[0]) out.add(pointCell(rings[0][0][1], rings[0][0][0]));
    for (const c of cells) out.add(c);
  }
  return [...out];
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Start of the current UTC day (or hour) as ISO, for static feeds that should land once per period. */
export function periodStart(unit: 'day' | 'hour', now = new Date()): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  if (unit === 'day') d.setUTCHours(0);
  return d.toISOString();
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Convert a wall-clock time in America/Chicago to an ISO UTC string. */
export function chicagoToIso(date: string, time: string): string {
  const [y, mo, d] = date.slice(0, 10).split('-').map(Number);
  const [h, mi, s] = (time || '00:00:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // Offset of Chicago at that instant; iterate twice to settle around DST edges.
  let utc = guess;
  for (let i = 0; i < 2; i++) utc = guess - tzOffsetMs(utc, 'America/Chicago');
  return new Date(utc).toISOString();
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

export async function getJson<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 30_000, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(headers as Record<string, string>) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.split('?')[0]}`);
  return (await res.json()) as T;
}

export const CACHE_DIR = process.env.FEEDS_CACHE_DIR || join(tmpdir(), 'firstline-feeds-cache');

/** Read a JSON cache file if younger than maxAgeMs, else call load() and write it. */
export async function cachedJson<T>(name: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const path = join(CACHE_DIR, name);
  try {
    const st = await stat(path);
    if (Date.now() - st.mtimeMs < maxAgeMs) return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch { /* no cache yet */ }
  const data = await load();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data));
  return data;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
