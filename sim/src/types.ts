// Shapes produced by the generator and storm. Field names follow docs/contract.md
// (camelCase here, snake_case in the module) so loaders map 1:1 to reducers.

export type Mobility = "ok" | "limited" | "cannot_walk";
export type Language = "en" | "es" | "vi";
export type Skill = "truck" | "boat" | "generator" | "medical";

export interface Household {
  id: number;
  address: string;
  lat: number;
  lng: number;
  h3Cell: string;
  neighborhood: string;
  hasSmartLock: boolean;
  lockbox: boolean;
  /** Smart thermostat or sensor: the only homes whose indoor temperature is observable. */
  hasTempSensor: boolean;
  /** Hours for indoor temperature to fall ~63% of the way to outdoor once heat is lost. */
  insulationTauHours: number;
}

export interface Person {
  id: number;
  name: string;
  age: number;
  livesAlone: boolean;
  mobility: Mobility;
  /** Comma list, "" if none: oxygen, insulin, dialysis. */
  medicalNeeds: string;
  poweredDevice: boolean;
  hasSmartphone: boolean;
  /** Cordless landlines die when the power goes out. */
  phoneType: "smartphone" | "feature" | "cordless_landline";
  language: Language;
  phone: string;
  householdId: number;
  lat: number;
  lng: number;
  h3Cell: string;
  /** Sim-only helper profile (not in the module schema). */
  skills: Skill[];
  /** Sim-only: how this person tends to answer a help request. */
  helper: { accept: number; decline: number; meanAnswerMin: number };
  /** Set for the scripted demo characters. */
  demoRole?: string;
}

export interface NetMember {
  ownerId: number;
  memberId: number;
  ring: 1 | 2 | 3;
  skills: string;
}

export interface World {
  seed: number;
  households: Household[];
  people: Person[];
  nets: NetMember[];
}
