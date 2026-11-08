// Live connection from the dashboard to the FirstLine SpacetimeDB module. Everything the map
// shows (who lives where, their status, the agents' reasoning, incident reports) comes from here.
//
// The connecting identity must be staff to see rows (ops_* views are empty otherwise). Its
// identity is shown in the HUD and logged to the console; the module owner grants it once:
//   spacetime call --server local firstline add_staff '"<identity>"'

import { DbConnection } from '../module_bindings';
import { DALLAS_NEIGHBORHOODS, homes, project, type Status } from '../sim/world';
import { useMap, type AgentLine, type IncidentReport, type Resident } from '../state/store';
import { toMapStatus } from './spacetime';

export const SPACETIME_HOST: string = (import.meta.env.VITE_SPACETIME_HOST as string) || 'http://127.0.0.1:3000';
export const SPACETIME_DB: string = (import.meta.env.VITE_SPACETIME_DB as string) || 'firstline';

const TOKEN_KEY = `firstline.spacetime.token.${SPACETIME_DB}`;
/** Signals that mean a person is exposed to the event, so silence from them is a risk. */
const EXPOSURE = new Set(['power_out', 'phone_offline', 'low_temp', 'geofence_entered']);
/** Worst first: a household shows the most urgent status among its people. */
const RANK: Status[] = ['p1', 'p2', 'unknown', 'enroute', 'safe', 'normal'];
/** Farthest a household may sit from its map home, in world units (5 per km). */
const MAX_PLACE_DIST = 30;

// localStorage can throw (private windows, blocked storage); the app still works without it.
function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* per-viewer convenience only */
  }
}

const ms = (t: { toDate(): Date } | undefined | null) => (t ? t.toDate().getTime() : null);
const key = (id: bigint) => id.toString();

function nearestNeighborhood(lat: number, lng: number): string {
  let best = DALLAS_NEIGHBORHOODS[0].name;
  let bd = Infinity;
  for (const n of DALLAS_NEIGHBORHOODS) {
    const d = Math.hypot(lat - n.lat, (lng - n.lng) * Math.cos((lat * Math.PI) / 180));
    if (d < bd) {
      bd = d;
      best = n.name;
    }
  }
  return best;
}

// Household id -> home index. Assigned once per household so homes never jump between updates.
const placement = new Map<string, number>();
const taken = new Set<number>();
function place(householdId: string, lat: number, lng: number): number | null {
  const have = placement.get(householdId);
  if (have !== undefined) return have;
  const { x, z } = project(lat, lng);
  let best = -1;
  let bd = MAX_PLACE_DIST;
  for (const h of homes) {
    if (taken.has(h.idx)) continue;
    const d = Math.hypot(h.x - x, h.z - z);
    if (d < bd) {
      bd = d;
      best = h.idx;
    }
  }
  if (best < 0) return null;
  placement.set(householdId, best);
  taken.add(best);
  return best;
}

function snapshot(conn: DbConnection) {
  const db = conn.db;
  const people = [...db.opsPerson.iter()];
  const households = [...db.opsHousehold.iter()];
  const sosAll = [...db.opsSosEvent.iter()];
  const assignments = [...db.opsAssignment.iter()];
  const checkIns = [...db.opsCheckIn.iter()];
  const signals = [...db.opsSignal.iter()];
  const steps = [...db.opsAgentStep.iter()];
  const nets = [...db.opsSafetyNet.iter()];
  const cells = new Map([...db.hexCell.iter()].map((c) => [c.h3Cell, c]));

  const personById = new Map(people.map((p) => [key(p.id), p]));
  const peopleByHousehold = new Map<string, typeof people>();
  for (const p of people) {
    const k = key(p.householdId);
    peopleByHousehold.set(k, [...(peopleByHousehold.get(k) ?? []), p]);
  }

  // Latest signal of each kind per person, and whether the person is exposed at all.
  const latestSignal = new Map<string, Map<string, (typeof signals)[number]>>();
  for (const s of signals) {
    const k = key(s.personId);
    const m = latestSignal.get(k) ?? new Map();
    const prev = m.get(s.kind);
    if (!prev || ms(prev.createdAt)! < ms(s.createdAt)!) m.set(s.kind, s);
    latestSignal.set(k, m);
  }
  const exposed = (p: (typeof people)[number]) => {
    if (cells.get(p.h3Cell)?.alertLevel) return true;
    const m = latestSignal.get(key(p.id));
    return !!m && [...m.keys()].some((k) => EXPOSURE.has(k));
  };

  // Open assignments and SOS per person.
  const sosById = new Map(sosAll.map((s) => [key(s.id), s]));
  const activeAssignment = new Map<string, (typeof assignments)[number]>();
  for (const a of assignments) {
    if (a.state !== 'offered' && a.state !== 'accepted') continue;
    const s = sosById.get(key(a.sosId));
    if (s) activeAssignment.set(key(s.personId), a);
  }

  const statusOf = (p: (typeof people)[number]): Status => {
    const a = activeAssignment.get(key(p.id));
    if (p.status === 'unknown' && !a && !exposed(p)) return 'normal';
    return toMapStatus(p, a ?? null);
  };

  // Place households, most at-risk first, so the people who matter most always get a home.
  const hhScore = (hid: string) => Math.max(0, ...(peopleByHousehold.get(hid) ?? []).map((p) => p.priorityScore));
  const ordered = households
    .filter((h) => !placement.has(key(h.id)))
    .sort((a, b) => hhScore(key(b.id)) - hhScore(key(a.id)) || Number(a.id - b.id));
  for (const h of ordered) place(key(h.id), h.lat, h.lng);

  // Map subjects to homes for the agent log and feed.
  const homeOfPerson = (pid: string): number | null => {
    const p = personById.get(pid);
    return p ? placement.get(key(p.householdId)) ?? null : null;
  };
  const homeOfSubject = (subject: string): number | null => {
    const [kind, id] = subject.split(':');
    if (kind === 'person') return homeOfPerson(id);
    if (kind === 'sos') {
      const s = sosById.get(id);
      return s ? homeOfPerson(key(s.personId)) : null;
    }
    return null;
  };

  // Only decisions reach people; thoughts and tool calls are the agents' working notes.
  const feed: AgentLine[] = steps
    .filter((s) => s.kind === 'decision')
    .map((s) => ({
      at: ms(s.createdAt)!,
      agent: s.agent,
      kind: s.kind,
      text: s.content.length > 220 ? `${s.content.slice(0, 217)}…` : s.content,
      conf: s.confidence ?? null,
      subject: s.subject,
      homeIdx: homeOfSubject(s.subject),
    }))
    .sort((a, b) => a.at - b.at);

  const residents: (Resident | null)[] = homes.map(() => null);
  for (const h of households) {
    const idx = placement.get(key(h.id));
    if (idx === undefined) continue;
    const members = peopleByHousehold.get(key(h.id)) ?? [];
    if (members.length === 0) continue;
    const primary = [...members].sort((a, b) => b.priorityScore - a.priorityScore || b.age - a.age)[0];
    const memberStatuses = members.map(statusOf);
    const status = RANK.find((r) => memberStatuses.includes(r)) ?? 'normal';
    const ids = new Set(members.map((m) => key(m.id)));

    let powerOut = false;
    let lastContactVia: string | null = null;
    let lastContactAt = -1;
    for (const m of members) {
      const po = latestSignal.get(key(m.id))?.get('power_out');
      if (po && po.value >= 0.5) powerOut = true;
    }
    for (const c of checkIns) {
      if (!ids.has(key(c.personId))) continue;
      const t = ms(c.createdAt)!;
      if (t > lastContactAt) {
        lastContactAt = t;
        lastContactVia = c.kind.replace(/_/g, ' ');
      }
    }
    const a = activeAssignment.get(key(primary.id));
    const helper = a ? personById.get(key(a.helperId))?.name ?? null : null;
    const net = nets
      .filter((n) => key(n.ownerId) === key(primary.id))
      .sort((x, y) => x.ring - y.ring)
      .slice(0, 3)
      .map((n) => {
        const m = personById.get(key(n.memberId));
        return { name: m?.name ?? `#${n.memberId}`, status: m ? statusOf(m) : ('normal' as Status) };
      });

    const log: AgentLine[] = [
      ...feed.filter((f) => f.homeIdx === idx),
      ...sosAll
        .filter((s) => ids.has(key(s.personId)))
        .map((s) => ({ at: ms(s.createdAt)!, agent: `SOS · ${s.channel}`, kind: 'sos', text: `"${s.message}"`, conf: null, subject: `sos:${s.id}`, homeIdx: idx })),
      ...checkIns
        .filter((c) => ids.has(key(c.personId)))
        .map((c) => ({ at: ms(c.createdAt)!, agent: 'Check-in', kind: c.kind, text: `${c.kind.replace(/_/g, ' ')}: ${c.result}${c.note ? ` · ${c.note}` : ''}`, conf: null, subject: `person:${c.personId}`, homeIdx: idx })),
    ].sort((x, y) => x.at - y.at);

    residents[idx] = {
      householdId: key(h.id),
      address: h.address,
      neighborhood: nearestNeighborhood(h.lat, h.lng),
      name: primary.name,
      age: primary.age,
      people: members.length,
      alone: primary.livesAlone,
      device: members.some((m) => m.poweredDevice),
      mobility: primary.mobility,
      medical: members.map((m) => m.medicalNeeds).filter(Boolean).join(', '),
      smart: primary.hasSmartphone,
      language: primary.language,
      priority: primary.priority,
      priorityScore: primary.priorityScore,
      status,
      powerOut,
      lastSeen: Math.max(...members.map((m) => ms(m.lastSeen) ?? -1)) > 0 ? Math.max(...members.map((m) => ms(m.lastSeen) ?? -1)) : null,
      lastContactVia,
      helper,
      net,
      log,
    };
  }

  const reports: IncidentReport[] = [...db.opsIncidentReport.iter()]
    .map((r) => ({
      id: key(r.id),
      cell: r.h3Cell,
      summary: r.summary,
      blockedRoads: r.blockedRoads,
      p1: r.p1,
      p2: r.p2,
      unknown: r.unknown,
      at: ms(r.createdAt)!,
    }))
    .sort((a, b) => b.at - a.at);

  const st = useMap.getState();
  st.setLive({ residents, feed, reports });
  st.setLiveInfo({
    people: people.length,
    households: households.length,
    openSos: sosAll.filter((s) => s.state !== 'resolved').length,
    alertedCells: [...cells.values()].filter((c) => c.alertLevel).length,
    lastUpdate: Date.now(),
  });
}

export function startLive() {
  const st = useMap.getState();
  st.setLiveInfo({ state: 'connecting', message: `Connecting to ${SPACETIME_HOST} / ${SPACETIME_DB}…` });

  DbConnection.builder()
    .withUri(SPACETIME_HOST)
    .withDatabaseName(SPACETIME_DB)
    .withToken(readToken())
    .onConnect((conn, identity, token) => {
      writeToken(token);
      const hex = identity.toHexString();
      console.info(`[firstline] dashboard identity 0x${hex}`);
      useMap.getState().setLiveInfo({ identity: hex });

      // Coalesce bursts of row callbacks (a storm playback inserts many rows a second).
      let queued = false;
      const refresh = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          snapshot(conn);
        }, 250);
      };

      conn
        .subscriptionBuilder()
        .onApplied(() => {
          const db = conn.db;
          for (const t of [db.opsPerson, db.opsHousehold, db.opsSosEvent, db.opsAssignment, db.opsCheckIn, db.opsSignal, db.opsAgentStep, db.opsIncidentReport, db.opsSafetyNet, db.hexCell] as const) {
            const table = t as unknown as { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?: (cb: () => void) => void };
            table.onInsert(refresh);
            table.onDelete(refresh);
            table.onUpdate?.(refresh);
          }
          snapshot(conn);
          const people = useMap.getState().liveInfo.people;
          useMap.getState().setLiveInfo({
            state: 'subscribed',
            message: people === 0 ? `Connected, but this dashboard is not staff yet. Grant 0x${hex}` : 'Live',
          });
        })
        .onError((ctx) => useMap.getState().setLiveInfo({ state: 'error', message: `Subscription failed: ${String((ctx as { event?: unknown }).event ?? 'unknown')}` }))
        .subscribe([
          'SELECT * FROM ops_person',
          'SELECT * FROM ops_household',
          'SELECT * FROM ops_sos_event',
          'SELECT * FROM ops_assignment',
          'SELECT * FROM ops_check_in',
          'SELECT * FROM ops_signal',
          'SELECT * FROM ops_agent_step',
          'SELECT * FROM ops_incident_report',
          'SELECT * FROM ops_safety_net',
          'SELECT * FROM hex_cell',
        ]);
    })
    .onConnectError((_ctx, err) => useMap.getState().setLiveInfo({ state: 'error', message: `Could not connect to ${SPACETIME_HOST}: ${err.message}` }))
    .onDisconnect((_ctx, err) => {
      if (err) useMap.getState().setLiveInfo({ state: 'error', message: `Disconnected: ${err.message}` });
    })
    .build();
}
