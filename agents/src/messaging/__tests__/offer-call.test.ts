import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMessagingServer } from "../server.js";
import { InMemoryChannelStore } from "../store.js";
import { MockTwilio } from "../twilio.js";
import { offerTwiml, placeOfferCall } from "../offer-call.js";

const cfg = { allowUnsigned: true, fromNumber: "+15005550006", publicUrl: "https://line.example" };
const req = { assignmentId: 7, phone: "+14695550000", helperName: "Sam Lee", personName: "Rosa Martinez", distanceKm: 0.02, message: "agua entrando" };

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(log: string[], fail = false) {
  const server = createMessagingServer({
    store: new InMemoryChannelStore([]),
    cfg,
    client: new MockTwilio(),
    offers: {
      accept: async (id) => {
        if (fail) throw new Error("not offered");
        log.push(`accept ${id}`);
        return { address: "412 N Tyler St" };
      },
      decline: async (id) => void log.push(`decline ${id}`),
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (url: string, params: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }).then((r) => r.text());

describe("neighbor offer call", () => {
  it("reads who needs help and how far, and asks for 1 or 2; no personal data in the URL", () => {
    const xml = offerTwiml(cfg, req);
    expect(xml).toContain("Hello Sam, this is FirstLine. Your neighbor Rosa Martinez needs help, about 20 meters from you.");
    expect(xml).toContain("They said: agua entrando.");
    expect(xml).toContain("Press 1 if you can go help now");
    expect(xml).toContain('action="https://line.example/voice/offer?assignmentId=7&amp;attempt=0"');
    expect(xml).not.toContain("Tyler");
  });

  it("places the call from the FirstLine number", async () => {
    const client = new MockTwilio();
    const r = await placeOfferCall(client, cfg, req);
    expect(r.callSid).toBeTruthy();
    expect((client as unknown as { calls: { created: { to: string }[] } }).calls.created?.[0]?.to ?? req.phone).toBe(req.phone);
  });

  it("1 accepts and reads the address; 2 declines", async () => {
    const log: string[] = [];
    const base = await start(log);
    const yes = await post(`${base}/voice/offer?assignmentId=7&attempt=0`, { Digits: "1", CallSid: "CA1" });
    expect(yes).toContain("You are on the way");
    expect(yes).toContain("412 N Tyler St");
    const no = await post(`${base}/voice/offer?assignmentId=8&attempt=0`, { Digits: "2", CallSid: "CA2" });
    expect(no).toContain("ask another neighbor");
    expect(log).toEqual(["accept 7", "decline 8"]);
  });

  it("asks once more on a wrong key, and handles an offer that already expired", async () => {
    const base = await start([], true);
    const again = await post(`${base}/voice/offer?assignmentId=7&attempt=0`, { Digits: "5", CallSid: "CA3" });
    expect(again).toContain("Sorry, I did not get that");
    expect(again).toContain("attempt=1");
    const gone = await post(`${base}/voice/offer?assignmentId=7&attempt=0`, { Digits: "1", CallSid: "CA4" });
    expect(gone).toContain("already handled");
  });
});
