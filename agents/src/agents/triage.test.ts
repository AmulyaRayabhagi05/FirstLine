import { describe, expect, it } from "vitest";
import { FakeLlm } from "../llm/fake.js";
import { InMemoryStore } from "../store/memory.js";
import { stubServices } from "./services.js";
import { runTriage } from "./triage.js";

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
    expect(out).toMatchObject({ source: "model", priority: "P1", needs: "professional", urgency: 5, confidence: 0.9 });
    const steps = await store.listAgentSteps(`sos:${sos.id}`);
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
});
