// SimStore: the slice of the worker's `PorchlightStore` (agents/src/store/types.ts on
// feat/agent-worker) that the sim writes through. Signatures are copied from there, so the real
// store, its InMemoryStore, or the SpacetimeDB adapter can be passed in directly.

export type Id = number;

export interface RegisterPersonArgs {
  name: string;
  age: number;
  livesAlone: boolean;
  mobility: "ok" | "limited" | "cannot_walk";
  medicalNeeds: string;
  poweredDevice: boolean;
  hasSmartphone: boolean;
  language: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
}

export interface SafetyNetMemberInput {
  memberId: Id;
  ring: number;
  skills: string;
}

export interface PressSosArgs {
  clientId: string;
  personId: Id;
  message: string;
  lat: number;
  lng: number;
  channel: "app" | "sms" | "voice" | "mesh";
}

export interface CheckInArgs {
  clientId: string;
  personId: Id;
  kind: "app" | "voice" | "sms" | "neighbor_visit" | "mesh";
  result: "safe" | "needs_help" | "no_answer";
  note: string;
}

export type SignalKind = "phone_offline" | "power_out" | "low_temp" | "no_motion";

export interface SimStore {
  registerPerson(args: RegisterPersonArgs): Promise<{ personId: Id; householdId: Id }>;
  setSafetyNet(ownerId: Id, members: SafetyNetMemberInput[]): Promise<void>;
  pressSos(args: PressSosArgs): Promise<Id>;
  checkIn(args: CheckInArgs): Promise<void>;
  reportSignal(personId: Id, kind: SignalKind, value: number): Promise<void>;
}

/** Optional extras used by the helper bot (also on PorchlightStore). */
export interface HelperBotStore {
  listOpenSos(): Promise<{ id: Id }[]>;
  listAssignments(sosId: Id): Promise<{ id: Id; sosId: Id; helperId: Id; state: string }[]>;
  acceptAssignment(assignmentId: Id): Promise<void>;
  declineAssignment(assignmentId: Id): Promise<void>;
}
