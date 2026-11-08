// Connection to SpacetimeDB for one resident's phone.
//
// The account is this phone's SpacetimeDB identity: the first visit creates one and its access key
// is kept on the phone. The server ties every person this phone registers to that identity, and the
// my_* views return only those people and their own SOS events, offers and safety net. Nothing
// about other residents ever reaches this app.
//
// SOS and check-ins go through an outbox first (stored on the phone with a client id), so pressing
// "I need help" with no signal still sends it the moment the phone reconnects. The server ignores
// a repeat of the same client id, so a retry can never send it twice.

import { useSyncExternalStore } from 'react';
import { DbConnection } from './module_bindings';

export const HOST = import.meta.env.VITE_SPACETIME_HOST || 'https://maincloud.spacetimedb.com';
export const DB = import.meta.env.VITE_SPACETIME_DB || 'firstline';
const TOKEN_KEY = 'firstline.resident.key';
const OUTBOX_KEY = 'firstline.resident.outbox';

export interface Me {
  id: bigint;
  name: string;
  age: number;
  status: string; // unknown | safe | needs_help
  priority: string;
  language: string;
  livesAlone: boolean;
  mobility: string;
  medicalNeeds: string;
  poweredDevice: boolean;
  lastLat: number;
  lastLng: number;
  lastSeen: number | null;
}
export interface MySos { id: bigint; personId: bigint; message: string; state: string; lat: number; lng: number; at: number | null }
export interface MyOffer { id: bigint; sosId: bigint; helperId: bigint; state: string; ring: number; at: number | null }

export type Outgoing =
  | { type: 'sos'; clientId: string; personId: string; message: string; lat: number; lng: number; at: number }
  | { type: 'check_in'; clientId: string; personId: string; result: 'safe' | 'needs_help'; note: string; at: number };

export interface State {
  phase: 'connecting' | 'ready' | 'offline' | 'error';
  error?: string;
  identity?: string;
  people: Me[];
  sos: MySos[];
  offers: MyOffer[];
  household?: { address: string; lat: number; lng: number };
  outbox: Outgoing[];
  /** True once the first subscription result arrived (so "no people yet" means a new account). */
  loaded: boolean;
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode: works for this visit only */
  }
};
const loadOutbox = (): Outgoing[] => {
  try {
    return JSON.parse(read(OUTBOX_KEY) ?? '[]') as Outgoing[];
  } catch {
    return [];
  }
};

let state: State = { phase: 'connecting', people: [], sos: [], offers: [], outbox: loadOutbox(), loaded: false };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  if (patch.outbox) write(OUTBOX_KEY, JSON.stringify(patch.outbox));
  listeners.forEach((l) => l());
}
export const useAppState = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);

let conn: DbConnection | null = null;

/** ?demo: a sample resident and a neighbor request, nothing sent anywhere (for demos and video). */
export const DEMO = new URLSearchParams(location.search).has('demo');
export function startDemo() {
  const now = Date.now();
  set({
    phase: 'ready', loaded: true, identity: 'demo',
    people: [{ id: 1n, name: 'Rosa Martinez', age: 81, status: 'unknown', priority: 'P2', language: 'es', livesAlone: true, mobility: 'limited', medicalNeeds: 'oxygen at night', poweredDevice: true, lastLat: 32.7457, lastLng: -96.8283, lastSeen: now - 3600_000 }],
    sos: [{ id: 90n, personId: 7n, message: 'No heat, very cold. No power for my oxygen/device', state: 'open', lat: 32.7462, lng: -96.8275, at: now - 600_000 }],
    offers: [{ id: 300n, sosId: 90n, helperId: 1n, state: 'offered', ring: 1, at: now - 300_000 }],
    household: { address: '1234 W Davis St, Dallas, TX', lat: 32.7457, lng: -96.8283 },
  });
}
function demoAct(fn: (s: State) => Partial<State>) {
  set(fn(state));
}
const ms = (t: { toDate(): Date } | undefined | null) => (t ? t.toDate().getTime() : null);

function snapshot(c: DbConnection) {
  const db = c.db;
  const people = [...db.myPerson.iter()]
    .map((p) => ({
      id: p.id, name: p.name, age: p.age, status: p.status, priority: p.priority, language: p.language, livesAlone: p.livesAlone,
      mobility: p.mobility, medicalNeeds: p.medicalNeeds, poweredDevice: p.poweredDevice, lastLat: p.lastLat, lastLng: p.lastLng, lastSeen: ms(p.lastSeen),
    }))
    .sort((a, b) => Number(a.id - b.id));
  const sos = [...db.mySosEvent.iter()].map((s) => ({ id: s.id, personId: s.personId, message: s.message, state: s.state, lat: s.lat, lng: s.lng, at: ms(s.createdAt) }));
  const offers = [...db.myAssignment.iter()].map((a) => ({ id: a.id, sosId: a.sosId, helperId: a.helperId, state: a.state, ring: a.ring, at: ms(a.offeredAt) }));
  const hh = [...db.myHousehold.iter()][0];
  set({ people, sos, offers, household: hh ? { address: hh.address, lat: hh.lat, lng: hh.lng } : undefined, loaded: true });
}

/** Connects with this phone's key (or a pasted one), creating a new identity on the first visit. */
export function connect(key: string | undefined = read(TOKEN_KEY) ?? undefined) {
  conn?.disconnect();
  set({ phase: 'connecting', error: undefined, loaded: false, people: [], sos: [], offers: [], household: undefined });
  const c = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB)
    .withToken(key)
    .onConnect((cn, identity, token) => {
      if (cn !== conn) return;
      write(TOKEN_KEY, token);
      set({ identity: identity.toHexString(), phase: 'ready' });
      const refresh = () => snapshot(cn);
      cn.subscriptionBuilder()
        .onApplied(() => {
          for (const t of [cn.db.myPerson, cn.db.mySosEvent, cn.db.myAssignment, cn.db.myHousehold] as const) {
            const tb = t as unknown as { onInsert(cb: () => void): void; onDelete(cb: () => void): void; onUpdate?: (cb: () => void) => void };
            tb.onInsert(refresh);
            tb.onDelete(refresh);
            tb.onUpdate?.(refresh);
          }
          refresh();
          void flushOutbox();
        })
        .onError((ctx) => set({ phase: 'error', error: `Could not load your details: ${String((ctx as { event?: unknown }).event ?? 'unknown error')}` }))
        .subscribe(['SELECT * FROM my_person', 'SELECT * FROM my_sos_event', 'SELECT * FROM my_assignment', 'SELECT * FROM my_household']);
    })
    .onConnectError((_ctx, err) => set({ phase: navigator.onLine ? 'error' : 'offline', error: err.message }))
    .onDisconnect(() => {
      if (conn === c) set({ phase: navigator.onLine ? 'error' : 'offline', error: 'Lost the connection. Reconnecting…' });
      if (conn === c) setTimeout(() => conn === c && connect(), 4000);
    })
    .build();
  conn = c;
}

window.addEventListener('online', () => {
  if (state.phase !== 'ready') connect();
});

/** This phone's access key, to sign in on another phone. Treat it like a password. */
export const accessKey = () => read(TOKEN_KEY);

export function signOut() {
  write(TOKEN_KEY, null);
  write(OUTBOX_KEY, null);
  set({ outbox: [] });
  connect(undefined);
}

function need(): DbConnection {
  if (!conn || state.phase !== 'ready') throw new Error('Not connected right now. Try again in a moment.');
  return conn;
}

export interface SignUp {
  name: string;
  age: number;
  livesAlone: boolean;
  mobility: 'ok' | 'limited' | 'cannot_walk';
  medicalNeeds: string;
  poweredDevice: boolean;
  hasSmartphone: boolean;
  language: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
}

export async function register(s: SignUp) {
  if (DEMO) return demoAct((st) => ({ people: [...st.people, { id: BigInt(st.people.length + 1), name: s.name, age: s.age, status: 'unknown', priority: 'unknown', language: s.language, livesAlone: s.livesAlone, mobility: s.mobility, medicalNeeds: s.medicalNeeds, poweredDevice: s.poweredDevice, lastLat: s.lat, lastLng: s.lng, lastSeen: Date.now() }] }));
  await need().reducers.registerPerson(s);
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Queues an SOS on the phone, then sends it (now, or when the connection is back). */
export function sendSos(personId: bigint, message: string, lat: number, lng: number) {
  queue({ type: 'sos', clientId: `app-sos-${newId()}`, personId: personId.toString(), message, lat, lng, at: Date.now() });
}

export function checkIn(personId: bigint, result: 'safe' | 'needs_help', note = '') {
  queue({ type: 'check_in', clientId: `app-ci-${newId()}`, personId: personId.toString(), result, note, at: Date.now() });
}

function queue(o: Outgoing) {
  if (DEMO) {
    const pid = BigInt(o.personId);
    if (o.type === 'sos') return demoAct((st) => ({ sos: [...st.sos, { id: BigInt(Date.now()), personId: pid, message: o.message, state: 'open', lat: o.lat, lng: o.lng, at: Date.now() }], people: st.people.map((p) => (p.id === pid ? { ...p, status: 'needs_help' } : p)) }));
    return demoAct((st) => ({ people: st.people.map((p) => (p.id === pid ? { ...p, status: o.result } : p)), sos: o.result === 'safe' ? st.sos.map((x) => (x.personId === pid ? { ...x, state: 'resolved' } : x)) : st.sos }));
  }
  set({ outbox: [...state.outbox, o] });
  void flushOutbox();
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !conn || state.phase !== 'ready') return;
  flushing = true;
  try {
    for (const o of [...state.outbox]) {
      try {
        if (o.type === 'sos')
          await conn.reducers.pressSos({ clientId: o.clientId, personId: BigInt(o.personId), message: o.message, lat: o.lat, lng: o.lng, channel: 'app' });
        else await conn.reducers.checkIn({ clientId: o.clientId, personId: BigInt(o.personId), kind: 'app', result: o.result, note: o.note });
        set({ outbox: state.outbox.filter((x) => x.clientId !== o.clientId) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A rule the server will never accept (e.g. too many open SOS): drop it and say why.
        if (/not allowed|already has|must be|not found/i.test(msg)) {
          set({ outbox: state.outbox.filter((x) => x.clientId !== o.clientId), error: msg });
        } else break; // offline or a hiccup: keep it and try again on reconnect
      }
    }
  } finally {
    flushing = false;
  }
}

export async function answerOffer(id: bigint, accept: boolean) {
  if (DEMO) return demoAct((st) => ({ offers: st.offers.map((o) => (o.id === id ? { ...o, state: accept ? 'accepted' : 'declined' } : o)) }));
  const c = need();
  if (accept) await c.reducers.acceptAssignment({ assignmentId: id });
  else await c.reducers.declineAssignment({ assignmentId: id });
}

export async function markSafe(personId: bigint) {
  if (DEMO) return demoAct((st) => ({ sos: st.sos.map((x) => (x.personId === personId ? { ...x, state: 'resolved' } : x)), offers: st.offers.map((o) => (o.state === 'accepted' ? { ...o, state: 'done' } : o)) }));
  await need().reducers.markSafe({ personId, note: 'from the FirstLine app' });
}

export async function shareLocation(personId: bigint, lat: number, lng: number) {
  if (DEMO) return;
  await need().reducers.updateLocation({ personId, lat, lng });
}

/** The phone's location, or null when it is off or refused. */
export function locate(timeoutMs = 10_000): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
