import { describe, expect, it } from "vitest";
import { computePriority, P2_THRESHOLD, type PriorityInput } from "./priority.js";

const now = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

const base: PriorityInput["person"] = {
  age: 35,
  livesAlone: false,
  mobility: "ok",
  medicalNeeds: "",
  poweredDevice: false,
  hasSmartphone: true,
  language: "en",
  status: "unknown",
  lastSeen: hoursAgo(0),
};

describe("computePriority", () => {
  it("scores a healthy, recently seen adult as 1 and unknown", () => {
    const r = computePriority({ person: base, now });
    expect(r.score).toBe(1);
    expect(r.category).toBe("unknown");
    expect(r.reasons).toEqual([]);
  });

  it("flags Mr. Lee (84, alone, offline, cold, no contact) as P2 with reasons", () => {
    const r = computePriority({
      person: { ...base, age: 84, livesAlone: true, hasSmartphone: false, lastSeen: hoursAgo(14) },
      signals: [
        { kind: "phone_offline", value: 1, createdAt: hoursAgo(3) },
        { kind: "low_temp", value: 52, createdAt: hoursAgo(1) },
      ],
      now,
    });
    expect(r.category).toBe("P2");
    expect(r.score).toBeGreaterThanOrEqual(P2_THRESHOLD);
    expect(r.reasons).toEqual(
      expect.arrayContaining(["age 84", "lives alone", "no smartphone", "home at 52°F", "phone offline"]),
    );
    expect(r.reasons.some((x) => x.startsWith("no contact for 14"))).toBe(true);
    expect(r.summary).toMatch(/^P2 \(score/);
  });

  it("P1 comes only from triage", () => {
    const r = computePriority({ person: base, triage: { priority: "P1", needs: "professional" }, now });
    expect(r.category).toBe("P1");
  });

  it("safe status wins over a high score", () => {
    const r = computePriority({
      person: { ...base, age: 90, livesAlone: true, status: "safe", lastSeen: undefined },
      now,
    });
    expect(r.category).toBe("safe");
  });

  it("a vulnerable person just contacted is not P2", () => {
    const r = computePriority({
      person: { ...base, age: 80, livesAlone: true, poweredDevice: true, lastSeen: hoursAgo(0.1) },
      now,
    });
    expect(r.contactGap.value).toBe(1);
    expect(r.category).toBe("unknown");
  });

  it("counts failed attempts since last contact and oxygen as a powered need", () => {
    const r = computePriority({
      person: { ...base, medicalNeeds: "oxygen", lastSeen: hoursAgo(2) },
      checkIns: [
        { result: "no_answer", createdAt: hoursAgo(1) },
        { result: "no_answer", createdAt: hoursAgo(0.5) },
        { result: "no_answer", createdAt: hoursAgo(5) },
      ],
      now,
    });
    expect(r.vulnerability.reasons).toContain("depends on oxygen");
    expect(r.contactGap.reasons).toContain("2 failed contact attempts");
  });

  it("exposure adds weather alert, power out and shelter distance", () => {
    const r = computePriority({
      person: base,
      signals: [{ kind: "power_out", value: 1, createdAt: hoursAgo(1) }],
      weatherAlert: "flash flood warning",
      distanceToShelterKm: 8,
      now,
    });
    expect(r.exposure.value).toBeCloseTo(2.4);
    expect(r.exposure.reasons).toEqual(["weather alert: flash flood warning", "power out", "8 km from shelter/ER"]);
  });
});
