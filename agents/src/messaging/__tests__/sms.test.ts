import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { afterEach, describe, expect, it } from "vitest";
import { createMessagingServer } from "../server.js";
import { InMemoryChannelStore, type ChannelPerson } from "../store.js";
import { MockTwilio, isValidTwilioRequest, makeSendSmsTool, smsTwiml, type TwilioConfig } from "../twilio.js";

const alma: ChannelPerson = { id: 14, name: "Alma", phone: "+12145550114", language: "es", lastLat: 32.79, lastLng: -96.81 };
const TOKEN = "test_auth_token_not_real";

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(cfg: TwilioConfig) {
  const store = new InMemoryChannelStore([alma]);
  const client = new MockTwilio();
  const server = createMessagingServer({ store, cfg, client, getPerson: async (id) => (id === 14 ? alma : undefined) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, client, base };
}

function post(url: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

describe("Twilio signature", () => {
  const url = "https://example.ngrok.app/sms";
  const params = { From: "+12145550114", Body: "PL OK", MessageSid: "SM1" };
  const good = twilio.getExpectedTwilioSignature(TOKEN, url, params);

  it("accepts a valid signature and rejects tampering", () => {
    expect(isValidTwilioRequest(TOKEN, good, url, params)).toBe(true);
    expect(isValidTwilioRequest(TOKEN, good, url, { ...params, Body: "PL SOS" })).toBe(false);
    expect(isValidTwilioRequest(TOKEN, undefined, url, params)).toBe(false);
  });

  it("skips validation when no token is configured", () => {
    expect(isValidTwilioRequest(undefined, undefined, url, params)).toBe(true);
  });

  it("server returns 403 on a bad signature and 200 on a good one", async () => {
    const { base, store } = await start({ authToken: TOKEN, publicUrl: "https://example.ngrok.app" });
    const bad = await post(`${base}/sms`, params, { "x-twilio-signature": "nope" });
    expect(bad.status).toBe(403);
    expect(store.checkIns).toHaveLength(0);
    const ok = await post(`${base}/sms`, params, { "x-twilio-signature": good });
    expect(ok.status).toBe(200);
    expect(store.checkIns).toHaveLength(1);
  });
});

describe("SMS webhook", () => {
  it("PL SOS from any number creates an sms SOS with coords and replies TwiML", async () => {
    const { base, store } = await start({});
    const res = await post(`${base}/sms`, { From: "+19725550000", Body: "PL SOS 32.78,-96.80 2ppl insulin", MessageSid: "SMa" });
    expect(res.headers.get("content-type")).toContain("text/xml");
    const body = await res.text();
    expect(body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Response><Message>Porchlight: help request received/);
    expect(store.sos).toEqual([
      { clientId: "sms:SMa", personId: 0, message: "SOS (2 people): insulin", lat: 32.78, lng: -96.8, channel: "sms" },
    ]);
  });

  it("PL OK from a known phone checks the person in as safe", async () => {
    const { base, store } = await start({});
    await post(`${base}/sms`, { From: "(214) 555-0114", Body: "PL OK", MessageSid: "SMb" });
    expect(store.checkIns).toEqual([{ clientId: "sms:SMb", personId: 14, kind: "sms", result: "safe", note: "" }]);
  });

  it("free Spanish text from a known phone becomes an SOS at their last location", async () => {
    const { base, store } = await start({});
    await post(`${base}/sms`, { From: "+12145550114", Body: "No hay luz y mi oxígeno se apaga", MessageSid: "SMc" });
    expect(store.sos[0]).toMatchObject({ personId: 14, message: "No hay luz y mi oxígeno se apaga", lat: 32.79, lng: -96.81 });
  });

  it("free text from an unknown phone is not an SOS", async () => {
    const { base, store } = await start({});
    const body = await (await post(`${base}/sms`, { From: "+15550001111", Body: "hello?", MessageSid: "SMd" })).text();
    expect(store.sos).toHaveLength(0);
    expect(body).toContain("we do not know this number");
  });

  it("malformed PL text gets a usage reply", async () => {
    const { base, store } = await start({});
    const body = await (await post(`${base}/sms`, { From: "+12145550114", Body: "PL DANCE", MessageSid: "SMe" })).text();
    expect(body).toContain("could not read that");
    expect(store.sos).toHaveLength(0);
  });

  it("is idempotent on a repeated MessageSid (Twilio retries)", async () => {
    const { base, store } = await start({});
    const p = { From: "+12145550114", Body: "PL HELP need insulin", MessageSid: "SMdup" };
    await post(`${base}/sms`, p);
    await post(`${base}/sms`, p);
    expect(store.sos).toHaveLength(1);
  });

  it("escapes reply text in TwiML", () => {
    expect(smsTwiml('a <b> & "c"')).toContain("<Message>a &lt;b&gt; &amp; \"c\"</Message>");
  });
});

describe("send_sms tool", () => {
  it("validates input and sends through the client", async () => {
    const client = new MockTwilio();
    const tool = makeSendSmsTool(client, { fromNumber: "+15005550006" });
    expect(tool.inputSchema.safeParse({ to: "+1", body: "" }).success).toBe(false);
    const out = await tool.run(tool.inputSchema.parse({ to: "+12145550114", body: "Neighbor on the way" }));
    expect(out.sid).toMatch(/^SMmock/);
    expect(client.sent).toEqual([{ to: "+12145550114", from: "+15005550006", body: "Neighbor on the way" }]);
  });

  it("fails clearly without a from number", async () => {
    const tool = makeSendSmsTool(new MockTwilio(), {});
    await expect(tool.run({ to: "+12145550114", body: "x" })).rejects.toThrow("TWILIO_FROM_NUMBER");
  });
});
