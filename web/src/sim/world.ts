// The simulated city used for demos: layout (river, roads, communities, anchors),
// households, and an overnight flash-flood timeline for each household.
// Everything here is deterministic (seeded), so every demo run looks the same.

export type Status = 'p1' | 'p2' | 'unknown' | 'enroute' | 'safe' | 'normal';
export type Pt = [number, number];

export const W = 140; // size of the detailed city ground, in world units
export const HALF = W / 2;
export const CITY_R = 60; // radius of the interactive city
export const FAR = 210; // the outer city runs to here, fading into haze
export const DANGER_W = 13; // flood danger band half-width around the river

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
export const COMMS = [
  { name: 'Oak Cliff', x: -25, z: 32, c: '#e8283d' },
  { name: 'Bishop Arts', x: -47, z: -4, c: '#ff9a3c' },
  { name: 'Kessler Park', x: -30, z: -36, c: '#5aa9ff' },
  { name: 'Cedars', x: 4, z: -12, c: '#b58cff' },
  { name: 'Deep Ellum', x: 32, z: -38, c: '#4fe08f' },
  { name: 'Lakewood', x: 46, z: 8, c: '#f4d35e' },
  { name: 'Pleasant Grove', x: 18, z: 34, c: '#62d6e8' },
];
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

export type TimelineEvent = { t: number; status: Status; agent: string; text: string; conf: string | null };
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
  name: string;
  age: number;
  alone: boolean;
  device: boolean;
  mobility: boolean;
  smart: boolean;
  spanish: boolean;
  vuln: number;
  riverKm: string;
  tHit?: number;
  tPower?: number;
  events: TimelineEvent[];
  net: Home[];
  top: number;
}
export interface OuterHome { x: number; z: number; rot: number; sx: number; sy: number; wall: string; roof: string }

const FIRST = ['Rosa', 'Earl', 'Mae', 'Luis', 'Doris', 'Henry', 'Ana', 'Walter', 'Grace', 'Tomas', 'June', 'Calvin', 'Irene', 'Marcus', 'Lupe', 'Ruth', 'Dale', 'Nora', 'Frank', 'Elena', 'Otis', 'Bea', 'Ray', 'Carmen'];
const CHANNEL = ['app', 'SMS', 'voice call', 'neighbor visit', 'mesh radio'];
const SOS = ['"agua entrando, mi mamá no puede caminar"', '"water at the back door, need help with dad"', '"power out, oxygen machine on battery"', '"car stuck, kids with me, water rising"', '"can\'t get mom down the stairs"'];
const WALLS = ['#ffffff', '#e9f0ff', '#f2ece0', '#e3f0ea', '#efe6ee', '#dfe6f5'];
const ROOFS = ['#1d2540', '#22283f', '#1b2a33', '#2a2236', '#252a2f', '#1a2236'];

export const homes: Home[] = [];
const S = 3.8;
for (let gx = -CITY_R; gx <= CITY_R; gx += S)
  for (let gz = -CITY_R; gz <= CITY_R; gz += S) {
    const x = gx + (rnd() - 0.5) * 0.8;
    const z = gz + (rnd() - 0.5) * 0.8;
    if (Math.hypot(x, z) > CITY_R - rnd() * 6) continue;
    if (isBlocked(x, z)) continue;
    if (PARKS.some((p) => Math.hypot(p.x - x, p.z - z) < p.r)) continue;
    if (ANCHORS.some((a) => Math.hypot(a.x - x, a.z - z) < 4.4)) continue;
    if (rnd() < 0.08) continue;
    const age = rnd() < 0.32 ? 66 + Math.floor(rnd() * 28) : 24 + Math.floor(rnd() * 40);
    const h: Home = {
      id: 1000 + homes.length,
      idx: homes.length,
      x,
      z,
      rot: (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.3,
      sx: 0.85 + rnd() * 0.4,
      sy: 0.85 + rnd() * 0.5,
      wall: pick(WALLS),
      roof: pick(ROOFS),
      comm: nearComm(x, z),
      danger: distPL(river, x, z) < DANGER_W,
      name: pick(FIRST),
      age,
      alone: rnd() < (age > 65 ? 0.5 : 0.2),
      device: rnd() < (age > 65 ? 0.28 : 0.05),
      mobility: rnd() < (age > 65 ? 0.3 : 0.06),
      smart: rnd() < (age > 65 ? 0.62 : 0.95),
      spanish: rnd() < 0.28,
      vuln: 0,
      riverKm: (distPL(river, x, z) * 0.09).toFixed(1),
      events: [],
      net: [],
      top: 0,
    };
    h.vuln = (h.age >= 75 ? 25 : h.age >= 65 ? 12 : 0) + (h.alone ? 15 : 0) + (h.device ? 25 : 0) + (h.mobility ? 15 : 0) + (h.smart ? 0 : 10);
    h.top = (1.25 + 0.95) * h.sy;
    homes.push(h);
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

// overnight timeline per household (t is hours after 22:00)
const clampT = (t: number) => Math.min(t, 7.5);
for (const p of homes) {
  const E = (t: number, status: Status, agent: string, text: string, conf: string | null) => p.events.push({ t: clampT(t), status, agent, text, conf });
  const c = (lo: number, span: number) => (lo + rnd() * span).toFixed(2);
  if (p.danger) {
    p.tHit = 0.5 + rnd() * 0.6;
    p.tPower = 6.4 + rnd() * 0.8;
    E(p.tHit, 'unknown', 'Signal', 'power lost, no check-in yet', null);
    if (rnd() < 0.1 + p.vuln / 340) {
      const tS = p.tHit + 0.1 + rnd() * 1.6;
      E(tS, 'p1', 'Triage · Nano', `SOS ${pick(SOS)} → P1`, c(0.86, 0.12));
      const tA = tS + 0.08 + rnd() * 0.35;
      const helper = pick(FIRST);
      E(tA, 'enroute', 'Dispatch · Super', `P1 escalated to responders; ${helper} (truck, 0.4 km) sent too`, c(0.8, 0.15));
      if (rnd() < 0.25) E(tA + 0.17, 'enroute', 'Dispatch · Super', `${helper} timed out at 10 min → next ring of helpers`, c(0.77, 0.1));
      E(tA + 0.45 + rnd() * 1.1, 'safe', 'Check-in', 'reached by responders, family safe', null);
    } else if (p.vuln >= 37 && rnd() < 0.8) {
      const tP = p.tHit + 0.5;
      E(tP, 'p2', 'Silent signal · Nano', `age ${p.age}${p.device ? ', powered device' : ''}${p.alone ? ', lives alone' : ''}, no contact 30 min → calling`, c(0.74, 0.2));
      if (rnd() < 0.55) E(tP + 0.06 + rnd() * 0.25, 'safe', 'Voice · Nano', 'answered call: cold but okay; blankets requested', c(0.8, 0.15));
      else {
        const tA = tP + 0.12 + rnd() * 0.2;
        E(tA, 'enroute', 'Dispatch · Super', `no answer → ${pick(FIRST)} next door sent for a wellness check`, c(0.81, 0.1));
        E(tA + 0.3 + rnd() * 0.9, 'safe', 'Check-in', `${pick(['neighbor visit', 'neighbor visit', 'mesh radio'])}: safe, moved to warming center`, null);
      }
    } else E(p.tHit + 0.12 + Math.pow(rnd(), 2) * 3.6, 'safe', 'Check-in', `checked in by ${pick(CHANNEL)}`, null);
  } else if (rnd() < 0.12) {
    p.tHit = 0.8 + rnd() * 1.6;
    p.tPower = p.tHit + 0.6 + rnd() * 1.8;
    E(p.tHit, 'unknown', 'Signal', 'brief outage, no check-in yet', null);
    E(p.tHit + 0.1 + rnd() * 1.1, 'safe', 'Check-in', `checked in by ${pick(CHANNEL)}`, null);
  }
  p.events.sort((a, b) => a.t - b.t);
}
for (const p of homes)
  p.net = homes
    .filter((o) => o !== p && Math.abs(o.x - p.x) < 11 && Math.abs(o.z - p.z) < 11)
    .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
    .slice(0, 3);

export function statusAt(p: Home, t: number): Status {
  let s: Status = 'normal';
  for (const e of p.events) {
    if (e.t <= t) s = e.status;
    else break;
  }
  return s;
}
export const powerOut = (p: Home, t: number) => p.tHit !== undefined && p.tPower !== undefined && t >= p.tHit && t < p.tPower;
export function gapMin(p: Home, t: number) {
  if (p.tHit === undefined || t < p.tHit || statusAt(p, t) === 'safe') return 0;
  return Math.round((t - p.tHit) * 60);
}

export const allEvents = homes
  .flatMap((p) => p.events.filter((e) => e.agent !== 'Signal').map((e) => ({ ...e, home: p })))
  .sort((a, b) => a.t - b.t);
export const lastSafeTime = Math.max(...homes.flatMap((p) => p.events.filter((e) => e.status === 'safe').map((e) => e.t)));

export const fmtClock = (t: number) => {
  const mins = Math.round(22 * 60 + t * 60) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};
