import { describe, expect, it } from "vitest";
import { stubServices } from "./agents/services.js";
import { inventedClaims, ruleTriage, runTriage } from "./agents/triage.js";
import { resetReportMemory, runReportsSweep } from "./agents/reports.js";
import { FakeLlm } from "./llm/fake.js";
import { isDialable, simulatedAnswer } from "./runtime/services.js";
import { InMemoryStore } from "./store/memory.js";
import type { RegisterPersonArgs } from "./store/types.js";

const person = (extra: Partial<RegisterPersonArgs> = {}): RegisterPersonArgs => ({
  name: "Test Person", age: 34, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false,
  hasSmartphone: true, language: "en", phone: "+15550000001", address: "1 Main St", lat: 32.75, lng: -96.83, ...extra,
});
const FLOOD_CHECKIN = "Checked in as needing help (via the app). flood demo";

describe("triage on a bare flood check-in", () => {
  it("the word 'flood' alone no longer trips the life-threat safety floor", () => {
    expect(ruleTriage(FLOOD_CHECKIN).urgency).toBeLessThan(5);
    expect(ruleTriage("agua entrando, mi mamá no puede caminar").urgency).toBe(5);
    expect(ruleTriage("water is rising in the house").urgency).toBe(5);
  });

  it("keeps the model's P3 for a healthy adult, with the profile in the prompt and no get_person_profile call", async () => {
    const store = new InMemoryStore();
    const p = await store.registerPerson(person());
    const sosId = await store.pressSos({ clientId: `checkin:1`, personId: p.personId, message: FLOOD_CHECKIN, lat: 32.75, lng: -96.83, channel: "app" });
    const llm = new FakeLlm({
      triage: [
        { thought: "Healthy adult, no details", tool: "save_triage", args: { urgency: 2, needs: "neighbor", priority: "P3", reason: "No details; 34, no risk factors [flood-turn-around]", confidence: 0.6 } },
        { thought: "done", done: true, decision: "P3 neighbor check" },
      ],
    });
    const out = await runTriage({ store, llm, services: stubServices() }, (await store.getSos(sosId))!);
    expect(out).toMatchObject({ priority: "P3", needs: "neighbor", source: "model", raisedBySafetyFloor: false });
    const task = llm.calls[0]!.messages.map((m) => m.content).join("\n");
    expect(task).toContain('PROFILE: {"person_id"');
    expect(task).toContain("only said they need help");
  });

  it("rejects a reason that invents 'trapped', and the model's corrected answer is saved", async () => {
    const store = new InMemoryStore();
    const p = await store.registerPerson(person({ age: 84, livesAlone: true, medicalNeeds: "oxygen", poweredDevice: true }));
    const sosId = await store.pressSos({ clientId: `checkin:2`, personId: p.personId, message: FLOOD_CHECKIN, lat: 32.75, lng: -96.83, channel: "app" });
    const llm = new FakeLlm({
      triage: [
        { thought: "x", tool: "save_triage", args: { urgency: 5, needs: "professional", priority: "P1", reason: "Water entering home and trapped [flood-trapped-high]", confidence: 0.95 } },
        { thought: "fix", tool: "save_triage", args: { urgency: 5, needs: "professional", priority: "P1", reason: "No details; 84, lives alone, uses oxygen [power-device-backup]", confidence: 0.9 } },
        { thought: "done", done: true, decision: "P1" },
      ],
    });
    const out = await runTriage({ store, llm, services: stubServices() }, (await store.getSos(sosId))!);
    expect(out.source).toBe("model");
    expect(out.reason).toContain("uses oxygen");
    const steps = await store.listAgentSteps(`sos:${sosId}`);
    expect(steps.some((s) => s.content.startsWith("Rejected a reason"))).toBe(true);
  });

  it("only flags claims the message and profile do not support (card ids are not claims)", () => {
    expect(inventedClaims("No details [flood-trapped-high]", FLOOD_CHECKIN)).toEqual([]);
    expect(inventedClaims("Trapped by water", FLOOD_CHECKIN)).toContain("someone is trapped");
    expect(inventedClaims("Water entering, cannot walk", "agua entrando, no puedo caminar")).toEqual([]);
  });
});

describe("reports sweep", () => {
  it("does not rewrite a cell whose numbers have not changed", async () => {
    resetReportMemory();
    const store = new InMemoryStore();
    const p = await store.registerPerson(person());
    await store.checkIn({ clientId: "c", personId: p.personId, kind: "app", result: "needs_help", note: "" });
    await store.setPriority(p.personId, "P1", 20);
    const llm = new FakeLlm(); // model down: the rules write the report
    const deps = { store, llm, services: stubServices() };
    expect((await runReportsSweep(deps)).length).toBe(1);
    expect((await runReportsSweep(deps)).length).toBe(0);
    const q = (await store.registerPerson(person({ lat: 32.7501 }))).personId;
    await store.checkIn({ clientId: "c2", personId: q, kind: "app", result: "needs_help", note: "" });
    await store.setPriority(q, "P1", 18);
    expect((await runReportsSweep(deps)).length).toBe(1);
  });

  it("writes incident reports only for areas with a Priority 1 case", async () => {
    resetReportMemory();
    const store = new InMemoryStore();
    const p = await store.registerPerson(person());
    await store.checkIn({ clientId: "c", personId: p.personId, kind: "app", result: "needs_help", note: "" });
    await store.setPriority(p.personId, "P2", 8);
    const deps = { store, llm: new FakeLlm(), services: stubServices() };
    expect((await runReportsSweep(deps)).length).toBe(0);
    await store.setPriority(p.personId, "P1", 20);
    const out = await runReportsSweep(deps);
    expect(out.length).toBe(1);
    expect(out[0].summary).toMatch(/1 Priority 1 case/);
  });
});

describe("neighbors without a real phone", () => {
  it("synthetic numbers are not dialable; real ones are", () => {
    expect(isDialable("+14695550109;ext=0532")).toBe(false);
    expect(isDialable("+14695048698")).toBe(true);
  });
  it("simulated answers are repeatable and roughly half accept", () => {
    const answers = Array.from({ length: 1000 }, (_, i) => simulatedAnswer(i + 1).answer);
    const accept = answers.filter((a) => a === "accept").length / 1000;
    expect(accept).toBeGreaterThan(0.4);
    expect(accept).toBeLessThan(0.7);
    expect(simulatedAnswer(42)).toEqual(simulatedAnswer(42));
  });
});
