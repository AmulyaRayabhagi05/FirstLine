import { describe, expect, it } from "vitest";
import { silentConfidence, triageConfidence, type TriageEvidence } from "./confidence.js";

const strong: TriageEvidence = {
  modelPriority: "P1",
  rules: { priority: "P1", whys: ["rising water / trapped"] },
  raisedBySafetyFloor: false,
  reason: "Water entering, cannot walk [flood-trapped-high]",
  retrievedCardIds: new Set(["flood-trapped-high"]),
  readProfile: true,
  message: "agua entrando, mi mamá no puede caminar",
  signals: [{ kind: "power_out", value: 1 }],
  weatherAlert: "Flash Flood Warning",
  selfReported: 0.95,
};

describe("triageConfidence", () => {
  it("is high only when every check holds", () => {
    expect(triageConfidence(strong).value).toBeGreaterThanOrEqual(0.9);
  });

  it("drops when the model and the rules disagree", () => {
    const c = triageConfidence({ ...strong, modelPriority: "P3" });
    expect(c.value).toBeLessThan(0.75);
    expect(c.summary).toMatch(/✗ keyword rules say P1, model said P3/);
  });

  it("drops hard when the safety floor had to step in", () => {
    expect(triageConfidence({ ...strong, modelPriority: "P2", raisedBySafetyFloor: true }).value).toBeLessThan(0.7);
  });

  it("catches citations the model made up", () => {
    const c = triageConfidence({ ...strong, reason: "Flood [made-up-card]" });
    expect(c.summary).toMatch(/✗ cited \[made-up-card\] was not in what it looked up/);
    expect(c.value).toBeLessThan(triageConfidence(strong).value);
  });

  it("ignores how confident the model claims to be, mostly", () => {
    const vague = { ...strong, rules: { priority: "P3" as const, whys: [] }, modelPriority: "P3" as const, message: "help", reason: "unclear", signals: [], weatherAlert: undefined };
    expect(triageConfidence({ ...vague, selfReported: 1 }).value).toBeLessThan(0.6);
  });

  it("does not count a warm home as a cold-home signal", () => {
    const c = triageConfidence({ ...strong, signals: [{ kind: "low_temp", value: 70 }], weatherAlert: undefined });
    expect(c.summary).toMatch(/✗ no sensor or weather data/);
  });
});

describe("silentConfidence", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  it("asks for a human when the review had little to go on", () => {
    expect(silentConfidence({ signals: [], checkedSignals: false, checkedHistory: false, now, selfReported: 0.95 }).value).toBeLessThan(0.7);
  });
  it("is higher with fresh signals the agent actually checked", () => {
    const signals = [
      { kind: "phone_offline" as const, value: 1, createdAt: new Date(now.getTime() - 30 * 60_000) },
      { kind: "power_out" as const, value: 1, createdAt: new Date(now.getTime() - 60 * 60_000) },
      { kind: "low_temp" as const, value: 52, createdAt: new Date(now.getTime() - 60 * 60_000) },
    ];
    expect(silentConfidence({ signals, checkedSignals: true, checkedHistory: true, lastSeen: now, now }).value).toBeGreaterThanOrEqual(0.8);
  });
});
