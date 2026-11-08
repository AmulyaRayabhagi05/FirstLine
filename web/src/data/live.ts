// Live connection from the dashboard to the FirstLine SpacetimeDB module. Everything the map
// shows (who lives where, their status, the agents' reasoning, incident reports) comes from here.
//
// The connecting identity must be staff or a read-only viewer to see rows (the views are empty
// otherwise). The public build ships a viewer token (VITE_SPACETIME_TOKEN); without one, the
// identity is shown in the HUD and the module owner grants it once:
//   spacetime call --server local firstline add_viewer '"<identity>"'

import { DbConnection } from '../module_bindings';
import { DALLAS_NEIGHBORHOODS, homes, project, type Status } from '../sim/world';
import { useMap, type ActionKind, type AgentLine, type AssignmentInfo, type IncidentReport, type KeyPassInfo, type Resident, type TriageInfo, type WaveStat } from '../state/store';
import { toMapStatus } from './spacetime';

export const SPACETIME_HOST: string = (import.meta.env.VITE_SPACETIME_HOST as string) || 'http://127.0.0.1:3000';
export const SPACETIME_DB: string = (import.meta.env.VITE_SPACETIME_DB as string) || 'firstline';

const TOKEN_KEY = `firstline.spacetime.token.${SPACETIME_DB}`;
/** Optional pinned token: one identity across ports and browsers. Anything in VITE_* ships in the
 *  bundle, so a public build may only pin a read-only VIEWER token, never a staff one. */
const PINNED_TOKEN = (import.meta.env.VITE_SPACETIME_TOKEN as string | undefined) || undefined;
/** Signals that mean a person is exposed to the event, so silence from them is a risk. */
const EXPOSURE = new Set(['power_out', 'phone_offline', 'low_temp', 'geofence_entered']);
/** Worst first: a household shows the most urgent status among its people. */
const RANK: Status[] = ['p1', 'p2', 'unknown', 'enroute', 'safe', 'normal'];
/** Farthest a household may sit from its map home, in world units (5 per km). Dense neighborhoods
 * spill onto the nearest free lots, so every registered household gets a home. */
const MAX_PLACE_DIST = 260;

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
function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
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
  const people = [...db.dashPerson.iter()];
  const households = [...db.opsHousehold.iter()];
  const sosAll = [...db.opsSosEvent.iter()];
  const assignments = [...db.opsAssignment.iter()];
  const checkIns = [...db.opsCheckIn.iter()];
  const signals = [...db.opsSignal.iter()];
  const steps = [...db.opsAgentStep.iter()];
  const nets = [...db.opsSafetyNet.iter()];
  const triages = [...db.opsTriage.iter()];
  const keyPasses = [...db.opsKeyPass.iter()];
  const actionRows = [...db.opsActionRequest.iter()];
  const now = Date.now();
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

  // Every step, tied to a home where its subject resolves to one. Only decisions reach the
  // ticker; the household card can open the full reasoning (thoughts, tool calls, results).
  const allLines: AgentLine[] = steps
    .map((s) => ({
      at: ms(s.createdAt)!,
      agent: s.agent,
      kind: s.kind,
      text: s.content.length > 220 ? `${s.content.slice(0, 217)}…` : s.content,
      full: s.content,
      conf: s.confidence ?? null,
      subject: s.subject,
      homeIdx: homeOfSubject(s.subject),
    }))
    .sort((a, b) => a.at - b.at);
  const feed = allLines.filter((s) => s.kind === 'decision');
  const linesByHome = new Map<number, AgentLine[]>();
  for (const l of allLines) {
    if (l.homeIdx === null) continue;
    const arr = linesByHome.get(l.homeIdx);
    if (arr) arr.push(l);
    else linesByHome.set(l.homeIdx, [l]);
  }

  // Latest triage per person.
  const latestTriage = new Map<string, (typeof triages)[number]>();
  for (const t of triages) {
    const k = key(t.personId);
    const prev = latestTriage.get(k);
    if (!prev || ms(prev.createdAt)! < ms(t.createdAt)!) latestTriage.set(k, t);
  }
  const nameOf = (pid: bigint) => personById.get(key(pid))?.name ?? `#${pid}`;

  function householdTriage(rows: ((typeof triages)[number] | undefined)[]): TriageInfo | null {
    const t = rows.filter((r): r is (typeof triages)[number] => !!r).sort((a, b) => ms(b.createdAt)! - ms(a.createdAt)!)[0];
    return t
      ? { urgency: t.urgency, confidence: t.confidence, needs: t.needs, priority: t.priority, reason: t.reason, model: t.model, at: ms(t.createdAt)! }
      : null;
  }
  function householdAssignment(personIds: Set<string>): AssignmentInfo | null {
    let best: (typeof assignments)[number] | null = null;
    for (const a of assignments) {
      const s = sosById.get(key(a.sosId));
      if (!s || !personIds.has(key(s.personId))) continue;
      if (!best || ms(a.offeredAt)! > ms(best.offeredAt)!) best = a;
    }
    return best ? { state: best.state, helper: nameOf(best.helperId), ring: best.ring, at: ms(best.offeredAt)! } : null;
  }
  function householdKeyPass(householdId: string): KeyPassInfo | null {
    let best: (typeof keyPasses)[number] | null = null;
    for (const kp of keyPasses) {
      if (key(kp.householdId) !== householdId) continue;
      if (!best || ms(kp.grantedAt)! > ms(best.grantedAt)!) best = kp;
    }
    return best
      ? { helper: nameOf(best.helperId), approvedBy: best.approvedBy, grantedAt: ms(best.grantedAt)!, expiresAt: ms(best.expiresAt)!, revoked: best.revoked }
      : null;
  }

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
      members: members.map((m) => ({ id: m.id, status: statusOf(m) })),
      reasoning: linesByHome.get(idx) ?? [],
      triage: householdTriage(members.map((m) => latestTriage.get(key(m.id)))),
      assignment: householdAssignment(ids),
      keyPass: householdKeyPass(key(h.id)),
      escalated: sosAll.some((s) => ids.has(key(s.personId)) && s.state === 'escalated'),
      actions: actionRows
        .filter((x) => ids.has(key(x.personId)))
        .sort((x, y) => ms(y.createdAt)! - ms(x.createdAt)!)
        .slice(0, 4)
        .map((x) => ({ id: key(x.id), action: x.action as ActionKind, state: x.state, result: x.result, at: ms(x.createdAt)! })),
      claimTimeline: (() => {
        const t = steps
          .filter((s) => s.content.startsWith('Claim timeline:') && ids.has(s.subject.split(':')[1] ?? ''))
          .sort((x, y) => ms(y.createdAt)! - ms(x.createdAt)!)[0];
        return t ? { at: ms(t.createdAt)!, text: t.content } : null;
      })(),
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

  // This event's response, straight from the rows: who asked for help, how fast Nemotron triaged them.
  const WINDOW = 12 * 60 * 60 * 1000;
  const waveSos = sosAll.filter((s) => now - ms(s.createdAt)! < WINDOW);
  let wave: WaveStat | null = null;
  if (waveSos.length > 0) {
    const firstSos = new Map<string, number>();
    for (const s of waveSos) {
      const k = key(s.personId);
      const t = ms(s.createdAt)!;
      if (!firstSos.has(k) || t < firstSos.get(k)!) firstSos.set(k, t);
    }
    let lastTriage = 0;
    let triaged = 0;
    for (const [pid, t0] of firstSos) {
      const t = triages.filter((x) => key(x.personId) === pid && ms(x.createdAt)! >= t0 - 1000).map((x) => ms(x.createdAt)!);
      if (t.length) {
        triaged++;
        lastTriage = Math.max(lastTriage, Math.min(...t));
      }
    }
    const start = Math.min(...firstSos.values());
    const waveIds = new Set(waveSos.map((s) => key(s.id)));
    const end = triaged < firstSos.size ? now : lastTriage;
    wave = {
      people: firstSos.size,
      triaged,
      minutes: Math.max(1, Math.round((end - start) / 60_000)),
      neighbors: new Set(assignments.filter((a) => waveIds.has(key(a.sosId)) && a.state !== 'declined' && a.state !== 'timed_out').map((a) => key(a.sosId))).size,
      escalated: waveSos.filter((s) => s.state === 'escalated').length,
    };
  }

  const st = useMap.getState();
  st.setLive({ residents, feed, reports });
  st.setLiveInfo({
    people: people.length,
    households: households.length,
    openSos: sosAll.filter((s) => s.state !== 'resolved').length,
    alertedCells: [...cells.values()].filter((c) => c.alertLevel).length,
    triaged: triages.length,
    agentSteps: steps.length,
    activeKeyPasses: keyPasses.filter((k) => !k.revoked && ms(k.expiresAt)! > now).length,
    lastUpdate: now,
    wave,
  });
}

let liveConn: DbConnection | null = null;

// ---- actions from the map; each is one reducer call per person and needs a staff identity ----

const needsHelp = (s: Status) => s === 'p1' || s === 'p2' || s === 'unknown';

/** Mark everyone in one household safe (a neighbor or responder confirmed it). */
export async function markHouseholdSafe(r: Resident) {
  if (!liveConn) throw new Error('Not connected');
  for (const m of r.members) if (needsHelp(m.status) || m.status === 'enroute') await liveConn.reducers.markSafe({ personId: m.id, note: 'confirmed safe from the map' });
}

/** Ask the agents to act for a household (the worker runs it and writes the result back). */
export async function requestAction(r: Resident, action: ActionKind, note = '') {
  if (!liveConn) throw new Error('Not connected');
  const target = r.members.find((m) => needsHelp(m.status) || m.status === 'enroute') ?? r.members[0];
  if (!target) throw new Error('No one registered in this household');
  await liveConn.reducers.requestAction({ personId: target.id, action, note });
}

/** Demo: everyone in the flood zone reports needing help, as phones in a real flood would. */
export async function startFlood(onProgress?: (done: number, total: number) => void) {
  if (!liveConn) throw new Error('Not connected');
  const { residents } = useMap.getState();
  const targets = homes.flatMap((h) => (h.danger && residents[h.idx] ? residents[h.idx]!.members : [])).filter((m) => !needsHelp(m.status));
  const stamp = Date.now();
  let i = 0;
  for (const m of targets) {
    await liveConn.reducers.checkIn({ clientId: `flood-${stamp}-${m.id}`, personId: m.id, kind: 'app', result: 'needs_help', note: 'flood demo' });
    onProgress?.(++i, targets.length);
  }
  return targets.length;
}

/** Demo: clear the flood by marking everyone who still needs help safe. */
export async function clearFlood(onProgress?: (done: number, total: number) => void) {
  if (!liveConn) throw new Error('Not connected');
  const targets = useMap.getState().residents.flatMap((r) => (r ? r.members : [])).filter((m) => needsHelp(m.status) || m.status === 'enroute');
  let i = 0;
  for (const m of targets) {
    await liveConn.reducers.markSafe({ personId: m.id, note: 'flood demo cleared' });
    onProgress?.(++i, targets.length);
  }
  return targets.length;
}

// ---- sign in / sign out ----
// Access is the SpacetimeDB identity: a staff identity's access key (its token) sees the ops_* views.
// Signing in reconnects with that key; signing out forgets it and starts a fresh identity.

function restart(token: string | undefined) {
  const old = liveConn;
  liveConn = null;
  old?.disconnect();
  placement.clear();
  taken.clear();
  useMap.getState().resetLive();
  if (!token) clearToken(); // a key is saved only once the server accepts it (onConnect)
  startLive(token ?? PINNED_TOKEN);
}

/** Sign in with a staff access key. Resolves to whether that identity can see the system. */
export function signIn(accessKey: string): Promise<boolean> {
  const key = accessKey.trim();
  if (!key) return Promise.resolve(false);
  const previous = readToken();
  restart(key);
  return new Promise((resolve) => {
    const unsub = useMap.subscribe((s) => {
      if (s.liveInfo.state === 'subscribed' || s.liveInfo.state === 'error') {
        unsub();
        const rejected = s.liveInfo.state === 'error';
        // A rejected key leaves this browser on its previous identity.
        if (rejected) restart(previous);
        resolve(!rejected && s.liveInfo.people > 0);
      }
    });
  });
}

/** Forget this browser's access key: back to the public viewer, or a new unprivileged identity. */
export function signOut() {
  restart(undefined);
}

export function startLive(token: string | undefined = readToken() ?? PINNED_TOKEN) {
  const st = useMap.getState();
  st.setLiveInfo({ state: 'connecting', message: `Connecting to ${SPACETIME_HOST} / ${SPACETIME_DB}…` });

  const usedToken = token;
  const conn0 = DbConnection.builder()
    .withUri(SPACETIME_HOST)
    .withDatabaseName(SPACETIME_DB)
    .withToken(token)
    .onConnect((conn, identity, token) => {
      if (conn !== liveConn) return; // a newer sign-in replaced this connection
      // The shared viewer token is never saved: a saved token always means this browser's own
      // identity or a staff key someone signed in with.
      const viewer = !!PINNED_TOKEN && usedToken === PINNED_TOKEN;
      if (!viewer) writeToken(token);
      useMap.getState().setLiveInfo({ viewer });
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
          if (conn === liveConn) snapshot(conn);
        }, 250);
      };

      conn
        .subscriptionBuilder()
        .onApplied(() => {
          const db = conn.db;
          for (const t of [db.dashPerson, db.opsHousehold, db.opsSosEvent, db.opsAssignment, db.opsCheckIn, db.opsSignal, db.opsAgentStep, db.opsIncidentReport, db.opsSafetyNet, db.opsTriage, db.opsKeyPass, db.opsActionRequest, db.hexCell] as const) {
            const table = t as unknown as { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?: (cb: () => void) => void };
            table.onInsert(refresh);
            table.onDelete(refresh);
            table.onUpdate?.(refresh);
          }
          snapshot(conn);
          const people = useMap.getState().liveInfo.people;
          useMap.getState().setLiveInfo({
            state: 'subscribed',
            message: people === 0 ? `Connected, but this dashboard cannot read yet. Grant 0x${hex} (add_viewer)` : 'Live',
          });
        })
        .onError((ctx) => useMap.getState().setLiveInfo({ state: 'error', message: `Subscription failed: ${String((ctx as { event?: unknown }).event ?? 'unknown')}` }))
        .subscribe([
          'SELECT * FROM dash_person',
          'SELECT * FROM ops_household',
          'SELECT * FROM ops_sos_event',
          'SELECT * FROM ops_assignment',
          'SELECT * FROM ops_check_in',
          'SELECT * FROM ops_signal',
          'SELECT * FROM ops_agent_step',
          'SELECT * FROM ops_incident_report',
          'SELECT * FROM ops_safety_net',
          'SELECT * FROM ops_triage',
          'SELECT * FROM ops_key_pass',
          'SELECT * FROM ops_action_request',
          'SELECT * FROM hex_cell',
        ]);
    })
    .onConnectError((_ctx, err) => {
      if (liveConn === conn0) useMap.getState().setLiveInfo({ state: 'error', message: `Could not sign in to ${SPACETIME_HOST}: ${err.message}` });
    })
    .onDisconnect((_ctx, err) => {
      if (err && liveConn === conn0) useMap.getState().setLiveInfo({ state: 'error', message: `Disconnected: ${err.message}` });
    })
    .build();
  liveConn = conn0;
}
