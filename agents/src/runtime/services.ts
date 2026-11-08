// Real implementations of the agents' outside-world services, chosen from env:
//   weather + roads  <- live feeds (feeds/poller.ts onFeedEvent), kept in memory per cell
//   history          <- Tiger Data person_timeline / cell_trend (TIGER_DATABASE_URL)
//   comms            <- Twilio SMS + check-in calls (TWILIO_* env), otherwise logging stubs

import { cellToParent } from "h3-js";
import {
  StubComms,
  StubHistory,
  type CallRequest,
  type CommsService,
  type HistoryService,
  type RoadsService,
  type Services,
  type TimelineEvent,
  type VisitRequest,
  type WeatherAlert,
  type WeatherService,
} from "../agents/services.js";
import type { FeedEvent } from "../feeds/types.js";
import { createTwilioClient, sendSms, twilioConfigFromEnv, type TwilioConfig, type TwilioLike } from "../messaging/twilio.js";
import { placeCheckInCall } from "../messaging/voice.js";
import type { ChannelStore } from "../messaging/store.js";
import type { FirstLineStore, Id } from "../store/types.js";
import { channelPersonOf } from "./channels.js";

const res8 = (cell: string) => {
  try {
    return cellToParent(cell, 8);
  } catch {
    return cell;
  }
};

/** NWS alerts by res-9 cell, filled from the feed poller. */
export class FeedWeather implements WeatherService {
  private readonly byCell = new Map<string, Map<string, WeatherAlert & { expires?: number }>>();

  ingest(e: FeedEvent): boolean {
    if (e.source !== "nws_alerts") return false;
    const p = e.payload as Record<string, unknown>;
    const alert = {
      level: String(p.severity ?? p.event ?? "alert"),
      headline: String(p.headline ?? p.event ?? e.kind),
      expires: p.expires ? Date.parse(String(p.expires)) : undefined,
    };
    const key = String(p.id ?? alert.headline);
    for (const c of e.h3_cells) {
      for (const cell of [c, res8(c)]) {
        const m = this.byCell.get(cell) ?? new Map();
        m.set(key, alert);
        this.byCell.set(cell, m);
      }
    }
    return true;
  }

  async alertsForCell(h3Cell: string): Promise<WeatherAlert[]> {
    const now = Date.now();
    const out: WeatherAlert[] = [];
    for (const cell of new Set([h3Cell, res8(h3Cell)])) {
      for (const a of this.byCell.get(cell)?.values() ?? []) {
        if (a.expires && a.expires < now) continue;
        if (!out.some((x) => x.headline === a.headline)) out.push({ level: a.level, headline: a.headline });
      }
    }
    return out;
  }
}

const ROAD_RE = /(flood|high water|road|street|traffic hazard|blocked|downed|tree|wire|closure|stalled)/i;

/** Road problems from Dallas police calls (traffic hazards, high water, downed lines) by res-8 cell. */
export class FeedRoads implements RoadsService {
  private readonly byCell8 = new Map<string, Map<string, string>>();

  ingest(e: FeedEvent): boolean {
    if (e.source !== "dallas_police") return false;
    const p = e.payload as Record<string, unknown>;
    const nature = String(p.nature_of_call ?? "");
    if (!ROAD_RE.test(nature)) return false;
    const label = `${nature}${p.location ? ` at ${String(p.location)}` : ""}`.slice(0, 120);
    for (const c of e.h3_cells) {
      const cell8 = res8(c);
      const m = this.byCell8.get(cell8) ?? new Map();
      m.set(String(p.id ?? label), label);
      if (m.size > 20) m.delete(m.keys().next().value!);
      this.byCell8.set(cell8, m);
    }
    return true;
  }

  async blockedRoads(h3Cell8: string): Promise<string[]> {
    return [...(this.byCell8.get(h3Cell8)?.values() ?? [])];
  }
}

/** Tiger Data history via the feeds branch's SQL tools. */
export class TigerHistory implements HistoryService {
  async personTimeline(personId: Id): Promise<TimelineEvent[]> {
    const { personTimeline } = await import("../tiger/tools.js");
    const r = await personTimeline.run({ person_id: personId, hours: 24 });
    // Newest first from Tiger; agents take the tail, so return oldest first, summary last.
    const events: TimelineEvent[] = r.entries
      .slice(0, 40)
      .reverse()
      .map((e) => ({
        time: new Date(e.time),
        kind: e.type,
        detail: `${e.kind}${e.value !== undefined ? ` = ${e.value}` : ""}${e.detail ? ` (${e.detail})` : ""}`,
      }));
    events.push({ time: new Date(), kind: "summary", detail: r.summary });
    return events;
  }

  async cellTrend(h3Cell: string, hours: number) {
    const { cellTrend } = await import("../tiger/tools.js");
    const r = await cellTrend.run({ h3_cell: h3Cell, hours });
    return r.buckets.map((b) => ({ time: new Date(b.bucket), needsHelp: 0, unknown: 0, ...b }));
  }
}

/** Twilio SMS and automated check-in calls. Visit requests text the helper when one is named. */
export class TwilioComms implements CommsService {
  constructor(
    private readonly client: TwilioLike,
    private readonly cfg: TwilioConfig,
    private readonly store: FirstLineStore,
    private readonly channelStore: ChannelStore,
  ) {}

  async sendSms(to: string, body: string) {
    const r = await sendSms(this.client, this.cfg, to, body);
    return { id: String((r as { sid?: string }).sid ?? "sms") };
  }

  async requestCall(req: CallRequest) {
    const person = await this.store.getPerson(req.personId);
    if (!person) throw new Error(`person ${req.personId} not found`);
    if (!this.cfg.publicUrl) {
      // No public webhook URL for the voice flow: fall back to an SMS check-in.
      return this.sendSms(person.phone, "FirstLine check-in: are you OK? Reply FL OK, or FL HELP and what you need.");
    }
    const r = await placeCheckInCall({ store: this.channelStore, client: this.client, cfg: this.cfg }, channelPersonOf(person));
    return { id: r.callSid };
  }

  async requestVisit(req: VisitRequest) {
    const person = await this.store.getPerson(req.personId);
    const helper = req.helperId ? await this.store.getPerson(req.helperId) : undefined;
    if (!helper?.phone) {
      console.log(`[comms] visit requested for person ${req.personId} (no helper named)${logText(req.reason)}`);
      return { id: `visit-unrouted-${req.personId}` };
    }
    return this.sendSms(
      helper.phone,
      `FirstLine: please knock on ${person?.name ?? "your neighbor"}'s door and check they are OK. ${req.reason}`.slice(0, 300),
    );
  }
}

/**
 * Message bodies and reasons carry names, SOS texts and health details, so logs show them only
 * with COMMS_LOG_TEXT=1 (handy for a local demo); otherwise just the length.
 */
const logText = (text: string) => (process.env.COMMS_LOG_TEXT === "1" ? `: ${text}` : ` (${text.length} chars)`);

/** Logs instead of sending; used when Twilio is not configured. */
export class LoggingComms extends StubComms {
  override async sendSms(to: string, body: string) {
    console.log(`[comms:stub] SMS to ${to.slice(0, -4).replace(/\d/g, "•")}${to.slice(-4)}${logText(body)}`);
    return super.sendSms(to, body);
  }
  override async requestCall(req: CallRequest) {
    console.log(`[comms:stub] call person ${req.personId}${logText(req.reason)}`);
    return super.requestCall(req);
  }
  override async requestVisit(req: VisitRequest) {
    console.log(`[comms:stub] visit person ${req.personId}${logText(req.reason)}`);
    return super.requestVisit(req);
  }
}

export const twilioConfigured = (env: NodeJS.ProcessEnv) =>
  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);

export interface RuntimeServices {
  services: Services;
  weather: FeedWeather;
  roads: FeedRoads;
  twilio?: { client: TwilioLike; cfg: TwilioConfig };
  /** One line per service saying which implementation is live. */
  describe: string[];
}

export function buildServices(store: FirstLineStore, channelStore: ChannelStore, env: NodeJS.ProcessEnv = process.env): RuntimeServices {
  const weather = new FeedWeather();
  const roads = new FeedRoads();
  const describe: string[] = [];

  const history: HistoryService = env.TIGER_DATABASE_URL ? new TigerHistory() : new StubHistory();
  describe.push(`history: ${env.TIGER_DATABASE_URL ? "Tiger Data" : "stub (TIGER_DATABASE_URL not set)"}`);

  let comms: CommsService;
  let twilio: RuntimeServices["twilio"];
  if (twilioConfigured(env)) {
    const cfg = twilioConfigFromEnv(env);
    const client = createTwilioClient(cfg);
    twilio = { client, cfg };
    comms = new TwilioComms(client, cfg, store, channelStore);
    describe.push(`comms: Twilio SMS${cfg.publicUrl ? " + voice check-in calls" : " (calls fall back to SMS: PUBLIC_BASE_URL not set)"}`);
  } else {
    comms = new LoggingComms();
    describe.push("comms: logging stub (TWILIO_* not set)");
  }
  describe.push("weather/roads: live feeds when the poller runs, else empty");
  return { services: { weather, roads, history, comms }, weather, roads, twilio, describe };
}
