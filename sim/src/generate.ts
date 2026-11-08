// Generates a reproducible synthetic population of Dallas residents with households,
// medical/mobility profiles and safety nets. All randomness comes from `seed`.
import { gridDisk, latLngToCell } from "h3-js";
import { AREA_CODES, FIRST_NAMES, LAST_NAMES, NEIGHBORHOODS, type Neighborhood } from "./data.js";
import { Rng } from "./rng.js";
import type { Household, Language, Mobility, NetMember, Person, Skill, World } from "./types.js";

export const H3_RES = 9;
export const DEFAULT_N = 5000;
export const DEFAULT_SEED = 20210214; // Winter Storm Uri reached Dallas on Feb 14, 2021

/** Fixed ids for the scripted demo characters (always the first five people). */
export const DEMO = {
  rosa: 1,
  rosaMother: 2,
  marcus: 3,
  mrLee: 4,
  linh: 5,
  rosaHousehold: 1,
  marcusHousehold: 2,
  mrLeeHousehold: 3,
  linhHousehold: 4,
} as const;

export interface GenerateOptions {
  n?: number;
  seed?: number;
}

// Age bands for household heads (adults), roughly Dallas County ACS shares among adults.
const HEAD_AGE_BANDS = [
  { min: 18, max: 34, w: 0.34 },
  { min: 35, max: 54, w: 0.35 },
  { min: 55, max: 64, w: 0.14 },
  { min: 65, max: 74, w: 0.1 },
  { min: 75, max: 84, w: 0.05 },
  { min: 85, max: 96, w: 0.02 },
];

function drawHeadAge(rng: Rng, seniorWeight: number): number {
  const weights = HEAD_AGE_BANDS.map((b) => (b.min >= 65 ? b.w * seniorWeight : b.w));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < HEAD_AGE_BANDS.length; i++) {
    r -= weights[i];
    if (r < 0) return rng.int(HEAD_AGE_BANDS[i].min, HEAD_AGE_BANDS[i].max);
  }
  return 40;
}

function mobilityFor(rng: Rng, age: number): Mobility {
  const pCannot = age >= 85 ? 0.12 : age >= 75 ? 0.06 : age >= 65 ? 0.025 : 0.004;
  const pLimited = age >= 85 ? 0.35 : age >= 75 ? 0.22 : age >= 65 ? 0.12 : 0.03;
  const r = rng.next();
  return r < pCannot ? "cannot_walk" : r < pCannot + pLimited ? "limited" : "ok";
}

function medicalFor(rng: Rng, age: number): string[] {
  const needs: string[] = [];
  // Home oxygen: a few % of 75+. Insulin: ~9% of 65+, ~4% of middle-aged adults.
  const pO2 = age >= 75 ? 0.05 : age >= 65 ? 0.025 : age >= 40 ? 0.004 : 0.001;
  const pIns = age >= 65 ? 0.09 : age >= 35 ? 0.04 : 0.006;
  const pDial = age >= 65 ? 0.012 : age >= 40 ? 0.004 : 0.0005;
  if (rng.chance(pO2)) needs.push("oxygen");
  if (rng.chance(pIns)) needs.push("insulin");
  if (rng.chance(pDial)) needs.push("dialysis");
  return needs;
}

function phoneTypeFor(rng: Rng, age: number): Person["phoneType"] {
  // Pew: ~61% of 65+ own smartphones, ~95% of under 50.
  const pSmart = age >= 80 ? 0.4 : age >= 65 ? 0.62 : age >= 50 ? 0.85 : age >= 12 ? 0.95 : 0;
  if (rng.chance(pSmart)) return "smartphone";
  if (age < 12) return "feature"; // young kids: no phone of their own in practice; never used
  return rng.chance(age >= 65 ? 0.55 : 0.3) ? "cordless_landline" : "feature";
}

function skillsFor(rng: Rng, age: number): Skill[] {
  if (age < 18 || age >= 75) return [];
  const s: Skill[] = [];
  if (rng.chance(0.22)) s.push("truck");
  if (rng.chance(0.1)) s.push("generator");
  if (rng.chance(0.025)) s.push("boat");
  if (rng.chance(0.06)) s.push("medical");
  return s;
}

function helperProfile(rng: Rng, age: number): Person["helper"] {
  // How this person answers a neighbor request. Mean accept ~0.5 is deliberately not optimistic.
  const accept = Math.min(0.9, Math.max(0.1, rng.normal(age >= 65 ? 0.35 : 0.5, 0.15)));
  const decline = Math.min(1 - accept, Math.max(0.05, rng.normal(0.2, 0.08)));
  return { accept, decline, meanAnswerMin: rng.range(2, 8) };
}

function fakePhone(rng: Rng, seq: number): string {
  // Only 555-0100..0199 is reserved for fiction, so add an extension to keep numbers unique.
  const area = rng.pick(AREA_CODES);
  const line = 100 + rng.int(0, 99);
  return `+1${area}5550${line};ext=${String(seq).padStart(4, "0")}`;
}

function inNeighborhood(rng: Rng, nb: Neighborhood): { lat: number; lng: number; nearSenior: boolean } {
  // 15% of households sit around a senior complex if the neighborhood has one.
  if (nb.seniorClusters.length && rng.chance(0.15)) {
    const c = rng.pick(nb.seniorClusters);
    return { lat: c.lat + rng.normal(0, 0.0012), lng: c.lng + rng.normal(0, 0.0012), nearSenior: true };
  }
  return { lat: rng.range(nb.latMin, nb.latMax), lng: rng.range(nb.lngMin, nb.lngMax), nearSenior: false };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

interface Builder {
  rng: Rng;
  households: Household[];
  people: Person[];
}

function addHousehold(b: Builder, nb: Neighborhood, lat: number, lng: number, address?: string, opts: Partial<Household> = {}): Household {
  const rng = b.rng;
  const h: Household = {
    id: b.households.length + 1,
    address: address ?? `${rng.int(100, 4999)} ${rng.pick(nb.streets)}, Dallas, TX`,
    lat: round6(lat),
    lng: round6(lng),
    h3Cell: latLngToCell(lat, lng, H3_RES),
    neighborhood: nb.name,
    hasSmartLock: rng.chance(0.12),
    lockbox: rng.chance(0.06),
    hasTempSensor: rng.chance(0.25),
    insulationTauHours: rng.range(9, 22),
    ...opts,
  };
  b.households.push(h);
  return h;
}

type NewPerson = Omit<Person, "id" | "householdId" | "lat" | "lng" | "h3Cell" | "phone"> & { phone?: string };

function addPerson(b: Builder, h: Household, p: NewPerson): Person {
  const id = b.people.length + 1;
  const person: Person = {
    id,
    householdId: h.id,
    lat: h.lat,
    lng: h.lng,
    h3Cell: h.h3Cell,
    phone: p.phone ?? fakePhone(b.rng, id),
    ...p,
  } as Person;
  b.people.push(person);
  return person;
}

function randomPerson(b: Builder, h: Household, age: number, lang: Language, last: string, livesAlone: boolean): Person {
  const rng = b.rng;
  const sex = rng.chance(age >= 75 ? 0.6 : 0.5) ? "f" : "m";
  const phoneType = phoneTypeFor(rng, age);
  const medical = medicalFor(rng, age);
  const poweredDevice = medical.includes("oxygen") || medical.includes("dialysis") || rng.chance(age >= 65 ? 0.04 : 0.01);
  return addPerson(b, h, {
    name: `${rng.pick(FIRST_NAMES[lang][sex])} ${last}`,
    age,
    livesAlone,
    mobility: mobilityFor(rng, age),
    medicalNeeds: medical.join(", "),
    poweredDevice,
    hasSmartphone: phoneType === "smartphone",
    phoneType,
    language: lang,
    skills: skillsFor(rng, age),
    helper: helperProfile(rng, age),
  });
}

function addDemoCharacters(b: Builder): void {
  const oc = NEIGHBORHOODS[0];
  // All on the same few blocks of North Oak Cliff.
  const rosaH = addHousehold(b, oc, 32.74371, -96.82894, "412 N Tyler St, Dallas, TX", { hasSmartLock: true, hasTempSensor: true, insulationTauHours: 10 });
  const marcusH = addHousehold(b, oc, 32.74402, -96.82851, "425 N Tyler St, Dallas, TX", { hasTempSensor: false });
  const leeH = addHousehold(b, oc, 32.74335, -96.8293, "403 N Tyler St, Dallas, TX", { lockbox: true, hasTempSensor: true, insulationTauHours: 8 });
  const linhH = addHousehold(b, oc, 32.7442, -96.8296, "430 N Bishop Ave, Dallas, TX", { hasTempSensor: false });

  addPerson(b, rosaH, {
    name: "Rosa Martinez", age: 34, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false,
    hasSmartphone: true, phoneType: "smartphone", language: "es", phone: "+12145550101",
    skills: [], helper: { accept: 0.8, decline: 0.1, meanAnswerMin: 3 }, demoRole: "rosa",
  });
  addPerson(b, rosaH, {
    name: "Carmen Martinez", age: 71, livesAlone: false, mobility: "cannot_walk", medicalNeeds: "insulin", poweredDevice: false,
    hasSmartphone: false, phoneType: "feature", language: "es", phone: "+12145550102",
    skills: [], helper: { accept: 0, decline: 1, meanAnswerMin: 5 }, demoRole: "rosa_mother",
  });
  addPerson(b, marcusH, {
    name: "Marcus Johnson", age: 42, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false,
    hasSmartphone: true, phoneType: "smartphone", language: "en", phone: "+12145550103",
    skills: ["truck"], helper: { accept: 0, decline: 0, meanAnswerMin: 0 }, demoRole: "marcus",
  });
  addPerson(b, leeH, {
    name: "Thomas Lee", age: 84, livesAlone: true, mobility: "limited", medicalNeeds: "oxygen", poweredDevice: true,
    hasSmartphone: false, phoneType: "cordless_landline", language: "en", phone: "+12145550104",
    skills: [], helper: { accept: 0, decline: 1, meanAnswerMin: 5 }, demoRole: "mr_lee",
  });
  addPerson(b, linhH, {
    name: "Linh Tran", age: 29, livesAlone: false, mobility: "ok", medicalNeeds: "", poweredDevice: false,
    hasSmartphone: true, phoneType: "smartphone", language: "vi", phone: "+12145550105",
    skills: ["truck", "generator"], helper: { accept: 1, decline: 0, meanAnswerMin: 4 }, demoRole: "linh",
  });
}

function buildNets(rng: Rng, people: Person[], households: Household[]): NetMember[] {
  const byCell = new Map<string, Person[]>();
  for (const p of people) {
    const list = byCell.get(p.h3Cell);
    if (list) list.push(p);
    else byCell.set(p.h3Cell, [p]);
  }
  const hhById = new Map(households.map((h) => [h.id, h]));
  const dist2 = (a: Person, c: Person) => {
    const dy = a.lat - c.lat;
    const dx = (a.lng - c.lng) * Math.cos((a.lat * Math.PI) / 180);
    return dx * dx + dy * dy;
  };
  const canHelp = (p: Person) => p.age >= 18 && p.age < 80 && p.mobility === "ok";
  const nets: NetMember[] = [];
  const member = (ownerId: number, m: Person, ring: 1 | 2): NetMember => ({ ownerId, memberId: m.id, ring, skills: m.skills.join(",") });
  const byId = (id: number) => people[id - 1];

  for (const owner of people) {
    if (owner.age < 16) continue; // children are covered by their household
    if (owner.demoRole === "rosa" || owner.demoRole === "rosa_mother") {
      // Scripted: Marcus first (truck, will time out), then Linh (accepts).
      nets.push(member(owner.id, byId(DEMO.marcus), 1), member(owner.id, byId(DEMO.linh), 1));
      continue;
    }
    if (owner.demoRole === "mr_lee") {
      nets.push(member(owner.id, byId(DEMO.marcus), 1), member(owner.id, byId(DEMO.rosa), 1), member(owner.id, byId(DEMO.linh), 1));
      continue;
    }
    const h = hhById.get(owner.householdId)!;
    const nearby: Person[] = [];
    for (const cell of gridDisk(h.h3Cell, 1)) {
      for (const c of byCell.get(cell) ?? []) {
        if (c.householdId !== owner.householdId && canHelp(c) && !c.demoRole) nearby.push(c);
      }
    }
    nearby.sort((a, c) => dist2(owner, a) - dist2(owner, c) || a.id - c.id);
    const pool = nearby.slice(0, 15);
    const ring1 = rng.shuffle(pool.slice()).slice(0, rng.int(2, 4));
    // Ring 1 is listed closest first (dispatch tries them in this order).
    ring1.sort((a, c) => dist2(owner, a) - dist2(owner, c) || a.id - c.id);
    for (const m of ring1) nets.push(member(owner.id, m, 1));
    const chosen = new Set(ring1.map((m) => m.id));
    const ring2 = nearby.filter((m) => !chosen.has(m.id) && m.h3Cell === owner.h3Cell).slice(0, 3);
    for (const m of ring2) nets.push(member(owner.id, m, 2));
  }
  return nets;
}

export function generateWorld(opts: GenerateOptions = {}): World {
  const n = opts.n ?? DEFAULT_N;
  const seed = opts.seed ?? DEFAULT_SEED;
  const root = new Rng(seed);
  const b: Builder = { rng: root.fork("people"), households: [], people: [] };
  addDemoCharacters(b);

  const rng = b.rng;
  const totalShare = NEIGHBORHOODS.reduce((s, nb) => s + nb.share, 0);
  while (b.people.length < n) {
    let r = rng.next() * totalShare;
    let nb = NEIGHBORHOODS[0];
    for (const cand of NEIGHBORHOODS) {
      r -= cand.share;
      if (r < 0) {
        nb = cand;
        break;
      }
    }
    const loc = inNeighborhood(rng, nb);
    const h = addHousehold(b, nb, loc.lat, loc.lng);
    const lang = rng.weighted(nb.language);
    const last = rng.pick(LAST_NAMES[lang]);
    const headAge = drawHeadAge(rng, nb.seniorBoost * (loc.nearSenior ? 6 : 1));

    let size: number;
    if (headAge >= 65) size = rng.chance(loc.nearSenior ? 0.7 : 0.42) ? 1 : rng.chance(0.85) ? 2 : 3;
    else if (headAge < 30) size = rng.chance(0.35) ? 1 : rng.int(2, 4);
    else size = rng.chance(0.22) ? 1 : rng.int(2, 5);
    size = Math.min(size, n - b.people.length);

    randomPerson(b, h, headAge, lang, last, size === 1);
    for (let i = 1; i < size; i++) {
      let age: number;
      if (i === 1 && (headAge >= 65 || rng.chance(0.75))) age = Math.max(18, Math.min(98, Math.round(headAge + rng.normal(0, 4)))); // partner
      else if (headAge >= 65) age = rng.int(35, headAge - 20); // adult child living with parent
      else age = rng.int(0, Math.max(0, Math.min(17, headAge - 18))); // kids
      randomPerson(b, h, age, lang, last, false);
    }
  }

  const nets = buildNets(root.fork("nets"), b.people, b.households);
  return { seed, households: b.households, people: b.people, nets };
}

/** Summary used by the seed script and tests. */
export function summarize(world: World) {
  const p = world.people;
  const pct = (k: number) => `${((100 * k) / p.length).toFixed(1)}%`;
  const count = (f: (x: Person) => boolean) => p.filter(f).length;
  return {
    people: p.length,
    households: world.households.length,
    cells: new Set(p.map((x) => x.h3Cell)).size,
    netRows: world.nets.length,
    age65plus: pct(count((x) => x.age >= 65)),
    age75plus: pct(count((x) => x.age >= 75)),
    livesAlone: pct(count((x) => x.livesAlone)),
    cannotWalk: count((x) => x.mobility === "cannot_walk"),
    oxygen: count((x) => x.medicalNeeds.includes("oxygen")),
    insulin: count((x) => x.medicalNeeds.includes("insulin")),
    dialysis: count((x) => x.medicalNeeds.includes("dialysis")),
    poweredDevice: count((x) => x.poweredDevice),
    smartphone: pct(count((x) => x.hasSmartphone)),
    language: {
      en: pct(count((x) => x.language === "en")),
      es: pct(count((x) => x.language === "es")),
      vi: pct(count((x) => x.language === "vi")),
    },
  };
}
