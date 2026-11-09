import { describe, expect, it } from "vitest";
import { directTo, directionLine, isMedical, SAFE_PLACES } from "./direct.js";

// West Dallas, near Singleton Blvd.
const WEST_DALLAS = { lat: 32.776, lng: -96.858 };

describe("safe places list", () => {
  it("has emergency rooms and warming sites with real coordinates around Dallas", () => {
    const ers = SAFE_PLACES.filter((p) => p.kind === "er");
    const warm = SAFE_PLACES.filter((p) => p.kind === "warming");
    expect(ers.length).toBeGreaterThan(10);
    expect(warm.length).toBeGreaterThan(10);
    for (const p of SAFE_PLACES) {
      expect(p.lat).toBeGreaterThan(32.5);
      expect(p.lat).toBeLessThan(33.1);
      expect(p.lng).toBeGreaterThan(-97.1);
      expect(p.lng).toBeLessThan(-96.4);
      expect(p.name.length).toBeGreaterThan(2);
    }
  });
});

describe("directTo", () => {
  it("sends a medical P1 to the nearest emergency room, with the next ER as backup", () => {
    const d = directTo({ ...WEST_DALLAS, poweredDevice: true })!;
    expect(d.reason).toBe("medical");
    expect(d.goTo.place.kind).toBe("er");
    expect(d.backup!.place.kind).toBe("er");
    expect(d.backup!.km).toBeGreaterThanOrEqual(d.goTo.km);
    expect(d.er).toBeNull();
  });

  it("sends a flood or cold P1 without medical needs to the nearest warming site, and lists the nearest ER", () => {
    const d = directTo({ ...WEST_DALLAS, text: "Water is coming in" })!;
    expect(d.reason).toBe("shelter");
    expect(d.goTo.place.kind).toBe("warming");
    expect(d.backup!.place.kind).toBe("warming");
    expect(d.er!.place.kind).toBe("er");
    expect(d.goTo.km).toBeLessThan(5);
  });

  it("reads medical words in the SOS, the triage reason and the profile", () => {
    expect(isMedical({ ...WEST_DALLAS, text: "I can't breathe" })).toBe(true);
    expect(isMedical({ ...WEST_DALLAS, medicalNeeds: "dialysis Tue/Thu" })).toBe(true);
    expect(isMedical({ ...WEST_DALLAS, text: "No heat, very cold" })).toBe(false);
  });

  it("sends someone rescued from flood water to shelter, not an ER, unless something is medical", () => {
    const rescued = directTo({ ...WEST_DALLAS, professional: true, text: "Water is coming in. I can't get out" })!;
    expect(rescued.reason).toBe("shelter");
    expect(rescued.why).toMatch(/rescue/);
    expect(directTo({ ...WEST_DALLAS, professional: true, text: "I can't get out and I'm hurt" })!.reason).toBe("medical");
  });

  it("never picks a VA, children's or specialty hospital as the ER", () => {
    for (const p of SAFE_PLACES.filter((x) => x.kind === "er")) {
      expect(p.name).not.toMatch(/\bVA\b|veteran|children|heart|surgical|orthopedic|rehab/i);
    }
  });

  it("names the place, its address and distance in one line", () => {
    const line = directionLine(directTo({ ...WEST_DALLAS })!);
    expect(line).toMatch(/^take to .+ \(\d+(\.\d)? km\); backup .+ km\)$/);
  });

  it("gives no direction without a location", () => {
    expect(directTo({ lat: 0, lng: 0 })).toBeNull();
    expect(directTo({ lat: NaN, lng: -96.8 })).toBeNull();
  });
});
