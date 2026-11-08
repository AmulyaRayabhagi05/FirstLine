// Standalone runner: `npx tsx src/messaging/main.ts`.
// Uses the in-memory store until the coordinator swaps in the SpacetimeDB-backed FirstLineStore.

import { InMemoryChannelStore, type ChannelPerson } from "./store.js";
import { createTwilioClient, twilioConfigFromEnv } from "./twilio.js";
import { createMessagingServer } from "./server.js";
import { startMeshBridgeFromEnv } from "./meshtastic-bridge.js";

const demoPeople: ChannelPerson[] = process.env.DEMO_PHONE
  ? [{ id: 1, name: "Demo Neighbor", phone: process.env.DEMO_PHONE, language: "en", lastLat: 32.78, lastLng: -96.8 }]
  : [];

const store = new InMemoryChannelStore(demoPeople);
const getPerson = async (id: number) => store.people.find((p) => p.id === id);
const cfg = twilioConfigFromEnv();
const client = createTwilioClient(cfg);

const port = Number(process.env.MESSAGING_PORT ?? 8787);
createMessagingServer({ store, cfg, client, getPerson }).listen(port, () => {
  console.log(`[messaging] Twilio webhooks on :${port} (signature check ${cfg.authToken ? "on" : "OFF"})`);
});

if (process.env.MQTT_URL) startMeshBridgeFromEnv(store, getPerson);
