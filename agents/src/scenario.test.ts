import { describe, expect, it } from "vitest";
import { AgentWorker } from "./index.js";
import { FakeLlm } from "./llm/fake.js";
import { InMemoryStore } from "./store/memory.js";
import { stubServices, StubRoads } from "./agents/services.js";
import { SilentSignalAgent } from "./agents/silentSignal.js";
import { runReportsSweep } from "./agents/reports.js";
import type { RegisterPersonArgs } from "./store/types.js";

const ROSA_MSG = "agua entrando, mi mamá no puede caminar";

function person(name: string, lat: number, lng: number, extra: Partial<RegisterPersonArgs> = {}): RegisterPersonArgs {
  return {
    name,
    age: 40,
    livesAlone: false,
    mobility: "ok",
    medicalNeeds: "",
    poweredDevice: false,
    hasSmartphone: true,
    language: "en",
    phone: "+15550000000",
    address: `${name}'s house`,
    lat,
    lng,
    ...extra,
  };
}

async function setup() {
  let t = new Date("2026-11-08T09:00:00Z");
  const clock = {
    now: () => t,
    advanceMinutes: (m: number) => {
      t = new Date(t.getTime() + m * 60_000);
    },
  };
  const store = new InMemoryStore({ now: clock.now });
  const services = stubServices();
  const rosa = await store.registerPerson(
    person("Rosa", 32.7767, -96.797, { age: 58, language: "es", mobility: "limited", livesAlone: false }),
  );
  const marcus = await store.registerPerson(person("Marcus", 32.777, -96.7975));
  const priya = await store.registerPerson(person("Priya", 32.78, -96.799));
  const tom = await store.registerPerson(person("Tom", 32.79, -96.81));
  await store.setSafetyNet(rosa.personId, [
    { memberId: marcus.personId, ring: 1, skills: "truck" },
    { memberId: priya.personId, ring: 2, skills: "boat,medical" },
    { memberId: tom.personId, ring: 3, skills: "generator" },
  ]);
  for (const p of [marcus, priya, tom]) {
    await store.checkIn({ clientId: `ci-${p.personId}`, personId: p.personId, kind: "app", result: "safe", note: "" });
  }
  return {
    store,
    services,
    clock,
    ids: { rosa: rosa.personId, marcus: marcus.personId, priya: priya.personId, tom: tom.personId },
  };
}

describe("Rosa / Marcus scenario", () => {
  it("triages P1, escalates + offers Marcus, replans to ring 2 when Marcus times out", async () => {
    const { store, services, clock, ids } = await setup();
    const llm = new FakeLlm({
      triage: [
        { thought: "Look up who sent this.", tool: "get_person_profile", args: {} },
        {
          thought: "Water is coming in and her mother cannot walk: life threat, needs rescue.",
          tool: "save_triage",
          args: {
            urgency: 5,
            needs: "professional",
            priority: "P1",
            reason: "Water entering the home; her mother cannot walk.",
            confidence: 0.92,
          },
        },
        { thought: "Saved.", done: true, decision: "P1: water rescue for a person who cannot walk.", confidence: 0.92 },
      ],
      dispatch: [
        // new SOS
        { thought: "P1 needs professionals.", tool: "escalate", args: { reason: "Rising water, non-ambulatory person" } },
        { thought: "Find a neighbor to help until rescue arrives.", tool: "list_helpers", args: {} },
        { thought: "Marcus is ring 1, closest, has a truck.", tool: "assign_helper", args: { helper_id: ids.marcus } },
        { thought: "Escalated and Marcus offered.", done: true, decision: "Escalated to rescue; offered to Marcus (ring 1).", confidence: 0.85 },
        // replan after timeout
        { thought: "Marcus did not answer; ring 1 is empty, try ring 2.", tool: "list_helpers", args: { ring: 2 } },
        { thought: "Priya has a boat.", tool: "assign_helper", args: { helper_id: ids.priya } },
        { thought: "Reassigned.", done: true, decision: "Reassigned to Priya (ring 2, boat).", confidence: 0.8 },
      ],
    });
    const worker = new AgentWorker({ store, llm, services, now: clock.now }, { silentSignalEveryMs: 0, reportsEveryMs: 0 }).start();

    const sosId = await store.pressSos({ clientId: "rosa-1", personId: ids.rosa, message: ROSA_MSG, lat: 32.7767, lng: -96.797, channel: "app" });
    await worker.idle();

    const triage = await store.getTriageForSos(sosId);
    expect(triage).toMatchObject({ priority: "P1", needs: "professional", urgency: 5, model: "fake-nemotron" });
    expect((await store.getPerson(ids.rosa))!.priority).toBe("P1");
    expect((await store.getSos(sosId))!.state).toBe("escalated");
    let assignments = await store.listAssignments(sosId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ helperId: ids.marcus, ring: 1, state: "offered" });

    // Nothing happens before 10 minutes.
    clock.advanceMinutes(9);
    expect(store.tick()).toHaveLength(0);

    clock.advanceMinutes(2);
    expect(store.tick()).toHaveLength(1);
    await worker.idle();

    assignments = await store.listAssignments(sosId);
    expect(assignments.map((a) => [a.helperId, a.ring, a.state])).toEqual([
      [ids.marcus, 1, "timed_out"],
      [ids.priya, 2, "offered"],
    ]);
    expect(llm.remaining("triage")).toBe(0);
    expect(llm.remaining("dispatch")).toBe(0);
    expect(worker.dispatched.map((d) => d.source)).toEqual(["model", "model"]);

    // The reasoning panel sees every step.
    const steps = await store.listAgentSteps(`sos:${sosId}`);
    const kinds = new Set(steps.map((s) => `${s.agent}/${s.kind}`));
    for (const k of ["triage/thought", "triage/tool_call", "triage/tool_result", "triage/decision", "dispatch/tool_call", "dispatch/decision"]) {
      expect(kinds).toContain(k);
    }
    expect(steps.some((s) => s.content.startsWith("assign_helper"))).toBe(true);
    worker.stop();
  });

  it("still works when the model is down: rules triage, guard escalates, replans through the rings", async () => {
    const { store, services, clock, ids } = await setup();
    const llm = new FakeLlm(); // every call throws, like a dead tunnel
    const worker = new AgentWorker({ store, llm, services, now: clock.now }, { silentSignalEveryMs: 0, reportsEveryMs: 0 }).start();

    const sosId = await store.pressSos({ clientId: "rosa-1", personId: ids.rosa, message: ROSA_MSG, lat: 32.7767, lng: -96.797, channel: "sms" });
    await worker.idle();
    expect(await store.getTriageForSos(sosId)).toMatchObject({ priority: "P1", needs: "professional", model: "rules" });
    expect((await store.getSos(sosId))!.state).toBe("escalated");
    expect((await store.listAssignments(sosId))[0]).toMatchObject({ helperId: ids.marcus, ring: 1 });

    // Duplicate SOS (same client_id) is ignored.
    expect(await store.pressSos({ clientId: "rosa-1", personId: ids.rosa, message: ROSA_MSG, lat: 32.7767, lng: -96.797, channel: "sms" })).toBe(sosId);

    clock.advanceMinutes(10);
    store.tick();
    await worker.idle();
    const second = (await store.listAssignments(sosId)).at(-1)!;
    expect(second).toMatchObject({ helperId: ids.priya, ring: 2, state: "offered" });

    await store.declineAssignment(second.id);
    await worker.idle();
    expect((await store.listAssignments(sosId)).at(-1)).toMatchObject({ helperId: ids.tom, ring: 3, state: "offered" });

    const steps = await store.listAgentSteps(`sos:${sosId}`);
    expect(steps.some((s) => /falling back to rules/.test(s.content))).toBe(true);
    worker.stop();
  });

  it("does not replan once a helper accepted", async () => {
    const { store, services, clock, ids } = await setup();
    const worker = new AgentWorker({ store, llm: new FakeLlm(), services, now: clock.now }, { silentSignalEveryMs: 0, reportsEveryMs: 0 }).start();
    const sosId = await store.pressSos({ clientId: "x", personId: ids.rosa, message: "need water bottles", lat: 32.7767, lng: -96.797, channel: "app" });
    await worker.idle();
    const [a] = await store.listAssignments(sosId);
    await store.acceptAssignment(a!.id);
    clock.advanceMinutes(30);
    expect(store.tick()).toHaveLength(0);
    await worker.idle();
    expect(await store.listAssignments(sosId)).toHaveLength(1);
    worker.stop();
  });

  it("reports agent writes a res-8 briefing with counts", async () => {
    const { store, services, clock, ids } = await setup();
    services.roads = new StubRoads();
    const worker = new AgentWorker({ store, llm: new FakeLlm(), services, now: clock.now }, { silentSignalEveryMs: 0, reportsEveryMs: 0 }).start();
    await store.pressSos({ clientId: "r", personId: ids.rosa, message: ROSA_MSG, lat: 32.7767, lng: -96.797, channel: "app" });
    await worker.idle();

    const llm = new FakeLlm({
      reports: [
        { thought: "Get the counts.", tool: "get_cell_overview", args: {} },
        { thought: "Roads?", tool: "get_blocked_roads", args: {} },
        {
          thought: "Write it.",
          tool: "save_incident_report",
          args: { summary: "1 P1: Rosa's home is flooding and her mother cannot walk. Rescue escalated." },
        },
        { thought: "Done.", done: true, decision: "Briefing saved.", confidence: 0.9 },
      ],
    });
    const out = await runReportsSweep({ store, llm, services, now: clock.now });
    expect(out.length).toBeGreaterThanOrEqual(1);
    const reports = await store.listIncidentReports();
    const rosaReport = reports.find((r) => r.p1 === 1)!;
    expect(rosaReport.summary).toMatch(/Rosa/);
    expect(out.find((o) => o.reportId === rosaReport.id)!.source).toBe("model");
    worker.stop();
  });
});

describe("Mr. Lee silent-signal scenario", () => {
  async function leeSetup() {
    let t = new Date("2026-11-08T09:00:00Z");
    const now = () => t;
    const store = new InMemoryStore({ now });
    const services = stubServices();
    const lee = await store.registerPerson(
      person("Mr. Lee", 32.781, -96.8, { age: 84, livesAlone: true, hasSmartphone: false, language: "vi", phone: "+15551112222" }),
    );
    const young = await store.registerPerson(person("Jake", 32.7811, -96.8001, { age: 29 }));
    const safe = await store.registerPerson(person("Ana", 32.7812, -96.8002, { age: 81, livesAlone: true }));
    await store.checkIn({ clientId: "ana", personId: safe.personId, kind: "voice", result: "safe", note: "" });
    await store.checkIn({ clientId: "jake", personId: young.personId, kind: "app", result: "no_answer", note: "" });
    await store.reportSignal(lee.personId, "phone_offline", 1);
    await store.reportSignal(lee.personId, "low_temp", 52);
    t = new Date(t.getTime() + 60 * 60_000);
    return { store, services, now, ids: { lee: lee.personId, young: young.personId, safe: safe.personId } };
  }

  it("flags Mr. Lee (no SOS, offline, cold, 84) and requests a call", async () => {
    const { store, services, now, ids } = await leeSetup();
    const llm = new FakeLlm({
      silent_signal: [
        { thought: "Check his signals.", tool: "get_signals", args: {} },
        { thought: "Any recent contact?", tool: "get_history", args: {} },
        {
          thought: "Phone offline and home at 52°F, 84 and alone; I cannot confirm he is OK.",
          tool: "request_call",
          args: { reason: "84, alone, phone offline, home at 52°F, no contact" },
        },
        { thought: "Call requested.", done: true, decision: "Possibly in danger; asked for a call in Vietnamese.", confidence: 0.55 },
      ],
    });
    const agent = new SilentSignalAgent({ store, llm, services, now });
    const findings = await agent.sweep();

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ personId: ids.lee, category: "P2", requested: "call", source: "model" });
    const lee = (await store.getPerson(ids.lee))!;
    expect(lee.priority).toBe("P2");
    expect(lee.priorityScore).toBeGreaterThan(4);
    expect((await store.getPerson(ids.young))!.priority).toBe("unknown");
    expect(services.comms.calls).toEqual([
      expect.objectContaining({ personId: ids.lee, phone: "+15551112222", language: "vi" }),
    ]);
    const steps = await store.listAgentSteps(`person:${ids.lee}`);
    expect(steps[0]!.content).toMatch(/^Flagged by score: P2/);
    expect(steps.some((s) => s.kind === "tool_call" && s.content.startsWith("request_call"))).toBe(true);
    expect(steps.at(-1)).toMatchObject({ kind: "decision", confidence: 0.55 });

    // Same sweep again inside the cooldown: no duplicate call.
    expect(await agent.sweep()).toHaveLength(0);
    expect(services.comms.calls).toHaveLength(1);
  });

  it("guard asks a human when the model is unsure and did not ask itself", async () => {
    const { store, services, now, ids } = await leeSetup();
    const llm = new FakeLlm({
      silent_signal: [{ thought: "Hard to tell.", done: true, decision: "Unclear.", confidence: 0.4 }],
    });
    const findings = await new SilentSignalAgent({ store, llm, services, now }).sweep();
    expect(findings[0]).toMatchObject({ personId: ids.lee, requested: "call", source: "rules" });
    expect(services.comms.calls).toHaveLength(1);
  });

  it("asks for a visit when there is no phone", async () => {
    const { store, services, now, ids } = await leeSetup();
    store.people.get(ids.lee)!.phone = "";
    const findings = await new SilentSignalAgent({ store, llm: new FakeLlm(), services, now }).sweep();
    expect(findings[0]).toMatchObject({ requested: "visit", source: "rules" });
    expect(services.comms.visits[0]).toMatchObject({ personId: ids.lee });
  });
});
