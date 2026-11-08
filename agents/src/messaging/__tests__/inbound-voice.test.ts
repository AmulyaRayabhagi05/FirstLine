import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMessagingServer } from "../server.js";
import { InMemoryChannelStore } from "../store.js";
import { MockTwilio } from "../twilio.js";
import type { VoiceAssistant } from "../inbound-voice.js";

let close: (() => void) | undefined;
afterEach(() => close?.());

const seen: string[] = [];
const assistant: VoiceAssistant = {
  greet: async ({ from }) => ({ say: `Hello ${from}`, lang: "en" }),
  reply: async ({ text, turn }) => {
    seen.push(text);
    return { say: `You said ${text} on turn ${turn}`, lang: "en", hangup: text.includes("done") };
  },
};

async function start(withAssistant = true) {
  const server = createMessagingServer({
    store: new InMemoryChannelStore([]),
    cfg: { allowUnsigned: true, publicUrl: "https://line.example" },
    client: new MockTwilio(),
    assistant: withAssistant ? assistant : undefined,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, params: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }).then((r) => r.text());

describe("inbound calls", () => {
  it("greets the caller and listens for speech", async () => {
    const base = await start();
    const xml = await post(`${base}/voice/inbound`, { CallSid: "CA1", From: "+14142415496" });
    expect(xml).toContain("Hello +14142415496");
    expect(xml).toContain('input="speech dtmf"');
    expect(xml).toContain('action="https://line.example/voice/converse?turn=1&amp;lang=en&amp;empty=0"');
  });

  it("answers each turn and keeps listening", async () => {
    const base = await start();
    const xml = await post(`${base}/voice/converse?turn=1&lang=en&empty=0`, { CallSid: "CA1", From: "+1414", SpeechResult: "who needs help first" });
    expect(xml).toContain("You said who needs help first on turn 1");
    expect(xml).toContain("turn=2");
    expect(xml).not.toContain("<Hangup");
  });

  it("re-prompts once on silence, then says goodbye", async () => {
    const base = await start();
    const once = await post(`${base}/voice/converse?turn=2&lang=en&empty=0`, { CallSid: "CA1", From: "+1" });
    expect(once).toContain("I did not hear anything");
    expect(once).toContain("empty=1");
    const twice = await post(`${base}/voice/converse?turn=2&lang=en&empty=1`, { CallSid: "CA1", From: "+1" });
    expect(twice).toContain("<Hangup");
  });

  it("hangs up on goodbye without asking the model", async () => {
    const base = await start();
    seen.length = 0;
    const xml = await post(`${base}/voice/converse?turn=3&lang=en&empty=0`, { CallSid: "CA1", From: "+1", SpeechResult: "okay thanks, bye" });
    expect(xml).toContain("<Hangup");
    expect(seen).toHaveLength(0);
  });

  it("without an assistant tells the caller to call 911", async () => {
    const base = await start(false);
    const xml = await post(`${base}/voice/inbound`, { CallSid: "CA9", From: "+1" });
    expect(xml).toContain("call 9 1 1");
    expect(xml).toContain("<Hangup");
  });
});
