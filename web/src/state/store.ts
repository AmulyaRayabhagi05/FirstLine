import { create } from 'zustand';
import { homes, statusAt, type Status } from '../sim/world';

export type DemoPhase = 'off' | 'sweep' | 'flatten' | 'play';

export interface MapState {
  T: number; // hours after 22:00
  playing: boolean;
  dimTarget: number; // 0 = flat 2D map, 1 = 3D city
  selectedId: number | null;
  demo: DemoPhase;
  finale: boolean;
  showBeams: boolean;
  showZone: boolean;
  showNames: boolean;
  statuses: Status[];
  version: number; // bumps when any status changes
  cam: { x: number; z: number; theta: number }; // for the minimap
  setT: (t: number) => void;
  setPlaying: (v: boolean) => void;
  setDim: (d: number) => void;
  select: (id: number | null) => void;
  setDemo: (p: DemoPhase) => void;
  setFinale: (v: boolean) => void;
  toggle: (k: 'showBeams' | 'showZone' | 'showNames') => void;
  setCam: (c: { x: number; z: number; theta: number }) => void;
  panTo: { x: number; z: number; n: number } | null;
  requestPan: (x: number, z: number) => void;
  intro: boolean;
  setIntro: (v: boolean) => void;
  layersOpen: boolean;
  setLayersOpen: (v: boolean) => void;
}

const computeStatuses = (t: number) => homes.map((h) => statusAt(h, t));

export const useMap = create<MapState>((set, get) => ({
  T: 0, // the city is quiet behind the intro; the night starts when the user enters
  playing: false,
  dimTarget: 1,
  selectedId: null,
  demo: 'off',
  finale: false,
  showBeams: true,
  showZone: true,
  showNames: true,
  statuses: computeStatuses(0),
  version: 0,
  cam: { x: 0, z: 0, theta: 0.75 },
  panTo: null,
  setT: (t) => {
    const T = Math.max(0, Math.min(8, t));
    const prev = get().statuses;
    const next = computeStatuses(T);
    const changed = next.some((s, i) => s !== prev[i]);
    set(changed ? { T, statuses: next, version: get().version + 1 } : { T });
  },
  setPlaying: (v) => set((s) => ({ playing: v, T: v && s.T >= 7.95 ? 0 : s.T })),
  setDim: (d) => set({ dimTarget: Math.max(0, Math.min(1, d)) }),
  select: (id) => set({ selectedId: id }),
  setDemo: (p) => set({ demo: p }),
  setFinale: (v) => set({ finale: v }),
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<MapState>),
  setCam: (c) => set({ cam: c }),
  requestPan: (x, z) => set((s) => ({ panTo: { x, z, n: (s.panTo?.n ?? 0) + 1 } })),
  intro: true,
  setIntro: (v) => set({ intro: v }),
  layersOpen: false,
  setLayersOpen: (v) => set({ layersOpen: v }),
}));

// Decisions worth surfacing to a person: triage to P1, escalations and reassignments. Routine check-ins stay quiet.
export const isKeyDecision = (e: { status: string; text: string; agent: string }) =>
  e.status === 'p1' || /escalat|timed out|next ring/.test(e.text);

export function counts(statuses: Status[]) {
  const c = { p1: 0, p2: 0, unknown: 0, enroute: 0, safe: 0, normal: 0 };
  for (const s of statuses) c[s]++;
  return { ...c, unreached: c.p1 + c.p2 + c.unknown };
}

export const STATUS_LABEL: Record<Status, string> = {
  p1: 'P1 · help now',
  p2: 'Silent risk',
  unknown: 'Not reached',
  enroute: 'Neighbor en route',
  safe: 'Checked in safe',
  normal: 'No alert',
};
export const STATUS_COLOR: Record<Status, string> = {
  p1: '#ff3b4e',
  p2: '#ff9a3c',
  unknown: '#f4d35e',
  enroute: '#5aa9ff',
  safe: '#4fe08f',
  normal: '#5c5c6c',
};
