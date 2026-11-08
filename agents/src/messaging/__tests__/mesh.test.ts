import { describe, expect, it } from "vitest";
import { MeshtasticBridge, makeMeshSendTool, nodeIdOf, nodeMapResolver, parseNodeNum, type MqttLike } from "../meshtastic-bridge.js";
import { InMemoryChannelStore, type ChannelPerson } from "../store.js";

class FakeMqtt implements MqttLike {
  subscriptions: string[] = [];
  published: { topic: string; message: string }[] = [];
  private handlers: ((topic: string, payload: Buffer) => void)[] = [];
  subscribe(topic: string | string[], cb?: (err: Error | null) => void) {
    this.subscriptions.push(...[topic].flat());
    cb?.(null);
  }
  publish(topic: string, message: string, cb?: (err?: Error) => void) {
    this.published.push({ topic, message });
    cb?.();
  }
  on(_event: "message", cb: (topic: string, payload: Buffer) => void) {
    this.handlers.push(cb);
  }
  emit(topic: string, obj: unknown) {
    for (const h of this.handlers) h(topic, Buffer.from(JSON.stringify(obj)));
  }
}

const GATEWAY = 0x7efeee00; // 2130636288
const RADIO = 0xa1b2c3d4;
const ruth: ChannelPerson = { id: 40, name: "Ruth", phone: "", language: "en", lastLat: 32.7, lastLng: -96.7 };
const TOPIC = "msh/US/2/json/LongFast/!7efeee00";

function setup() {
  const store = new InMemoryChannelStore([ruth]);
  const client = new FakeMqtt();
  const resolveNode = nodeMapResolver("!a1b2c3d4=40", async (id) => (id === 40 ? ruth : undefined));
  const bridge = new MeshtasticBridge({ store, client, gatewayNode: GATEWAY, resolveNode, log: () => {} });
  return { store, client, bridge };
}

const text = (id: number, t: string, from = RADIO) => ({
  id, channel: 0, from, to: -1, sender: "!7efeee00", timestamp: 1762600000, type: "text", payload: { text: t },
});

describe("Meshtastic bridge", () => {
  it("subscribes to the JSON uplink topic", () => {
    const { client, bridge } = setup();
    bridge.start();
    expect(client.subscriptions).toEqual(["msh/US/2/json/+/+"]);
  });

  it("node ids convert both ways", () => {
    expect(nodeIdOf(GATEWAY)).toBe("!7efeee00");
    expect(parseNodeNum("!7efeee00")).toBe(GATEWAY);
    expect(parseNodeNum("2130636288")).toBe(GATEWAY);
  });

  it("FL SOS with coordinates -> press_sos(mesh) and a DM reply to the radio", async () => {
    const { store, client, bridge } = setup();
    const r = await bridge.handleMessage(TOPIC, JSON.stringify(text(101, "FL SOS 32.78,-96.80 2ppl insulin")));
    expect(r.status).toBe("handled");
    expect(store.sos).toEqual([
      { clientId: "mesh:!a1b2c3d4:101", personId: 40, message: "SOS (2 people): insulin", lat: 32.78, lng: -96.8, channel: "mesh" },
    ]);
    expect(client.published).toHaveLength(1);
    expect(client.published[0].topic).toBe("msh/US/2/json/mqtt/");
    expect(JSON.parse(client.published[0].message)).toEqual({
      from: GATEWAY, to: RADIO, type: "sendtext", payload: "FL: help request received",
    });
  });

  it("uses the node's last position packet when the SOS has no coordinates", async () => {
    const { store, bridge } = setup();
    await bridge.handleMessage(TOPIC, JSON.stringify({
      id: 200, from: RADIO, type: "position", payload: { latitude_i: 327812345, longitude_i: -968012345, altitude: 150 },
    }));
    expect(bridge.positionOf("!a1b2c3d4")).toEqual({ lat: 32.7812345, lng: -96.8012345 });
    await bridge.handleMessage(TOPIC, JSON.stringify(text(201, "FL SOS water in the house")));
    expect(store.sos[0]).toMatchObject({ lat: 32.7812345, lng: -96.8012345, message: "SOS: water in the house" });
  });

  it("FL OK -> check_in(mesh, safe)", async () => {
    const { store, bridge } = setup();
    await bridge.handleMessage(TOPIC, JSON.stringify(text(300, "FL OK")));
    expect(store.checkIns).toEqual([{ clientId: "mesh:!a1b2c3d4:300", personId: 40, kind: "mesh", result: "safe", note: "" }]);
  });

  it("de-dupes the same packet heard by two gateways", async () => {
    const { store, client, bridge } = setup();
    await bridge.handleMessage(TOPIC, JSON.stringify(text(400, "FL HELP need generator fuel")));
    const again = await bridge.handleMessage("msh/US/2/json/LongFast/!0000beef", JSON.stringify(text(400, "FL HELP need generator fuel")));
    expect(again.status).toBe("duplicate");
    expect(store.sos).toHaveLength(1);
    expect(client.published).toHaveLength(1);
  });

  it("ignores chatter from unknown nodes, garbage, and its own downlink echo", async () => {
    const { store, client, bridge } = setup();
    expect((await bridge.handleMessage(TOPIC, JSON.stringify(text(500, "anyone up?", 0x1234)))).status).toBe("ignored");
    expect((await bridge.handleMessage(TOPIC, "not json")).status).toBe("ignored");
    expect((await bridge.handleMessage(TOPIC, JSON.stringify(text(501, "FL: help request received", GATEWAY)))).status).toBe("ignored");
    expect((await bridge.handleMessage("msh/US/2/json/mqtt/", JSON.stringify(text(502, "FL OK")))).status).toBe("ignored");
    expect(store.sos).toHaveLength(0);
    expect(store.checkIns).toHaveLength(0);
    expect(client.published).toHaveLength(0);
  });

  it("unknown node with a FL SOS still gets through as person 0", async () => {
    const { store, bridge } = setup();
    await bridge.handleMessage(TOPIC, JSON.stringify(text(600, "FL SOS 32.70,-96.70 roof", 0x5555)));
    expect(store.sos[0]).toMatchObject({ personId: 0, lat: 32.7, channel: "mesh" });
  });

  it("free text from a mapped radio is an SOS for triage", async () => {
    const { store, bridge } = setup();
    await bridge.handleMessage(TOPIC, JSON.stringify(text(700, "se fue la luz, hace mucho calor")));
    expect(store.sos[0]).toMatchObject({ personId: 40, message: "se fue la luz, hace mucho calor", lat: 32.7 });
  });

  it("works end to end through the fake client's message event", async () => {
    const { store, client, bridge } = setup();
    bridge.start();
    client.emit(TOPIC, text(800, "FL OK"));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.checkIns).toHaveLength(1);
  });

  it("mesh_send_text tool publishes a downlink (broadcast or DM)", async () => {
    const { client, bridge } = setup();
    const tool = makeMeshSendTool(bridge);
    await tool.run(tool.inputSchema.parse({ text: "check on #14" }));
    await tool.run({ text: "check on #14", toNode: "!a1b2c3d4" });
    expect(client.published.map((p) => JSON.parse(p.message))).toEqual([
      { from: GATEWAY, type: "sendtext", payload: "check on #14" },
      { from: GATEWAY, to: RADIO, type: "sendtext", payload: "check on #14" },
    ]);
  });
});
