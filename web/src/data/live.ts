// Live connection from the dashboard to the FirstLine SpacetimeDB module.
//
// Subscribes to the staff-facing ops_* views (empty unless the connecting identity is staff),
// and writes each person's map status into the zustand store through toMapStatus.
//
// Mapping limit: the simulated homes have no lat/lng or household id yet, so a live person is
// placed on the home at the same position in the id-sorted person list. Once households carry
// map coordinates, match on those instead.

import { DbConnection } from '../module_bindings';
import { useMap } from '../state/store';
import { homes } from '../sim/world';
import { toMapStatus, type AssignmentRow, type PersonRow } from './spacetime';

export const SPACETIME_HOST: string = (import.meta.env.VITE_SPACETIME_HOST as string) || 'http://127.0.0.1:3000';
export const SPACETIME_DB: string = (import.meta.env.VITE_SPACETIME_DB as string) || 'firstline';

const TOKEN_KEY = 'firstline.spacetime.token';

export type LiveState = 'connecting' | 'subscribed' | 'error';

export interface LiveStatus {
  state: LiveState;
  message: string;
  persons: number;
}

let status: LiveStatus = { state: 'connecting', message: 'Connecting to SpacetimeDB…', persons: 0 };
const listeners = new Set<(s: LiveStatus) => void>();
export const getLiveStatus = () => status;
export function subscribeLive(fn: (s: LiveStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setLiveStatus(next: Partial<LiveStatus>) {
  status = { ...status, ...next };
  listeners.forEach((fn) => fn(status));
}

// localStorage can throw (private windows, blocked storage); the app works without it.
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

// Recompute every map status from the current subscription cache.
function pushStatuses(conn: DbConnection) {
  const persons = [...conn.db.opsPerson.iter()].sort((a, b) => Number(a.id - b.id)) as unknown as PersonRow[] & { id: bigint }[];
  const assignments = [...conn.db.opsAssignment.iter()] as unknown as (AssignmentRow & { sosId: bigint })[];
  const sos = [...conn.db.opsSosEvent.iter()];

  // person id -> their open assignment (via the SOS event that person raised)
  const activeBySos = new Map<string, AssignmentRow>();
  for (const a of assignments) {
    if (a.state === 'offered' || a.state === 'accepted') activeBySos.set(String(a.sosId), a);
  }
  const activeByPerson = new Map<string, AssignmentRow>();
  for (const s of sos) {
    const a = activeBySos.get(String(s.id));
    if (a) activeByPerson.set(String(s.personId), a);
  }

  const next = homes.map(() => 'normal' as const) as ReturnType<typeof toMapStatus>[];
  persons.slice(0, homes.length).forEach((p, i) => {
    const pid = String((p as unknown as { id: bigint }).id);
    next[i] = toMapStatus(p, activeByPerson.get(pid));
  });

  const st = useMap.getState();
  const changed = next.some((s, i) => s !== st.statuses[i]);
  useMap.setState(changed ? { statuses: next, version: st.version + 1 } : {});
  setLiveStatus({ persons: persons.length });
}

export function startLive() {
  useMap.setState({ live: true });
  setLiveStatus({ state: 'connecting', message: `Connecting to ${SPACETIME_HOST} / ${SPACETIME_DB}…` });

  DbConnection.builder()
    .withUri(SPACETIME_HOST)
    .withDatabaseName(SPACETIME_DB)
    .withToken(readToken())
    .onConnect((conn, _identity, token) => {
      writeToken(token);
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          const db = conn.db;
          const refresh = () => pushStatuses(conn);
          db.opsPerson.onInsert(refresh);
          db.opsPerson.onUpdate(refresh);
          db.opsPerson.onDelete(refresh);
          db.opsSosEvent.onInsert(refresh);
          db.opsSosEvent.onUpdate(refresh);
          db.opsAssignment.onInsert(refresh);
          db.opsAssignment.onUpdate(refresh);
          db.opsAssignment.onDelete(refresh);
          pushStatuses(conn);
          setLiveStatus({
            state: 'subscribed',
            message: status.persons === 0 ? 'Connected. No people visible: this identity may not be staff.' : 'Live',
          });
        })
        .onError((ctx) => setLiveStatus({ state: 'error', message: `Subscription failed: ${String((ctx as { event?: unknown }).event ?? 'unknown')}` }))
        .subscribe([
          'SELECT * FROM ops_person',
          'SELECT * FROM ops_sos_event',
          'SELECT * FROM ops_assignment',
        ]);
    })
    .onConnectError((_ctx, err) => setLiveStatus({ state: 'error', message: `Could not connect: ${err.message}` }))
    .onDisconnect((_ctx, err) => {
      if (err) setLiveStatus({ state: 'error', message: `Disconnected: ${err.message}` });
    })
    .build();
}
