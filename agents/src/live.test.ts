// Opt-in: LIVE_NEMOTRON=1 npm test -- live
// Sends Rosa's SOS to the real Nemotron endpoint configured in agents/.env.
// Skips (does not fail) if the endpoint is unreachable, e.g. the Brev tunnel is down.

import { describe, expect, it } from "vitest";
import { runTriage } from "./agents/triage.js";
import { runDispatch } from "./agents/dispatch.js";
import { stubServices } from "./agents/services.js";
import { OpenAICompatClient, llmConfigFromEnv } from "./llm/client.js";
import { loadEnvFile } from "./llm/env.js";
import { InMemoryStore } from "./store/memory.js";

const LIVE = process.env.LIVE_NEMOTRON === "1";

describe.skipIf(!LIVE)("live Nemotron", () => {
  it("triages Rosa's Spanish SOS as P1 and dispatches", { timeout: 240_000 }, async (ctx) => {
    loadEnvFile();
    const llm = new OpenAICompatClient({ ...llmConfigFromEnv(), retries: 0, timeoutMs: 20_000 });
    try {
      await llm.chat([{ role: "user", content: "/no_think\nReply with OK." }], { maxTokens: 5 });
    } catch (err) {
      const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
      console.warn(`[live] Nemotron endpoint unreachable, skipping: ${msg.slice(0, 200)}`);
      ctx.skip();
      return;
    }
    const live = new OpenAICompatClient(llmConfigFromEnv());

    const store = new InMemoryStore();
    const deps = { store, llm: live, services: stubServices() };
    const rosa = await store.registerPerson({
      name: "Rosa", age: 58, livesAlone: false, mobility: "limited", medicalNeeds: "", poweredDevice: false,
      hasSmartphone: true, language: "es", phone: "+15550000001", address: "1 Elm", lat: 32.7767, lng: -96.797,
    });
    const marcus = await store.registerPerson({
      name: "Marcus", age: 40, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false,
      hasSmartphone: true, language: "en", phone: "+15550000002", address: "3 Elm", lat: 32.777, lng: -96.7975,
    });
    await store.setSafetyNet(rosa.personId, [{ memberId: marcus.personId, ring: 1, skills: "truck" }]);
    const sosId = await store.pressSos({
      clientId: "live-rosa", personId: rosa.personId, message: "agua entrando, mi mamá no puede caminar",
      lat: 32.7767, lng: -96.797, channel: "app",
    });

    const triage = await runTriage(deps, (await store.getSos(sosId))!);
    const dispatch = await runDispatch(deps, sosId, { kind: "new_sos" });
    const steps = await store.listAgentSteps(`sos:${sosId}`);
    console.log(steps.map((s) => `${s.agent}/${s.kind}: ${s.content}`).join("\n"));
    console.log({ triage, dispatch });
    if (triage.raisedBySafetyFloor) console.warn("[live] model said less than P1; safety floor raised it");

    expect(triage.source).toBe("model");
    expect(triage.priority).toBe("P1");
    expect(dispatch.escalated).toBe(true);
    expect(dispatch.helperId).toBe(marcus.personId);
  });
});
