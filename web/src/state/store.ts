import { create } from 'zustand';
import { homes, type Status } from '../sim/world';

export type DemoPhase = 'off' | 'sweep' | 'flatten' | 'play';

/** One agent reasoning step from ops_agent_step, tied to a home when its subject resolves to one. */
export interface AgentLine {
  at: number; // ms since epoch
  agent: string;
  kind: string;
  text: string;
  conf: number | null;
  subject: string;
  homeIdx: number | null;
}

/** The household shown on a map home, built from SpacetimeDB rows. */
export interface Resident {
  householdId: string;
  address: string;
  neighborhood: string;
  name: string; // the most at-risk person in the household
  age: number;
  people: number;
  alone: boolean;
  device: boolean;
  mobility: string;
  medical: string;
  smart: boolean;
  language: string;
  priority: string;
  priorityScore: number;
  status: Status;
  powerOut: boolean;
  lastSeen: number | null;
  lastContactVia: string | null;
  helper: string | null;
  net: { name: string; status: Status }[];
  log: AgentLine[];
}

export interface IncidentReport {
  id: string;
  cell: string;
  summary: string;
  blockedRoads: string;
  p1: number;
  p2: number;
  unknown: number;
  at: number;
}

export interface LiveInfo {
  state: 'connecting' | 'subscribed' | 'error';
  message: string;
  identity: string;
  people: number;
  households: number;
  openSos: number;
  alertedCells: number;
  lastUpdate: number;
}

export interface MapState {
  T: number; // camera choreography clock for the demo (sweep, flatten, play), in arbitrary units
  playing: boolean;
  dimTarget: number; // 0 = flat 2D map, 1 = 3D city
  selectedId: number | null;
  demo: DemoPhase;
  finale: boolean;
  showBeams: boolean;
  showZone: boolean;
  showNames: boolean;
  statuses: Status[]; // per home, from residents
  residents: (Resident | null)[]; // per home; null = no registered household placed there
  feed: AgentLine[]; // newest last
  reports: IncidentReport[]; // newest first
  liveInfo: LiveInfo;
  version: number; // bumps when live data changes
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
  setLive: (data: { residents: (Resident | null)[]; feed: AgentLine[]; reports: IncidentReport[] }) => void;
  setLiveInfo: (info: Partial<LiveInfo>) => void;
}

export const useMap = create<MapState>((set, get) => ({
  T: 0,
  playing: false,
  dimTarget: 1,
  selectedId: null,
  demo: 'off',
  finale: false,
  showBeams: true,
  showZone: true,
  showNames: true,
  statuses: homes.map(() => 'normal'),
  residents: homes.map(() => null),
  feed: [],
  reports: [],
  liveInfo: { state: 'connecting', message: 'Connecting to SpacetimeDB…', identity: '', people: 0, households: 0, openSos: 0, alertedCells: 0, lastUpdate: 0 },
  version: 0,
  cam: { x: 0, z: 0, theta: 0.75 },
  panTo: null,
  setT: (t) => set({ T: Math.max(0, Math.min(8, t)) }),
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
  setLive: ({ residents, feed, reports }) =>
    set({
      residents,
      statuses: residents.map((r) => r?.status ?? 'normal'),
      feed,
      reports,
      version: get().version + 1,
    }),
  setLiveInfo: (info) => set((s) => ({ liveInfo: { ...s.liveInfo, ...info } })),
}));

// Agent decisions worth surfacing to a person in the ticker (the feed already holds decisions only).
export const isKeyDecision = (e: AgentLine) => e.kind === 'decision';

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
