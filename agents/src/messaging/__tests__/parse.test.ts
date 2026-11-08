import { describe, expect, it } from "vitest";
import { parseMessage, sosMessage } from "../parse.js";

describe("parseMessage", () => {
  it("parses a full compact SOS", () => {
    const p = parseMessage("PL SOS 32.78,-96.80 2ppl insulin");
    expect(p).toMatchObject({ kind: "sos", lat: 32.78, lng: -96.8, people: 2, note: "2ppl insulin" });
    if (p.kind === "sos") expect(sosMessage(p)).toBe("SOS (2 people): insulin");
  });

  it("is case and spacing tolerant", () => {
    expect(parseMessage("  pl   sos 32.78, -96.80  ")).toMatchObject({ kind: "sos", lat: 32.78, lng: -96.8 });
    expect(parseMessage("PL: OK")).toMatchObject({ kind: "ok" });
  });

  it("parses SOS without coordinates", () => {
    expect(parseMessage("PL SOS water rising")).toMatchObject({ kind: "sos", lat: undefined, note: "water rising" });
  });

  it("parses OK and HELP", () => {
    expect(parseMessage("PL OK")).toEqual({ kind: "ok", personId: undefined, note: "" });
    expect(parseMessage("PL HELP need a ride to dialysis")).toEqual({
      kind: "help",
      personId: undefined,
      note: "need a ride to dialysis",
    });
  });

  it("reads a #personId tag", () => {
    expect(parseMessage("PL OK #14")).toMatchObject({ kind: "ok", personId: 14 });
    expect(parseMessage("PL SOS #7 32.7,-96.8 oxygen")).toMatchObject({ kind: "sos", personId: 7, lat: 32.7, note: "oxygen" });
  });

  it("accepts Spanish command words", () => {
    expect(parseMessage("PL AYUDA no tengo luz")).toMatchObject({ kind: "help", note: "no tengo luz" });
    expect(parseMessage("PL BIEN")).toMatchObject({ kind: "ok" });
    expect(parseMessage("PL SOCORRO 32.78,-96.80 3 personas")).toMatchObject({ kind: "sos", people: 3 });
  });

  it("treats non-PL text as free text (incl. Spanish)", () => {
    expect(parseMessage("Mi mamá necesita oxígeno y no hay luz")).toEqual({
      kind: "free",
      text: "Mi mamá necesita oxígeno y no hay luz",
    });
    // "plan" starts with "pl" but is not the prefix
    expect(parseMessage("plan is to stay home")).toMatchObject({ kind: "free" });
  });

  it("rejects malformed messages", () => {
    expect(parseMessage("")).toMatchObject({ kind: "malformed" });
    expect(parseMessage("PL")).toMatchObject({ kind: "malformed" });
    expect(parseMessage("PL DANCE")).toMatchObject({ kind: "malformed", reason: 'unknown command "DANCE"' });
    expect(parseMessage("PL SOS 132.78,-96.80")).toMatchObject({ kind: "malformed", reason: "coordinates out of range" });
    expect(parseMessage("PL HELP")).toMatchObject({ kind: "malformed" });
  });
});
