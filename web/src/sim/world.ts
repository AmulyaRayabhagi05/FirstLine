// The simulated city used for demos: layout (river, roads, communities, anchors),
// households, and an overnight flash-flood timeline for each household.
// Everything here is deterministic (seeded), so every demo run looks the same.

export type Status = 'p1' | 'p2' | 'unknown' | 'enroute' | 'safe' | 'normal';
export type Pt = [number, number];

export const CITY_R = 110; // radius of the interactive city: room for ~2,300 homes, so 2,000+ households each get one
export const W = 2 * (CITY_R + 12); // size of the detailed city ground, in world units
export const HALF = W / 2;
export const FAR = 210; // the outer city runs to here, fading into haze
export const DANGER_W = 6; // flood danger band half-width around the river: the riverbank rows only (13 swept in houses ~2.6 km away)

let seed = 20261108;
export function rnd(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function polyline(fn: (s: number) => number, from: number, to: number, step: number, swap = false): Pt[] {
  const pts: Pt[] = [];
  for (let s = from; s <= to; s += step) {
    const v = fn(s);
    pts.push(swap ? [v, s] : [s, v]);
  }
  return pts;
}

export const river = polyline((x) => 11 * Math.sin(x / 15) + x * 0.22 - 4, -FAR, FAR, 2);
export const roads: Pt[][] = [
  polyline((x) => 0.35 * x + 18 * Math.sin(x / 22) + 22, -FAR, FAR, 2),
  polyline((z) => 12 * Math.sin(z / 18) - 18, -FAR, FAR, 2, true),
  polyline((z) => 0.4 * z + 30 + 6 * Math.sin(z / 12), -FAR, FAR, 2, true),
  polyline((x) => -0.25 * x - 38 + 7 * Math.sin(x / 10), -FAR, FAR, 2),
];
{
  const ring: Pt[] = [];
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.06) ring.push([Math.cos(a) * 50, Math.sin(a) * 50]);
  roads.push(ring);
}
export const streets: Pt[][] = [];
for (let k = -7; k <= 7; k++) {
  streets.push(polyline((x) => k * 29 + 7 * Math.sin(x / 17 + k), -FAR, FAR, 3));
  streets.push(polyline((z) => k * 31 + 8 * Math.sin(z / 19 + k * 2), -FAR, FAR, 3, true));
}

export function distPL(pl: Pt[], x: number, z: number): number {
  let d = 1e9;
  for (let i = 0; i < pl.length - 1; i++) {
    const [ax, az] = pl[i];
    const [bx, bz] = pl[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    let t = ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1);
    t = clamp(t, 0, 1);
    d = Math.min(d, Math.hypot(ax + vx * t - x, az + vz * t - z));
  }
  return d;
}

// Fast clearance mask: homes never sit on a road, a street or the river.
const blocked = new Set<string>();
function mark(pls: Pt[][], clear: number) {
  const r = Math.ceil(clear);
  for (const pl of pls)
    for (let i = 0; i < pl.length - 1; i++) {
      const [ax, az] = pl[i];
      const [bx, bz] = pl[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.8));
      for (let j = 0; j <= n; j++) {
        const x = ax + ((bx - ax) * j) / n;
        const z = az + ((bz - az) * j) / n;
        for (let dx = -r; dx <= r; dx++)
          for (let dz = -r; dz <= r; dz++)
            if (dx * dx + dz * dz <= clear * clear) blocked.add(`${Math.round(x) + dx},${Math.round(z) + dz}`);
      }
    }
}
mark(roads, 2.4);
mark(streets, 1.7);
mark([river], 4.2);
const isBlocked = (x: number, z: number) => blocked.has(`${Math.round(x)},${Math.round(z)}`);

export const PARKS = [
  { x: 24, z: -30, r: 7 },
  { x: -36, z: 24, r: 6 },
  { x: 6, z: 42, r: 5 },
  { x: -14, z: -48, r: 5 },
];
// Real Dallas geography. The live data comes from households in five Dallas neighborhoods
// (bounding boxes in sim/src/data.ts); project() maps lat/lng onto the city disk, north up,
// at 5 world units per km, centered on the middle of those neighborhoods.
const LAT0 = 32.7845;
const LNG0 = -96.7805;
const UNITS_PER_KM = 5;
const KM_PER_DEG_LAT = 111.0;
const KM_PER_DEG_LNG = 111.32 * Math.cos((LAT0 * Math.PI) / 180);
export function project(lat: number, lng: number): { x: number; z: number } {
  return { x: (lng - LNG0) * KM_PER_DEG_LNG * UNITS_PER_KM, z: -(lat - LAT0) * KM_PER_DEG_LAT * UNITS_PER_KM };
}
export const DALLAS_NEIGHBORHOODS = [
  { name: 'North Oak Cliff', lat: 32.743, lng: -96.835, c: '#e8283d' },
  { name: 'Pleasant Grove', lat: 32.707, lng: -96.695, c: '#62d6e8' },
  { name: 'Lakewood', lat: 32.818, lng: -96.75, c: '#f4d35e' },
  { name: 'Vickery Meadow', lat: 32.8685, lng: -96.764, c: '#c9b27a' },
  { name: 'West Dallas', lat: 32.7805, lng: -96.8725, c: '#ff9a3c' },
];
export const COMMS = DALLAS_NEIGHBORHOODS.map((n) => ({ name: n.name, ...project(n.lat, n.lng), c: n.c }));
export type Anchor = { type: 'hospital' | 'shelter'; label: string; x: number; z: number };
export const ANCHORS: Anchor[] = [
  { type: 'hospital', label: 'Hospital · ER open', x: 30, z: -14 },
  { type: 'hospital', label: 'Hospital · ER open', x: -40, z: 6 },
  { type: 'shelter', label: 'Shelter · 140 beds', x: -8, z: -31 },
  { type: 'shelter', label: 'Warming center · pets ok', x: 42, z: 33 },
];
const nearComm = (x: number, z: number) => {
  let b = 0;
  let bd = 1e9;
  COMMS.forEach((c, k) => {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < bd) {
      bd = d;
      b = k;
    }
  });
  return b;
};

// A home is map furniture: a footprint on the city disk. Who lives there, and their status,
// comes from SpacetimeDB (see ../data/live.ts), never from this file.
export interface Home {
  id: number;
  idx: number;
  x: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  wall: string;
  roof: string;
  comm: number;
  danger: boolean;
  riverKm: string;
  net: Home[];
  top: number;
}
export interface OuterHome { x: number; z: number; rot: number; sx: number; sy: number; wall: string; roof: string }

const WALLS = ['#ffffff', '#e9f0ff', '#f2ece0', '#e3f0ea', '#efe6ee', '#dfe6f5'];
const ROOFS = ['#262d2f', '#2d2925', '#1f2b2b', '#2b2d31', '#30302b', '#22292c'];

export const homes: Home[] = [];
const S = 3.0;
for (let gx = -CITY_R; gx <= CITY_R; gx += S)
  for (let gz = -CITY_R; gz <= CITY_R; gz += S) {
    const x = gx + (rnd() - 0.5) * 0.8;
    const z = gz + (rnd() - 0.5) * 0.8;
    if (Math.hypot(x, z) > CITY_R - rnd() * 6) continue;
    if (isBlocked(x, z)) continue;
    if (PARKS.some((p) => Math.hypot(p.x - x, p.z - z) < p.r)) continue;
    if (ANCHORS.some((a) => Math.hypot(a.x - x, a.z - z) < 4.4)) continue;
    if (rnd() < 0.08) continue;
    const sy = 0.85 + rnd() * 0.5;
    homes.push({
      id: 1000 + homes.length,
      idx: homes.length,
      x,
      z,
      rot: (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.3,
      sx: 0.85 + rnd() * 0.4,
      sy,
      wall: pick(WALLS),
      roof: pick(ROOFS),
      comm: nearComm(x, z),
      danger: distPL(river, x, z) < DANGER_W,
      riverKm: (distPL(river, x, z) / UNITS_PER_KM).toFixed(1),
      net: [],
      top: (1.25 + 0.95) * sy,
    });
  }

export const outerHomes: OuterHome[] = [];
for (let gx = -FAR; gx <= FAR; gx += 4.4)
  for (let gz = -FAR; gz <= FAR; gz += 4.4) {
    const x = gx + (rnd() - 0.5) * 1.2;
    const z = gz + (rnd() - 0.5) * 1.2;
    const r = Math.hypot(x, z);
    if (r < CITY_R + 2 || r > FAR || isBlocked(x, z) || rnd() < 0.18) continue;
    outerHomes.push({ x, z, rot: (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.3, sx: 0.85 + rnd() * 0.5, sy: 0.8 + rnd() * 0.7, wall: pick(WALLS), roof: pick(ROOFS) });
  }

// Nearest three homes: the arcs drawn for a household's safety net on the map.
for (const p of homes)
  p.net = homes
    .filter((o) => o !== p && Math.abs(o.x - p.x) < 11 && Math.abs(o.z - p.z) < 11)
    .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
    .slice(0, 3);

/** 24-hour clock for a Date or a millisecond timestamp, local time. */
export const fmtTime = (d: Date | number) => {
  const x = typeof d === 'number' ? new Date(d) : d;
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
};
