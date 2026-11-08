import { describe, expect, it } from "vitest";
import { FakeLlm } from "../llm/fake.js";
import { InMemoryStore } from "../store/memory.js";
import { stubServices } from "./services.js";
import { profileLadder, runTriage, stripFakeCitations } from "./triage.js";

async function rosaSos() {
  const store = new InMemoryStore();
  const { personId } = await store.registerPerson({
    name: "Rosa", age: 58, livesAlone: false, mobility: "limited", medicalNeeds: "", poweredDevice: false,
    hasSmartphone: true, language: "es", phone: "+1555", address: "1 Elm", lat: 32.7767, lng: -96.797,
  });
  const sosId = await store.pressSos({
    clientId: "c", personId, message: "agua entrando, mi mamá no puede caminar", lat: 32.7767, lng: -96.797, channel: "app",
  });
  return { store, sos: (await store.getSos(sosId))! };
}

// Shape seen from live Nemotron Nano 9B v2: it put the triage object in `decision` and set done.
const decisionObjectReply = {
  thought: "Determining triage parameters",
  tool: null,
  args: {},
  done: true,
  decision: { urgency: 5, needs: "Professional", priority: "p1", reason: "Water entering; mother cannot walk.", confidence: 0.9 },
  confidence: 0.9,
};

describe("triage tolerance to real model output", () => {
  it("nudges the model to call save_triage when it puts the answer in decision", async () => {
    const { store, sos } = await rosaSos();
    const llm = new FakeLlm({
      triage: [
        { thought: "profile", tool: "get_person_profile", args: {} },
        decisionObjectReply,
        {
          thought: "Saving.",
          tool: "Save_Triage",
          args: JSON.stringify({ urgency: "5", needs: "PROFESSIONAL", priority: "P1", reason: "Flooding, cannot walk", confidence: 90 }),
        },
        { thought: "Saved.", done: true, decision: "P1", confidence: 0.9 },
      ],
    });
    const out = await runTriage({ store, llm, services: stubServices() }, sos);
    expect(out).toMatchObject({ source: "model", priority: "P1", needs: "professional", urgency: 5 });
    // The model said 0.9, but it cited no guidance, so the computed confidence is lower.
    expect(out.confidence).toBeLessThan(0.75);
    const steps = await store.listAgentSteps(`sos:${sos.id}`);
    expect(steps.find((s) => s.content.startsWith("Confidence"))?.content).toMatch(/✓ keyword rules agree on P1.*✗ no guidance cited/);
    expect(steps.some((s) => /has not been called yet/.test(s.content))).toBe(true);
  });

  it("salvages the decision object if the model never calls save_triage", async () => {
    const { store, sos } = await rosaSos();
    const llm = new FakeLlm({ triage: [decisionObjectReply, decisionObjectReply, decisionObjectReply] });
    const out = await runTriage({ store, llm, services: stubServices() }, sos);
    expect(out).toMatchObject({ source: "model", priority: "P1", needs: "professional" });
    expect((await store.getTriageForSos(sos.id))!.model).toBe("fake-nemotron");
  });

  it("safety floor raises a model P2 to P1 when rules see a life threat, and logs it", async () => {
    const { store, sos } = await rosaSos();
    const llm = new FakeLlm({
      triage: [
        { thought: "save", tool: "save_triage", args: { urgency: 4, needs: "professional", priority: "P2", reason: "Rising water, limited mobility", confidence: 0.85 } },
        { thought: "done", done: true, decision: "P2", confidence: 0.85 },
      ],
    });
    const out = await runTriage({ store, llm, services: stubServices() }, sos);
    expect(out).toMatchObject({ source: "model", priority: "P1", urgency: 5, raisedBySafetyFloor: true });
    const steps = await store.listAgentSteps(`sos:${sos.id}`);
    expect(steps.some((s) => /^Safety floor: model said P2, raised to P1/.test(s.content))).toBe(true);
  });

  it("logs why it fell back to rules, including the raw reply", async () => {
    const { store, sos } = await rosaSos();
    const llm = new FakeLlm({ triage: ["I think this is urgent!", "Still no JSON"] });
    const out = await runTriage({ store, llm, services: stubServices() }, sos);
    expect(out.source).toBe("rules");
    const steps = await store.listAgentSteps(`sos:${sos.id}`);
    expect(steps.some((s) => /Raw reply: Still no JSON/.test(s.content))).toBe(true);
    expect(steps.at(-1)!.content).toMatch(/^Fallback rules \(model error: /);
  });

  it("drops cited card ids the model never looked up", () => {
    const real = new Set(["power-device-backup"]);
    expect(stripFakeCitations("No details; 30, no risk [no-risk-profile] [lives_alone-false]", real)).toBe("No details; 30, no risk");
    expect(stripFakeCitations("Oxygen, no power [power-device-backup]", real)).toBe("Oxygen, no power [power-device-backup]");
    expect(stripFakeCitations("Oxygen [POWER-DEVICE-BACKUP] [no-powered-device]", real)).toBe("Oxygen [POWER-DEVICE-BACKUP]");
  });

  it("check-in with no details: priority comes from the profile ladder, not the model", async () => {
    const store = new InMemoryStore();
    const { personId } = await store.registerPerson({
      name: "Sam", age: 30, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false,
      hasSmartphone: true, language: "en", phone: "+1556", address: "2 Elm", lat: 32.7767, lng: -96.797,
    });
    const sosId = await store.pressSos({
      clientId: "checkin:1", personId, message: "needs help", lat: 32.7767, lng: -96.797, channel: "app",
    });
    const sos = (await store.getSos(sosId))!;
    const llm = new FakeLlm({
      triage: [
        { thought: "save", tool: "save_triage", args: { urgency: 3, needs: "neighbor", priority: "P2", reason: "No details [flood-cannot-walk]", confidence: 0.8 } },
        { thought: "done", done: true, decision: "P2", confidence: 0.8 },
      ],
    });
    const out = await runTriage({ store, llm, services: stubServices() }, sos);
    expect(out).toMatchObject({ priority: "P3", urgency: 2, needs: "neighbor" });
    expect(out.reason).not.toContain("[flood-cannot-walk]");
  });

  it("profile ladder rungs", () => {
    const base = { name: "x", age: 40, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false } as never;
    expect(profileLadder({ ...(base as object), age: 70 } as never).priority).toBe("P2");
    expect(profileLadder({ ...(base as object), livesAlone: true } as never).priority).toBe("P2");
    expect(profileLadder({ ...(base as object), age: 84, livesAlone: true } as never)).toMatchObject({ priority: "P2", urgency: 4, needs: "professional" });
    expect(profileLadder({ ...(base as object), poweredDevice: true } as never).priority).toBe("P1");
    expect(profileLadder(base).priority).toBe("P3");
  });
});
