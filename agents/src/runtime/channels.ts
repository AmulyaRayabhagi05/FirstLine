// Maps the messaging branch's ChannelStore onto FirstLineStore, and starts the SMS/voice
// webhook server and Meshtastic bridge inside the worker process when configured.

import type { Server } from "node:http";
import { createMessagingServer } from "../messaging/server.js";
import { startMeshBridgeFromEnv, type MeshtasticBridge } from "../messaging/meshtastic-bridge.js";
import { normalizePhone, type ChannelPerson, type ChannelStore } from "../messaging/store.js";
import type { TwilioConfig, TwilioLike } from "../messaging/twilio.js";
import type { VoiceAssistant } from "../messaging/inbound-voice.js";
import type { FirstLineStore, Person } from "../store/types.js";

export const channelPersonOf = (p: Person): ChannelPerson => ({
  id: p.id,
  name: p.name,
  phone: p.phone,
  language: p.language,
  lastLat: p.lastLat,
  lastLng: p.lastLng,
});

export interface WorkerChannelStore extends ChannelStore {
  getPerson(id: number): Promise<ChannelPerson | undefined>;
}

export function channelStoreFor(store: FirstLineStore): WorkerChannelStore {
  return {
    async pressSos(args) {
      await store.pressSos(args);
    },
    checkIn: (args) => store.checkIn(args),
    logAgentStep: (args) => store.logAgentStep(args),
    async findPersonByPhone(phone) {
      const n = normalizePhone(phone);
      if (!n) return undefined;
      const p = (await store.listPeople()).find((x) => x.phone && normalizePhone(x.phone) === n);
      return p && channelPersonOf(p);
    },
    async getPerson(id) {
      const p = await store.getPerson(id);
      return p && channelPersonOf(p);
    },
  };
}

export interface StartedChannels {
  http?: Server;
  mesh?: MeshtasticBridge;
  describe: string[];
  stop(): void;
}

const flagOn = (v: string | undefined) => v !== "0" && v !== "false";

/**
 * SMS/voice: on when Twilio is configured, unless CHANNEL_SMS=0 (MESSAGING_PORT, default 8787).
 * Mesh: on when MQTT_URL is set, unless CHANNEL_MESH=0.
 */
export function startChannels(
  channelStore: WorkerChannelStore,
  twilio: { client: TwilioLike; cfg: TwilioConfig } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  assistant?: VoiceAssistant,
): StartedChannels {
  const describe: string[] = [];
  let http: Server | undefined;
  let mesh: MeshtasticBridge | undefined;

  if (twilio && flagOn(env.CHANNEL_SMS)) {
    const port = Number(env.MESSAGING_PORT ?? 8787);
    http = createMessagingServer({ store: channelStore, cfg: twilio.cfg, client: twilio.client, getPerson: channelStore.getPerson, assistant }).listen(port);
    describe.push(`sms/voice: webhooks on :${port} (signature check ${twilio.cfg.authToken ? "on" : "OFF"}; inbound calls ${assistant ? "answered by Nemotron" : "off"})`);
  } else {
    describe.push(`sms/voice: off (${twilio ? "CHANNEL_SMS=0" : "TWILIO_* not set"})`);
  }

  if (env.MQTT_URL && flagOn(env.CHANNEL_MESH)) {
    mesh = startMeshBridgeFromEnv(channelStore, channelStore.getPerson, env);
    describe.push("mesh: Meshtastic bridge on MQTT_URL");
  } else {
    describe.push(`mesh: off (${env.MQTT_URL ? "CHANNEL_MESH=0" : "MQTT_URL not set"})`);
  }

  return {
    http,
    mesh,
    describe,
    stop() {
      http?.close();
      (mesh as unknown as { stop?: () => void } | undefined)?.stop?.();
    },
  };
}
