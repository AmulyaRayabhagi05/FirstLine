// Outside-world services the agents use as tools. Other branches own the real versions
// (feeds/: weather + roads, tiger/: history, messaging/: SMS + calls). The worker ships
// stubs so it runs and tests offline; index.ts swaps in real implementations at integration.

import type { Id } from "../store/types.js";

export interface WeatherAlert {
  level: string; // e.g. "warning", "watch"
  headline: string; // e.g. "Flash Flood Warning until 6 PM"
}

export interface WeatherService {
  alertsForCell(h3Cell: string): Promise<WeatherAlert[]>;
}

export interface RoadsService {
  /** Blocked or flooded road names inside a res-8 cell. */
  blockedRoads(h3Cell8: string): Promise<string[]>;
}

export interface TimelineEvent {
  time: Date;
  kind: string; // "contact", "reading", "feed"
  detail: string;
}

/** Tiger Data history (hypertables + SQL tools in docs/contract.md). */
export interface HistoryService {
  personTimeline(personId: Id): Promise<TimelineEvent[]>;
  cellTrend(h3Cell: string, hours: number): Promise<{ time: Date; needsHelp: number; unknown: number }[]>;
}

export interface CallRequest {
  personId: Id;
  phone: string;
  reason: string;
  language: string;
}

export interface VisitRequest {
  personId: Id;
  helperId?: Id;
  reason: string;
}

/** Messaging branch: SMS, automated voice calls, visit requests to helpers. */
export interface CommsService {
  sendSms(to: string, body: string): Promise<{ id: string }>;
  requestCall(req: CallRequest): Promise<{ id: string }>;
  requestVisit(req: VisitRequest): Promise<{ id: string }>;
}

export interface Services {
  weather: WeatherService;
  roads: RoadsService;
  history: HistoryService;
  comms: CommsService;
}

// ---------------- stubs ----------------

export class StubWeather implements WeatherService {
  constructor(public alerts: Record<string, WeatherAlert[]> = {}) {}
  async alertsForCell(h3Cell: string) {
    return this.alerts[h3Cell] ?? [];
  }
}

export class StubRoads implements RoadsService {
  constructor(public blocked: Record<string, string[]> = {}) {}
  async blockedRoads(h3Cell8: string) {
    return this.blocked[h3Cell8] ?? [];
  }
}

export class StubHistory implements HistoryService {
  constructor(public timelines: Record<number, TimelineEvent[]> = {}) {}
  async personTimeline(personId: Id) {
    return this.timelines[personId] ?? [];
  }
  async cellTrend() {
    return [];
  }
}

/** Records every request so tests and the offline demo can see what would have gone out. */
export class StubComms implements CommsService {
  readonly sms: { to: string; body: string }[] = [];
  readonly calls: CallRequest[] = [];
  readonly visits: VisitRequest[] = [];
  private n = 0;
  async sendSms(to: string, body: string) {
    this.sms.push({ to, body });
    return { id: `stub-sms-${++this.n}` };
  }
  async requestCall(req: CallRequest) {
    this.calls.push(req);
    return { id: `stub-call-${++this.n}` };
  }
  async requestVisit(req: VisitRequest) {
    this.visits.push(req);
    return { id: `stub-visit-${++this.n}` };
  }
}

export function stubServices(): Services & { comms: StubComms } {
  return { weather: new StubWeather(), roads: new StubRoads(), history: new StubHistory(), comms: new StubComms() };
}
