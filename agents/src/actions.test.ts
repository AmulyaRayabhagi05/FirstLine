import { describe, expect, it } from "vitest";
import { AgentWorker } from "./index.js";
import { FakeLlm } from "./llm/fake.js";
import { InMemoryStore } from "./store/memory.js";
import { stubServices } from "./agents/services.js";
import { FirstLineVoiceAssistant } from "./runtime/voiceAssistant.js";
import type { RegisterPersonArgs } from "./store/types.js";

const base = (name: string, lat: number, lng: number, extra: Partial<RegisterPersonArgs> = {}): RegisterPersonArgs => ({
  name,
  age: 40,
  livesAlone: false,
  mobility: "ok",
  medicalNeeds: "",
  poweredDevice: false,
  hasSmartphone: true,
  language: "en",
  phone: "+15550000001",
  address: `${name}'s house`,
  lat,
  lng,
  ...extra,
});

async function setup(llm = new FakeLlm()) {
  const store = new InMemoryStore();
  const services = stubServices();
  const lee = await store.registerPerson(base("Mr. Lee", 32.7767, -96.797, { age: 81, livesAlone: true, phone: "+15550000002" }));
  const ana = await store.registerPerson(base("Ana Ruiz", 32.777, -96.7975, { phone: "+15550000003" }));
  await store.setSafetyNet(lee.personId, [{ memberId: ana.personId, ring: 1, skills: "truck" }]);
  await store.checkIn({ clientId: "ana-ok", personId: ana.personId, kind: "app", result: "safe", note: "" });
  const worker = new AgentWorker({ store, llm, services }, { silentSignalEveryMs: 0, reportsEveryMs: 0, needsHelpEveryMs: 0 }).start();
  return { store, services, llm, worker, lee: lee.personId, ana: ana.personId };
}

describe("needs-help check-ins", () => {
  it("open an SOS that the agents triage and dispatch without any click", async () => {
    const { store, worker, lee } = await setup();
    await store.checkIn({ clientId: "flood-1-lee", personId: lee, kind: "app", result: "needs_help", note: "flood demo" });
    await worker.idle();
    const sos = (await store.listOpenSos()).filter((s) => s.personId === lee);
    expect(sos).toHaveLength(1);
    expect(sos[0]!.message).toContain("needing help");
    expect(await store.getTriageForSos(sos[0]!.id)).toBeDefined();
    expect(worker.dispatched.length).toBeGreaterThan(0);
  });

  it("do not open a second SOS while one is active", async () => {
    const { store, worker, lee } = await setup();
    await store.checkIn({ clientId: "c1", personId: lee, kind: "sms", result: "needs_help", note: "" });
    await worker.idle();
    await store.checkIn({ clientId: "c2", personId: lee, kind: "sms", result: "needs_help", note: "" });
    await worker.idle();
    expect((await store.listOpenSos()).filter((s) => s.personId === lee)).toHaveLength(1);
  });

  it("the sweep gives everyone still marked needs_help an SOS, once (check-ins from before the worker started)", async () => {
    const { store, worker, lee, ana } = await setup();
    worker.stop(); // check-ins below land with no listener, like a worker that was down
    await store.checkIn({ clientId: "old-1", personId: lee, kind: "app", result: "needs_help", note: "flood demo" });
    await store.checkIn({ clientId: "old-2", personId: ana, kind: "sms", result: "needs_help", note: "water in the garage" });
    worker.start();
    expect(await worker.sweepNeedsHelp()).toBe(2);
    await worker.idle();
    expect(await worker.sweepNeedsHelp()).toBe(0);
    const open = await store.listOpenSos();
    expect(open.map((s) => s.personId).sort()).toEqual([lee, ana].sort());
    expect(open.find((s) => s.personId === ana)!.message).toContain("water in the garage");
    for (const s of open) expect(await store.getTriageForSos(s.id)).toBeDefined();
  });

  it("ignore safe check-ins", async () => {
    const { store, worker, lee } = await setup();
    await store.checkIn({ clientId: "c1", personId: lee, kind: "app", result: "safe", note: "" });
    await worker.idle();
    expect(await store.listOpenSos()).toHaveLength(0);
  });
});

describe("dashboard actions", () => {
  it("escalate opens an SOS, triages it and escalates", async () => {
    const { store, worker, lee } = await setup();
    const id = await store.requestAction(lee, "escalate", "no answer at door");
    await worker.idle();
    const sos = (await store.listOpenSos()).find((s) => s.personId === lee)!;
    expect(sos.state).toBe("escalated");
    expect(await store.getTriageForSos(sos.id)).toBeDefined();
    const done = store.actions.find((a) => a.id === id)!;
    expect(done.state).toBe("done");
    expect(done.result).toMatch(/Escalated Mr\. Lee/);
  });

  it("respond lets the agents decide and reports what they did", async () => {
    const { store, worker, lee } = await setup();
    const id = await store.requestAction(lee, "respond");
    await worker.idle();
    const done = store.actions.find((a) => a.id === id)!;
    expect(done.state).toBe("done");
    expect(done.result).toMatch(/Nemotron responded for Mr\. Lee: SOS \d+ is/);
  });

  it("call goes through the comms service", async () => {
    const { store, worker, services, lee } = await setup();
    const id = await store.requestAction(lee, "call");
    await worker.idle();
    expect(store.actions.find((a) => a.id === id)!.state).toBe("done");
    expect((services.comms as unknown as { calls: unknown[] }).calls?.length ?? 1).toBeGreaterThan(0);
  });

  it("claim timeline is written by Nemotron from the record and logged", async () => {
    const llm = new FakeLlm({
      claim_timeline: [
        {
          entries: [{ time: "2026-11-08 09:00 UTC", event: "Mr. Lee checked in as needing help." }],
          summary: "Mr. Lee asked for help during the flood. A neighbor was offered the visit.",
          documents_to_gather: ["Photos of water damage"],
        },
      ],
    });
    const { store, worker, lee } = await setup(llm);
    await store.checkIn({ clientId: "c1", personId: lee, kind: "app", result: "needs_help", note: "water in kitchen" });
    await worker.idle();
    const id = await store.requestAction(lee, "claim_timeline");
    await worker.idle();
    const done = store.actions.find((a) => a.id === id)!;
    expect(done.state).toBe("done");
    expect(done.result).toMatch(/^Claim timeline: /);
    expect(done.result).toContain("Photos of water damage");
    // the model saw the real record
    const prompt = llm.calls.find((c) => c.tag === "claim_timeline")!.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("water in kitchen");
    const steps = await store.listAgentSteps(`person:${lee}`);
    expect(steps.some((s) => s.content.startsWith("Claim timeline:"))).toBe(true);
  });

  it("a failing action is closed as failed, not left pending", async () => {
    const { store, worker } = await setup();
    const id = await store.requestAction(9999, "call");
    await worker.idle();
    expect(store.actions.find((a) => a.id === id)!.state).toBe("failed");
  });
});

describe("phone line", () => {
  it("briefs the operator number with live counts", async () => {
    const { store, worker, services, llm, lee } = await setup();
    await store.checkIn({ clientId: "c1", personId: lee, kind: "app", result: "needs_help", note: "" });
    await worker.idle();
    const a = new FirstLineVoiceAssistant({ store, llm, services }, { operatorNumbers: ["(414) 241-5496"] });
    const g = await a.greet({ callSid: "CA1", from: "+14142415496" });
    expect(g.say).toMatch(/FirstLine operations\. Right now 1 people need help, with 1 open S O S events/);
  });

  it("gives the operator a named household's record and the retrieved guidance", async () => {
    const llm = new FakeLlm({ voice: [{ say: "Mr. Lee is priority one; Ana was offered the visit.", action: "none" }] });
    const { store, worker, services, lee } = await setup(llm);
    await store.checkIn({ clientId: "c1", personId: lee, kind: "app", result: "needs_help", note: "very cold, no heat" });
    await worker.idle();
    const a = new FirstLineVoiceAssistant({ store, llm, services }, { operatorNumbers: ["+14142415496"] });
    await a.greet({ callSid: "CA2", from: "+14142415496" });
    const r = await a.reply({ callSid: "CA2", from: "+14142415496", text: "How is Mr. Lee doing, he says he is cold", turn: 1 });
    expect(r.say).toContain("Mr. Lee");
    const sys = llm.calls.find((c) => c.tag === "voice")!.messages[0]!.content;
    expect(sys).toContain("Record for Mr. Lee");
    expect(sys).toContain("very cold, no heat");
    expect(sys).toMatch(/hypotherm|cold/i); // a protocol card came back from the RAG
  });

  it("opens an SOS when a resident asks for help on the call", async () => {
    const llm = new FakeLlm({ voice: [{ say: "Stay on the highest floor.", action: "sos" }] });
    const { store, services, lee } = await setup(llm);
    const a = new FirstLineVoiceAssistant({ store, llm, services });
    const g = await a.greet({ callSid: "CA3", from: "+1 555 000 0002" });
    expect(g.say).toMatch(/^Hi Mr\./);
    const r = await a.reply({ callSid: "CA3", from: "+15550000002", text: "water is coming in and I can't get up", turn: 1 });
    expect(r.say).toContain("opened a help request");
    const sos = (await store.listOpenSos()).filter((s) => s.personId === lee);
    expect(sos).toHaveLength(1);
    expect(sos[0]!.channel).toBe("voice");
  });

  it("tells an unknown caller nothing about residents and falls back to guidance when the model is down", async () => {
    const { store, services, llm } = await setup(); // no scripted voice reply: model "down"
    const a = new FirstLineVoiceAssistant({ store, llm, services }, { timeoutMs: 500 });
    await a.greet({ callSid: "CA4", from: "+19998887777" });
    const r = await a.reply({ callSid: "CA4", from: "+19998887777", text: "my generator is in the garage and I have a headache", turn: 1 });
    expect(r.say).toMatch(/9 1 1/);
    expect(r.say).not.toContain("Lee");
    expect(await store.listOpenSos()).toHaveLength(0);
  });
});
