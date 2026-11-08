import { describe, expect, it } from "vitest";
import { InMemoryChannelStore, type ChannelPerson } from "../store.js";
import { MockTwilio } from "../twilio.js";
import {
  checkInTwiml,
  handleVoiceResult,
  handleVoiceStatus,
  makePlaceCheckInCallTool,
  placeCheckInCall,
  type ClassifyReply,
  type VoiceDeps,
} from "../voice.js";

const ruth: ChannelPerson = { id: 40, name: "Ruth", phone: "+12145550140", language: "en", lastLat: 32.7, lastLng: -96.7 };
const alma: ChannelPerson = { id: 14, name: "Alma", phone: "+12145550114", language: "es", lastLat: 32.79, lastLng: -96.81 };
const cfg = { fromNumber: "+15005550006", publicUrl: "https://example.ngrok.app" };

function deps(classifyReply?: ClassifyReply): VoiceDeps & { store: InMemoryChannelStore; client: MockTwilio } {
  const people = [ruth, alma];
  return {
    store: new InMemoryChannelStore(people),
    client: new MockTwilio(),
    cfg,
    classifyReply,
    getPerson: async (id) => people.find((p) => p.id === id),
  };
}

describe("check-in TwiML", () => {
  it("gathers dtmf + speech and asks about heat, CO and medical devices", () => {
    const xml = checkInTwiml(cfg, ruth);
    expect(xml).toContain('<Gather input="dtmf speech" numDigits="1"');
    expect(xml).toContain('action="https://example.ngrok.app/voice/result?personId=40&amp;lang=en&amp;attempt=0"');
    expect(xml).toContain("Hello Ruth");
    expect(xml).toMatch(/too hot/);
    expect(xml).toMatch(/carbon monoxide/);
    expect(xml).toMatch(/oxygen or another powered medical device/);
    expect(xml).toContain("Press 1 if you are okay. Press 2 if you need help.");
    expect(xml).toContain("noinput=1</Redirect>");
  });

  it("speaks Spanish for Spanish speakers", () => {
    const xml = checkInTwiml(cfg, alma);
    expect(xml).toContain('language="es-US"');
    expect(xml).toContain("Oprima 1 si está bien");
  });
});

describe("placeCheckInCall", () => {
  it("starts a Twilio call with inline TwiML and a status callback", async () => {
    const d = deps();
    const { callSid } = await placeCheckInCall(d, ruth);
    expect(callSid).toMatch(/^CAmock/);
    expect(d.client.placed[0]).toMatchObject({
      to: ruth.phone,
      from: cfg.fromNumber,
      statusCallback: "https://example.ngrok.app/voice/status?personId=40",
    });
    expect(d.client.placed[0].twiml).toContain("<Gather");
    expect(d.store.steps[0]).toMatchObject({ agent: "silent_signal", subject: "person:40", kind: "tool_call" });
  });

  it("is exposed as an agent tool keyed by personId", async () => {
    const d = deps();
    const tool = makePlaceCheckInCallTool({ ...d, getPerson: d.getPerson! });
    expect(tool.name).toBe("place_check_in_call");
    await tool.run(tool.inputSchema.parse({ personId: 14 }));
    expect(d.client.placed[0].to).toBe(alma.phone);
    await expect(tool.run({ personId: 999 })).rejects.toThrow("not found");
  });
});

describe("voice result webhook", () => {
  it("1 -> check_in safe", async () => {
    const d = deps();
    const r = await handleVoiceResult(d, { personId: 40, callSid: "CA1", digits: "1", lang: "en" });
    expect(r.outcome).toBe("safe");
    expect(r.twiml).toContain("<Hangup/>");
    expect(d.store.checkIns).toEqual([
      { clientId: "voice:CA1", personId: 40, kind: "voice", result: "safe", note: "Pressed 1 on check-in call" },
    ]);
  });

  it("2 -> press_sos on the voice channel at the person's last location", async () => {
    const d = deps();
    const r = await handleVoiceResult(d, { personId: 40, callSid: "CA2", digits: "2" });
    expect(r.outcome).toBe("needs_help");
    expect(d.store.sos).toEqual([
      { clientId: "voice:CA2", personId: 40, message: "Pressed 2 on check-in call: needs help", lat: 32.7, lng: -96.7, channel: "voice" },
    ]);
  });

  it("speech goes through the injected classifier", async () => {
    const seen: string[] = [];
    const classify: ClassifyReply = async (text) => {
      seen.push(text);
      return { result: "needs_help" };
    };
    const d = deps(classify);
    const r = await handleVoiceResult(d, { personId: 14, callSid: "CA3", lang: "es", speechResult: "Me caí y no me puedo levantar" });
    expect(seen).toEqual(["Me caí y no me puedo levantar"]);
    expect(r.outcome).toBe("needs_help");
    expect(r.twiml).toContain("Estamos avisando");
    expect(d.store.sos[0]).toMatchObject({ channel: "voice", personId: 14 });
    expect(d.store.steps.at(-1)).toMatchObject({ kind: "tool_result" });
  });

  it("default keyword stub understands 'I'm fine'", async () => {
    const d = deps();
    const r = await handleVoiceResult(d, { personId: 40, callSid: "CA4", speechResult: "I'm fine, thanks" });
    expect(r.outcome).toBe("safe");
  });

  it("unclear speech retries once, then escalates to a human check", async () => {
    const d = deps();
    const first = await handleVoiceResult(d, { personId: 40, callSid: "CA5", speechResult: "the cat", attempt: 0 });
    expect(first.outcome).toBe("retry");
    expect(first.twiml).toContain("did not understand");
    expect(first.twiml).toContain("attempt=1");
    expect(first.twiml).not.toContain("Hello Ruth");
    const second = await handleVoiceResult(d, { personId: 40, callSid: "CA5", speechResult: "the cat", attempt: 1 });
    expect(second.outcome).toBe("needs_help");
  });

  it("answered but silent -> check_in no_answer", async () => {
    const d = deps();
    const r = await handleVoiceResult(d, { personId: 40, callSid: "CA6", noInput: true });
    expect(r.outcome).toBe("no_answer");
    expect(d.store.checkIns[0]).toMatchObject({ result: "no_answer", kind: "voice" });
  });

  it("status callback: unanswered -> no_answer, completed -> ignored", async () => {
    const d = deps();
    expect(await handleVoiceStatus(d, { personId: 40, callSid: "CA7", callStatus: "no-answer" })).toBe("no_answer");
    expect(await handleVoiceStatus(d, { personId: 40, callSid: "CA8", callStatus: "completed" })).toBe("ignored");
    expect(d.store.checkIns).toEqual([
      { clientId: "voice:CA7", personId: 40, kind: "voice", result: "no_answer", note: "Call no-answer" },
    ]);
  });

  it("repeated webhook for the same CallSid is idempotent", async () => {
    const d = deps();
    await handleVoiceResult(d, { personId: 40, callSid: "CA9", digits: "1" });
    await handleVoiceResult(d, { personId: 40, callSid: "CA9", digits: "1" });
    expect(d.store.checkIns).toHaveLength(1);
  });
});
