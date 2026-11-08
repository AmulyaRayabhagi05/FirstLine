// Meshtastic LoRa -> MQTT -> FirstLine bridge.
//
// A Meshtastic gateway node with MQTT + "JSON enabled" publishes every packet it hears to
//   <root>/2/json/<CHANNEL>/<!gatewayId>        (root defaults to msh/<REGION>, e.g. msh/US)
// as JSON: { id, channel, from, to, sender, timestamp, type, payload }.
//   type "text":     payload { text }
//   type "position": payload { latitude_i, longitude_i, altitude?, time? }  (degrees * 1e7)
// Downlink: publish to <root>/2/json/mqtt/ with
//   { from: <gateway node num>, to?: <dest node num>, channel?: <idx>, type: "sendtext", payload: "<text>" }
// which needs a channel named "mqtt" with downlink enabled on the gateway.

import mqtt from "mqtt";
import { z } from "zod";
import { handleInboundText, type InboundOutcome } from "./inbound.js";
import { inboundLimiter, type RateLimiter } from "./ratelimit.js";
import type { ChannelPerson, ChannelStore } from "./store.js";
import type { MessagingTool } from "./twilio.js";

/** Subset of mqtt.MqttClient the bridge uses (so tests can pass a fake). */
export interface MqttLike {
  subscribe(topic: string | string[], cb?: (err: Error | null) => void): unknown;
  publish(topic: string, message: string, cb?: (err?: Error) => void): unknown;
  on(event: "message", cb: (topic: string, payload: Buffer) => void): unknown;
  end?(force?: boolean): unknown;
}

export interface MeshPacket {
  id: number;
  channel?: number;
  from: number;
  to?: number;
  sender?: string;
  timestamp?: number;
  type: string;
  payload: unknown;
}

export interface MeshBridgeOptions {
  store: ChannelStore;
  client: MqttLike;
  /** Topic root, default "msh/US". */
  root?: string;
  /** Gateway node number (decimal) used as `from` on downlinks; replies are skipped if unset. */
  gatewayNode?: number;
  /** Channel index used for downlinks (default 0). */
  channelIndex?: number;
  /** Map a node ("!a1b2c3d4") to a registered person. */
  resolveNode?: (nodeId: string) => Promise<ChannelPerson | undefined>;
  /** Max packet ids remembered for de-duplication. */
  dedupeSize?: number;
  /** Per-node limit on FirstLine commands (default 10 per 10 minutes). */
  limiter?: RateLimiter;
  log?: (msg: string) => void;
}

export const nodeIdOf = (num: number) => `!${(num >>> 0).toString(16).padStart(8, "0")}`;

export function parseNodeNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  const n = s.startsWith("!") ? parseInt(s.slice(1), 16) : Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** "!a1b2c3d4=14,!0000beef=22" -> resolver (MESH_NODE_MAP env, for the demo). */
export function nodeMapResolver(
  spec: string | undefined,
  getPerson: (id: number) => Promise<ChannelPerson | undefined>,
) {
  const map = new Map<string, number>();
  for (const pair of (spec ?? "").split(",")) {
    const [node, id] = pair.split("=").map((x) => x?.trim());
    if (node && id && Number(id) > 0) map.set(node.toLowerCase(), Number(id));
  }
  return async (nodeId: string) => {
    const id = map.get(nodeId.toLowerCase());
    return id ? getPerson(id) : undefined;
  };
}

export type MeshHandleResult =
  | { status: "duplicate" | "ignored" | "position" }
  | { status: "handled"; outcome: InboundOutcome };

export class MeshtasticBridge {
  private readonly root: string;
  private readonly seen = new Set<string>();
  private readonly positions = new Map<string, { lat: number; lng: number }>();
  private readonly log: (msg: string) => void;
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: MeshBridgeOptions) {
    this.root = (opts.root ?? "msh/US").replace(/\/$/, "");
    this.log = opts.log ?? ((m) => console.log(`[mesh] ${m}`));
    this.limiter = opts.limiter ?? inboundLimiter();
  }

  get uplinkTopic() {
    return `${this.root}/2/json/+/+`;
  }

  get downlinkTopic() {
    return `${this.root}/2/json/mqtt/`;
  }

  start() {
    this.opts.client.on("message", (topic, payload) => {
      this.handleMessage(topic, payload).catch((err) => this.log(`error: ${String(err)}`));
    });
    this.opts.client.subscribe(this.uplinkTopic, (err) => {
      if (err) this.log(`subscribe failed: ${err.message}`);
      else this.log(`subscribed ${this.uplinkTopic}`);
    });
  }

  /** Last known position of a node, from position packets. */
  positionOf(nodeId: string) {
    return this.positions.get(nodeId);
  }

  async handleMessage(topic: string, payload: Buffer | string): Promise<MeshHandleResult> {
    // Ignore our own downlink topic and anything that is not JSON uplink.
    if (topic.startsWith(this.downlinkTopic) || !topic.includes("/2/json/")) return { status: "ignored" };
    let pkt: MeshPacket;
    try {
      pkt = JSON.parse(payload.toString());
    } catch {
      return { status: "ignored" };
    }
    if (typeof pkt?.id !== "number" || typeof pkt?.from !== "number" || typeof pkt?.type !== "string") {
      return { status: "ignored" };
    }
    const nodeId = nodeIdOf(pkt.from);
    if (this.opts.gatewayNode !== undefined && (pkt.from >>> 0) === (this.opts.gatewayNode >>> 0) && pkt.type === "text") {
      // Our own downlinks echo back through the gateway.
      return { status: "ignored" };
    }

    // Several gateways can hear the same packet: de-dupe by sender + packet id.
    const key = `${nodeId}:${pkt.id >>> 0}`;
    if (this.seen.has(key)) return { status: "duplicate" };
    this.remember(key);

    if (pkt.type === "position") {
      const p = pkt.payload as { latitude_i?: number; longitude_i?: number };
      if (typeof p?.latitude_i === "number" && typeof p?.longitude_i === "number") {
        const lat = p.latitude_i / 1e7;
        const lng = p.longitude_i / 1e7;
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          this.positions.delete(nodeId);
          this.positions.set(nodeId, { lat, lng });
          // Anyone on a public MQTT broker can publish positions: keep the map bounded.
          while (this.positions.size > (this.opts.dedupeSize ?? 5000)) {
            const first = this.positions.keys().next().value;
            if (first === undefined) break;
            this.positions.delete(first);
          }
        }
      }
      return { status: "position" };
    }
    if (pkt.type !== "text") return { status: "ignored" };

    const raw =
      typeof pkt.payload === "string" ? pkt.payload : String((pkt.payload as { text?: unknown })?.text ?? "");
    const text = raw.slice(0, 500); // LoRa text is ~230 bytes; anything longer is not from a radio
    const person = await this.opts.resolveNode?.(nodeId);
    const isCommand = /^\s*fl\b/i.test(text);
    // Plain chatter on the mesh from unknown nodes is not for us; don't reply (avoids loops).
    if (!isCommand && !person) return { status: "ignored" };
    // MQTT packets are not authenticated (any client can publish any `from`), so cap how much
    // one node can trigger. Over the limit: drop silently (no reply, no reducer call).
    if (!this.limiter.allow(`mesh:${nodeId}`)) {
      this.log(`${nodeId} rate limited`);
      return { status: "ignored" };
    }

    const { outcome } = await handleInboundText(this.opts.store, {
      clientId: `mesh:${key}`,
      text,
      channel: "mesh",
      person,
      position: this.positions.get(nodeId),
    });
    // No message text in logs: SOS texts carry health details.
    this.log(`${nodeId} (${text.length} chars) -> ${outcome.action}`);
    if (outcome.action !== "rejected" || isCommand) {
      await this.sendText(shortReply(outcome), pkt.from).catch((e) => this.log(`reply failed: ${String(e)}`));
    }
    return { status: "handled", outcome };
  }

  /** Publish a downlink text. `to` omitted = broadcast on the channel. */
  sendText(text: string, to?: number | string): Promise<void> {
    if (this.opts.gatewayNode === undefined) {
      this.log(`downlink skipped (MESH_GATEWAY_NODE unset): ${text}`);
      return Promise.resolve();
    }
    const dest = typeof to === "string" ? parseNodeNum(to) : to;
    const msg: Record<string, unknown> = {
      from: this.opts.gatewayNode >>> 0,
      type: "sendtext",
      payload: text.slice(0, 200), // LoRa text payloads are ~230 bytes max
    };
    if (dest !== undefined) msg.to = dest >>> 0;
    if (this.opts.channelIndex !== undefined) msg.channel = this.opts.channelIndex;
    return new Promise((resolve, reject) =>
      this.opts.client.publish(this.downlinkTopic, JSON.stringify(msg), (err) => (err ? reject(err) : resolve())),
    );
  }

  private remember(key: string) {
    this.seen.add(key);
    const max = this.opts.dedupeSize ?? 5000;
    if (this.seen.size > max) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }
}

function shortReply(o: InboundOutcome): string {
  if (o.action === "sos") return "FL: help request received";
  if (o.action === "check_in") return "FL: marked safe, thank you";
  return 'FL: not understood. Send "FL SOS", "FL OK" or "FL HELP <need>"';
}

const meshSendInput = z.object({
  text: z.string().min(1).max(200).describe('Short text, e.g. "check on #14"'),
  toNode: z.string().optional().describe('Destination node id like "!a1b2c3d4"; omit to broadcast on the channel'),
});

/** Agent tool: send a text to the mesh (e.g. ask a neighbor with a radio to check on someone). */
export function makeMeshSendTool(bridge: MeshtasticBridge): MessagingTool<typeof meshSendInput, { sent: true }> {
  return {
    name: "mesh_send_text",
    description: "Send a short text over the Meshtastic LoRa mesh (works when cell networks are down).",
    inputSchema: meshSendInput,
    run: async ({ text, toNode }) => {
      await bridge.sendText(text, toNode);
      return { sent: true };
    },
  };
}

/** Connects to MQTT_URL and starts the bridge. */
export function startMeshBridgeFromEnv(
  store: ChannelStore,
  getPerson: (id: number) => Promise<ChannelPerson | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): MeshtasticBridge {
  const url = env.MQTT_URL;
  if (!url) throw new Error("MQTT_URL is not set");
  const client = mqtt.connect(url, {
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    reconnectPeriod: 2000,
  });
  const bridge = new MeshtasticBridge({
    store,
    client,
    root: env.MESH_ROOT_TOPIC ?? "msh/US",
    gatewayNode: parseNodeNum(env.MESH_GATEWAY_NODE),
    channelIndex: env.MESH_CHANNEL_INDEX ? Number(env.MESH_CHANNEL_INDEX) : undefined,
    resolveNode: nodeMapResolver(env.MESH_NODE_MAP, getPerson),
  });
  client.on("connect", () => console.log(`[mesh] connected ${url}`));
  bridge.start();
  return bridge;
}
