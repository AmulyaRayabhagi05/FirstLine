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
  /** The untruncated step text (the reasoning pop-up shows it). */
  full?: string;
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
  /** Every person in the household, for actions that write per person (mark safe, the flood demo). */
  members: { id: bigint; status: Status }[];
  /** Every agent step about this household (thoughts, tool calls, results, decisions). */
  reasoning: AgentLine[];
  /** Latest Nemotron triage of anyone in the household. */
  triage: TriageInfo | null;
  /** Latest helper assignment on the household's SOS events, any state. */
  assignment: AssignmentInfo | null;
  /** Latest key pass to this household. */
  keyPass: KeyPassInfo | null;
  /** An SOS in the household is escalated to professional responders. */
  escalated: boolean;
  /** Dashboard requests the agents ran for this household, newest first. */
  actions: ActionInfo[];
  /** The latest claim timeline Nemotron wrote for this household. */
  claimTimeline: { at: number; text: string } | null;
}

export type ActionKind = 'respond' | 'call' | 'escalate' | 'send_neighbor' | 'claim_timeline';

export interface ActionInfo {
  id: string;
  action: ActionKind;
  state: string; // pending | done | failed
  result: string;
  at: number;
}

export interface TriageInfo {
  urgency: number; // 1-5
  confidence: number; // 0-1
  needs: string; // 'neighbor' | 'professional'
  priority: string;
  reason: string;
  model: string;
  at: number;
}

export interface AssignmentInfo {
  state: string; // 'offered' | 'accepted' | 'declined' | 'timed_out' | 'done'
  helper: string;
  ring: number;
  at: number;
}

export interface KeyPassInfo {
  helper: string;
  approvedBy: string;
  grantedAt: number;
  expiresAt: number;
  revoked: boolean;
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
  triaged: number;
  agentSteps: number;
  activeKeyPasses: number;
  lastUpdate: number;
  /** Connected with the public read-only viewer token: can read, cannot write. */
  viewer: boolean;
  /** This event's response, measured from the database: everyone who asked for help in the last 12 h. */
  wave: WaveStat | null;
}

export interface WaveStat {
  people: number; // distinct people with an SOS in the window
  triaged: number; // of those, triaged by Nemotron
  minutes: number; // first SOS to latest triage (or to now while some are untriaged)
  neighbors: number; // SOS events with a neighbor offered or on the way
  escalated: number; // SOS events escalated to professional responders
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
  resetLive: () => void;
  /** True once the person has signed in (or chose to look without data) for this visit. */
  signedIn: boolean;
  setSignedIn: (v: boolean) => void;
  /** A viewer asked for the staff sign-in screen (so it does not auto-close on read access). */
  wantStaff: boolean;
  setWantStaff: (v: boolean) => void;
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
  liveInfo: { state: 'connecting', message: 'Connecting to SpacetimeDB…', identity: '', people: 0, households: 0, openSos: 0, alertedCells: 0, triaged: 0, agentSteps: 0, activeKeyPasses: 0, lastUpdate: 0, viewer: false, wave: null },
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
  resetLive: () =>
    set((s) => ({
      residents: homes.map(() => null),
      statuses: homes.map(() => 'normal'),
      feed: [],
      reports: [],
      selectedId: null,
      version: s.version + 1,
      liveInfo: { state: 'connecting', message: 'Connecting to SpacetimeDB…', identity: '', people: 0, households: 0, openSos: 0, alertedCells: 0, triaged: 0, agentSteps: 0, activeKeyPasses: 0, lastUpdate: 0, viewer: false, wave: null },
    })),
  signedIn: false,
  setSignedIn: (v) => set({ signedIn: v }),
  wantStaff: false,
  setWantStaff: (v) => set({ wantStaff: v }),
}));

/** True while any household in the river flood zone needs help: the red band and dashed edge show only then. */
export function floodActive(statuses: Status[]): boolean {
  return homes.some((h) => h.danger && (statuses[h.idx] === 'p1' || statuses[h.idx] === 'p2' || statuses[h.idx] === 'unknown'));
}

// Agent decisions worth surfacing to a person in the ticker (the feed already holds decisions only).
export const isKeyDecision = (e: AgentLine) => e.kind === 'decision';

export function counts(statuses: Status[]) {
  const c = { p1: 0, p2: 0, unknown: 0, enroute: 0, safe: 0, normal: 0 };
  for (const s of statuses) c[s]++;
  return { ...c, unreached: c.p1 + c.p2 + c.unknown };
}

export const STATUS_LABEL: Record<Status, string> = {
  p1: 'Needs help now',
  p2: 'Silent risk',
  unknown: 'Not reached',
  enroute: 'Help on the way',
  safe: 'Checked in safe',
  normal: 'Safe',
};
// Green is the normal state of the city. Red means a household needs someone; blue means help is moving.
export const STATUS_COLOR: Record<Status, string> = {
  p1: '#ff3347',
  p2: '#ff5a4a',
  unknown: '#ff8a7a',
  enroute: '#4ea8ff',
  safe: '#3ee08a',
  normal: '#3ee08a',
};
