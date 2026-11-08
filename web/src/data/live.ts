// Live data: subscribe to the FirstLine SpacetimeDB database and turn its rows into map households.
//
// Households keep their real neighborhood layout: real lat/lng are projected, scaled to the city,
// and each household is snapped to the nearest free lot (so homes never sit on a road or the river).
import { DbConnection } from '../module_bindings';
import { toMapStatus } from './spacetime';
import { ANCHORS, COMMS, PARKS, isBlockedAt, rnd, setHomes, world, homes, distPL, river, DANGER_W, type Home, type Resident, type Status, type TimelineEvent } from '../sim/world';
import { useMap, type Decision } from '../state/store';

export const LIVE_HOST = (import.meta.env.VITE_SPACETIME_HOST as string) || 'https://maincloud.spacetimedb.com';
export const LIVE_DB = (import.meta.env.VITE_SPACETIME_DB as string) || 'firstline';

const QUERIES = [
  'SELECT * FROM person',
  'SELECT * FROM household',
  'SELECT * FROM safety_net',
  'SELECT * FROM sos_event',
  'SELECT * FROM assignment',
  'SELECT * FROM check_in',
  'SELECT * FROM hex_cell',
  'SELECT * FROM agent_step',
];
const RANK: Record<Status, number> = { p1: 5, p2: 4, unknown: 3, enroute: 2, safe: 1, normal: 0 };
const WALLS = ['#ffffff', '#e9f0ff', '#f2ece0', '#e3f0ea', '#efe6ee', '#dfe6f5'];
const ROOFS = ['#262d2f', '#2d2925', '#1f2b2b', '#2b2d31', '#30302b', '#22292c'];
const LOT = 3.8;

let conn: DbConnection | null = null;
let layoutKey = '';
let slotOf = new Map<number, { x: number; z: number }>(); // household id → lot

const tokenKey = `firstline-token:${LIVE_DB}`;
const readToken = () => {
  try {
    return localStorage.getItem(tokenKey) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveToken = (t: string) => {
  try {
    localStorage.setItem(tokenKey, t);
  } catch {
    /* private window: anonymous each time */
  }
};

export function startLive() {
  const st = useMap.getState();
  if (conn || st.mode !== 'live') return;
  setHomes([]);
  st.setLive({ conn: 'connecting', connError: '' });
  let scheduled = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      rebuild();
    }, 300);
  };
  conn = DbConnection.builder()
    .withUri(LIVE_HOST)
    .withDatabaseName(LIVE_DB)
    .withToken(readToken())
    .onConnect((c, _identity, token) => {
      saveToken(token);
      c.subscriptionBuilder()
        .onApplied(() => {
          useMap.getState().setLive({ conn: 'live' });
          rebuild();
        })
        .onError((_ctx) => useMap.getState().setLive({ conn: 'error', connError: 'Subscription failed' }))
        .subscribe(QUERIES);
      const db = c.db as unknown as Record<string, { onInsert: (cb: () => void) => void; onUpdate?: (cb: () => void) => void; onDelete: (cb: () => void) => void }>;
      for (const name of ['person', 'household', 'safetyNet', 'sosEvent', 'assignment', 'checkIn', 'hexCell', 'agentStep']) {
        const t = db[name];
        if (!t) continue;
        t.onInsert(schedule);
        t.onUpdate?.(schedule);
        t.onDelete(schedule);
      }
    })
    .onConnectError((_ctx, err) => useMap.getState().setLive({ conn: 'error', connError: String(err?.message ?? err) }))
    .onDisconnect(() => useMap.getState().setLive({ conn: 'error', connError: 'Disconnected from the database' }))
    .build();
}

// lay households out on lots, keeping their real relative positions
function layout(households: { id: number; lat: number; lng: number }[]) {
  const n = households.length;
  if (!n) return;
  const lat0 = households.reduce((s, h) => s + h.lat, 0) / n;
  const lng0 = households.reduce((s, h) => s + h.lng, 0) / n;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const pts = households.map((h) => ({ id: h.id, mx: (h.lng - lng0) * k * 111320, mz: -(h.lat - lat0) * 110540 }));
  const radiusNeeded = Math.max(30, Math.sqrt((n * LOT * LOT) / (Math.PI * 0.62)));
  world.radius = radiusNeeded;
  const dists = pts.map((p) => Math.hypot(p.mx, p.mz)).sort((a, b) => a - b);
  const r95 = dists[Math.floor(dists.length * 0.95)] || 1;
  const scale = (radiusNeeded * 0.92) / r95;
  // free lots on a jittered grid, off roads and the river
  const lots: { x: number; z: number; used: boolean }[] = [];
  const grid = new Map<string, number[]>();
  for (let gx = -radiusNeeded - 8; gx <= radiusNeeded + 8; gx += LOT)
    for (let gz = -radiusNeeded - 8; gz <= radiusNeeded + 8; gz += LOT) {
      const x = gx + (rnd() - 0.5) * 0.8;
      const z = gz + (rnd() - 0.5) * 0.8;
      if (Math.hypot(x, z) > radiusNeeded + 6 || isBlockedAt(x, z)) continue;
      if (PARKS.some((p) => Math.hypot(p.x - x, p.z - z) < p.r) || ANCHORS.some((a) => Math.hypot(a.x - x, a.z - z) < 4.4)) continue;
      const key = `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(lots.length);
      lots.push({ x, z, used: false });
    }
  slotOf = new Map();
  pts.sort((a, b) => Math.hypot(a.mx, a.mz) - Math.hypot(b.mx, b.mz));
  for (const p of pts) {
    const tx = p.mx * scale;
    const tz = p.mz * scale;
    let best = -1;
    let bd = Infinity;
    for (let ring = 0; ring < 30 && best < 0; ring++) {
      const cx = Math.floor(tx / 10);
      const cz = Math.floor(tz / 10);
      for (let dx = -ring; dx <= ring; dx++)
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          for (const i of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            if (lots[i].used) continue;
            const d = Math.hypot(lots[i].x - tx, lots[i].z - tz);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
    }
    if (best < 0) continue;
    lots[best].used = true;
    slotOf.set(p.id, { x: lots[best].x, z: lots[best].z });
  }
}

const hash = (n: number) => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

function rebuild() {
  if (!conn) return;
  const db = conn.db;
  const people = [...db.person.iter()];
  const householdRows = [...db.household.iter()];
  const households = householdRows.map((h) => ({ id: Number(h.id), lat: h.lat, lng: h.lng, cell: h.h3Cell }));
  const key = households.map((h) => h.id).join(',');
  const relayout = key !== layoutKey;
  if (relayout) {
    layoutKey = key;
    layout(households);
  }
  const alertCells = new Set([...db.hexCell.iter()].filter((c) => c.alertLevel).map((c) => c.h3Cell));
  const activeAssign = new Map<number, { state: string }>(); // person id → offered/accepted assignment
  const sosPerson = new Map<number, number>();
  for (const s of db.sosEvent.iter()) sosPerson.set(Number(s.id), Number(s.personId));
  for (const a of db.assignment.iter()) {
    if (a.state !== 'offered' && a.state !== 'accepted') continue;
    const pid = sosPerson.get(Number(a.sosId));
    if (pid !== undefined) activeAssign.set(pid, { state: a.state });
  }
  const byHousehold = new Map<number, typeof people>();
  for (const p of people) {
    const hid = Number(p.householdId);
    if (!byHousehold.has(hid)) byHousehold.set(hid, []);
    byHousehold.get(hid)!.push(p);
  }
  // agent steps, check-ins and SOS messages per person, newest last
  const eventsByPerson = new Map<number, TimelineEvent[]>();
  const push = (pid: number, e: TimelineEvent) => {
    if (!eventsByPerson.has(pid)) eventsByPerson.set(pid, []);
    eventsByPerson.get(pid)!.push(e);
  };
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  for (const s of db.sosEvent.iter()) push(Number(s.personId), { t: s.createdAt.toDate().getTime(), status: 'p1', agent: `SOS · ${s.channel}`, text: `"${s.message}" (${s.state})`, conf: null, when: fmt(s.createdAt.toDate()) });
  for (const c of db.checkIn.iter()) push(Number(c.personId), { t: c.createdAt.toDate().getTime(), status: c.result === 'safe' ? 'safe' : 'p2', agent: `Check-in · ${c.kind}`, text: c.result === 'safe' ? 'safe' : c.result === 'needs_help' ? 'needs help' : 'no answer', conf: null, when: fmt(c.createdAt.toDate()) });
  const decisions: Decision[] = [];
  for (const s of db.agentStep.iter()) {
    const m = /^(person|sos):(\d+)$/.exec(s.subject);
    const pid = m ? (m[1] === 'person' ? Number(m[2]) : sosPerson.get(Number(m[2]))) : undefined;
    const conf = s.confidence ?? null;
    if (pid !== undefined) push(pid, { t: s.createdAt.toDate().getTime(), status: 'normal', agent: `Nemotron · ${s.agent}`, text: s.content, conf: conf === null ? null : conf.toFixed(2), when: fmt(s.createdAt.toDate()) });
    if (s.kind === 'decision') decisions.push({ id: String(s.id), agent: s.agent, text: s.content, when: s.createdAt.toDate(), homeId: null, conf, ...(pid !== undefined ? { pid } : {}) } as Decision);
  }
  decisions.sort((a, b) => a.when.getTime() - b.when.getTime());

  const list: Home[] = [];
  const homeOfPerson = new Map<number, Home>();
  for (const h of households) {
    const slot = slotOf.get(h.id);
    if (!slot) continue;
    const rs = byHousehold.get(h.id) ?? [];
    const residents: Resident[] = rs.map((p) => ({
      id: Number(p.id),
      name: p.name,
      age: p.age,
      status: toMapStatus({ status: p.status, priority: p.priority }, activeAssign.get(Number(p.id))),
      priority: p.priority,
      lastSeen: p.lastSeen?.toDate(),
      medical: p.medicalNeeds,
      phone: p.hasSmartphone,
      mobility: p.mobility,
      language: p.language,
      livesAlone: p.livesAlone,
      poweredDevice: p.poweredDevice,
    }));
    const lead = [...rs].sort((a, b) => b.age - a.age)[0];
    const r = hash(h.id);
    const home: Home = {
      id: h.id,
      idx: 0,
      x: slot.x,
      z: slot.z,
      rot: (r < 0.5 ? 0 : Math.PI / 2) + (hash(h.id + 7) - 0.5) * 0.3,
      sx: 0.85 + hash(h.id + 1) * 0.4,
      sy: 0.85 + hash(h.id + 2) * 0.5,
      wall: WALLS[Math.floor(hash(h.id + 3) * WALLS.length)],
      roof: ROOFS[Math.floor(hash(h.id + 4) * ROOFS.length)],
      comm: nearestComm(slot.x, slot.z),
      danger: alertCells.has(h.cell) || distPL(river, slot.x, slot.z) < DANGER_W,
      name: lead?.name ?? 'Household',
      age: lead?.age ?? 0,
      alone: rs.length === 1 && !!lead?.livesAlone,
      device: rs.some((p) => p.poweredDevice),
      mobility: rs.some((p) => p.mobility !== 'ok'),
      smart: rs.every((p) => p.hasSmartphone),
      spanish: rs.some((p) => p.language === 'es'),
      vuln: 0,
      riverKm: '—',
      events: rs.flatMap((p) => eventsByPerson.get(Number(p.id)) ?? []).sort((a, b) => a.t - b.t).slice(-12),
      net: [],
      top: (1.25 + 0.95) * (0.85 + hash(h.id + 2) * 0.5),
      residents,
      alert: alertCells.has(h.cell),
    };
    home.vuln = Math.round(Math.max(0, ...rs.map((p) => p.priorityScore)));
    list.push(home);
    for (const p of rs) homeOfPerson.set(Number(p.id), home);
  }
  // safety nets: link each household to the households of its members
  for (const n of db.safetyNet.iter()) {
    const a = homeOfPerson.get(Number(n.ownerId));
    const b = homeOfPerson.get(Number(n.memberId));
    if (a && b && a !== b && !a.net.includes(b) && a.net.length < 3) a.net.push(b);
  }
  for (const d of decisions) {
    const pid = (d as Decision & { pid?: number }).pid;
    if (pid !== undefined) d.homeId = homeOfPerson.get(pid)?.id ?? null;
  }

  setHomes(list);
  const statuses = homes.map((h) => (h.residents ?? []).reduce<Status>((w, p) => (RANK[p.status] > RANK[w] ? p.status : w), 'normal'));
  const st = useMap.getState();
  st.setLive({
    liveInfo: { people: people.length, households: list.length, updatedAt: new Date(), needHelp: people.filter((p) => p.status === 'needs_help').length },
    decisions: decisions.slice(-40),
  });
  st.applyLiveStatuses(statuses, relayout);
}

function nearestComm(x: number, z: number) {
  let b = 0;
  let bd = Infinity;
  COMMS.forEach((c, k) => {
    const d = Math.hypot(x - c.x * (world.radius / 60), z - c.z * (world.radius / 60));
    if (d < bd) {
      bd = d;
      b = k;
    }
  });
  return b;
}

// ---- actions a person takes from the map (each is one reducer call per resident) ----

/** Mark every resident of the household safe (a neighbor or responder confirmed it). */
export async function markHouseholdSafe(home: Home, note: string) {
  if (!conn) throw new Error('Not connected');
  for (const r of home.residents ?? []) if (r.status !== 'safe') await conn.reducers.markSafe({ personId: BigInt(r.id), note });
}

/** Demo control: everyone in the flood zone reports needing help, as phones in a real flood would. */
export async function startFlood(onProgress?: (done: number, total: number) => void) {
  if (!conn) throw new Error('Not connected');
  const targets = homes.filter((h) => h.danger).flatMap((h) => h.residents ?? []).filter((r) => r.status === 'safe' || r.status === 'normal');
  let i = 0;
  const stamp = Date.now();
  for (const r of targets) {
    await conn.reducers.checkIn({ clientId: `flood-${stamp}-${r.id}`, personId: BigInt(r.id), kind: 'app', result: 'needs_help', note: 'flood demo' });
    onProgress?.(++i, targets.length);
  }
  return targets.length;
}

/** Demo control: clear the flood by marking everyone who still needs help safe. */
export async function clearFlood(onProgress?: (done: number, total: number) => void) {
  if (!conn) throw new Error('Not connected');
  const targets = homes.flatMap((h) => h.residents ?? []).filter((r) => r.status !== 'safe' && r.status !== 'normal');
  let i = 0;
  for (const r of targets) {
    await conn.reducers.markSafe({ personId: BigInt(r.id), note: 'flood demo cleared' });
    onProgress?.(++i, targets.length);
  }
  return targets.length;
}
