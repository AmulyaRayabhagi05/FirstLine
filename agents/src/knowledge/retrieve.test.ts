import { describe, expect, it } from "vitest";
import { detectHazards, searchProtocols } from "./retrieve.js";
import { PROTOCOLS, RESPONDER_RULES } from "./protocols.js";
import { spokenGuidance } from "./harness.js";
import { ruleTriage } from "../agents/triage.js";
import { checkInTwiml } from "../messaging/voice.js";

const top = (q: string, opts = {}) => searchProtocols(q, { k: 3, ...opts }).map((c) => c.id);

describe("protocol pack", () => {
  it("has unique ids, a source URL on every card, and EN+ES lines wherever a card can be spoken", () => {
    const ids = PROTOCOLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of PROTOCOLS) {
      expect(c.source.url).toMatch(/^https:\/\//);
      if (c.say) {
        expect(c.say.en.length).toBeGreaterThan(10);
        expect(c.say.es.length).toBeGreaterThan(10);
      }
    }
  });

  it("responder rules only cite cards that exist", () => {
    for (const id of RESPONDER_RULES.match(/\[([a-z0-9-]+)\]/g) ?? []) {
      expect(PROTOCOLS.some((c) => `[${c.id}]` === id)).toBe(true);
    }
  });
});

describe("retrieval", () => {
  it("finds carbon monoxide guidance for a generator and symptoms", () => {
    const ids = top("generator in the garage and my dad has a headache");
    expect(ids).toContain("co-symptoms-911");
    expect(ids[0]).toMatch(/^co-/);
  });

  it("works in Spanish", () => {
    expect(top("agua entrando, mi mamá no puede caminar")[0]).toBe("flood-trapped-high");
    // the electrical hazard (life threat) may lead; the water main card must be right behind it
    expect(top("se reventó la tubería, agua por todos lados").slice(0, 2)).toContain("water-main-shutoff");
  });

  it("finds the water main card for a burst pipe", () => {
    expect(top("pipe burst, water everywhere").slice(0, 2)).toContain("water-main-shutoff");
  });

  it("leads with life threats when they are about as relevant as advice", () => {
    for (const q of ["generator carbon monoxide", "generator alarm", "car running in the garage"]) {
      const cards = searchProtocols(q, { k: 3, only: ["carbon_monoxide"] });
      expect(cards[0].severity, q).toBe("life_threat");
    }
  });

  it("does not tell people to throw out insulin", () => {
    const ids = top("power out, my insulin is not in the fridge");
    expect(ids).toContain("insulin-no-fridge");
  });

  it("detects hazards from the profile alone", () => {
    expect(detectHazards("", { poweredDevice: true })).toContain("powered_device");
    expect(detectHazards("sin luz y hace frío", { age: 80 })).toContain("hypothermia");
  });
});

describe("triage rules with citations", () => {
  it("makes a generator plus dizziness a P1 carbon monoxide case and cites guidance", () => {
    const r = ruleTriage("the generator is in the garage and grandma is dizzy");
    expect(r.priority).toBe("P1");
    expect(r.needs).toBe("professional");
    expect(r.reason).toMatch(/carbon monoxide/);
    expect(r.reason).toMatch(/\[co-[a-z-]+\]/);
  });

  it("treats confusion in the cold as hypothermia", () => {
    const r = ruleTriage("no heat since last night, my husband is confused and very sleepy");
    expect(r.priority).toBe("P1");
    expect(r.reason).toMatch(/hypothermia/);
  });

  it("keeps a burst pipe low priority but cites the water main card", () => {
    const r = ruleTriage("pipe burst in the kitchen");
    expect(r.priority).toBe("P3");
    expect(r.reason).toContain("[water-main-shutoff]");
  });
});

describe("check-in call", () => {
  const cfg = { fromNumber: "+15005550006", publicUrl: "https://example.ngrok.app" };

  it("reads the CDC 20-feet generator line by default", () => {
    const xml = checkInTwiml(cfg, { id: 1, name: "Ruth", language: "en" });
    expect(xml).toMatch(/20 feet/);
    expect(spokenGuidance({ lang: "en" }).length).toBeGreaterThan(0);
  });

  it("adds device guidance for someone on a powered device", () => {
    const lines = spokenGuidance({ lang: "en", profile: { poweredDevice: true }, max: 3 });
    expect(lines.join(" ")).toMatch(/medical device that needs power/);
  });

  it("speaks the guidance in Spanish", () => {
    const xml = checkInTwiml(cfg, { id: 2, name: "Alma", language: "es" });
    expect(xml).toMatch(/monóxido de carbono|mon&#xF3;xido/);
  });
});
