// FirstLineStore: the worker's view of the SpacetimeDB module (see docs/contract.md).
// Every write goes through a method named after a reducer (camelCase). Reads mirror the
// tables the worker subscribes to. Other branches (messaging, sim, feeds) import these
// names, so treat them as part of the contract: rename only together with docs/contract.md.
//
// IDs are plain numbers here (u64 in the module; the SpacetimeDB adapter converts bigint).
// Times are `Date` in the worker.

export type Id = number;

export type Mobility = "ok" | "limited" | "cannot_walk";
export type PersonStatus = "unknown" | "safe" | "needs_help";
export type Priority = "P1" | "P2" | "P3";
export type PriorityCategory = Priority | "safe" | "unknown";
export type SosChannel = "app" | "sms" | "voice" | "mesh";
export type SosState = "open" | "assigned" | "resolved" | "escalated";
export type CheckInKind = "app" | "voice" | "sms" | "neighbor_visit" | "mesh";
export type CheckInResult = "safe" | "needs_help" | "no_answer";
export type SignalKind = "phone_offline" | "power_out" | "low_temp" | "no_motion";
export type Needs = "neighbor" | "professional";
export type AssignmentState = "offered" | "accepted" | "declined" | "timed_out" | "done";
export type AgentName = "triage" | "dispatch" | "silent_signal" | "reports";
export type AgentStepKind = "thought" | "tool_call" | "tool_result" | "decision";

export interface Person {
  id: Id;
  identity?: string;
  name: string;
  age: number;
  livesAlone: boolean;
  mobility: Mobility;
  medicalNeeds: string;
  poweredDevice: boolean;
  hasSmartphone: boolean;
  language: string;
  phone: string;
  householdId: Id;
  lastLat: number;
  lastLng: number;
  h3Cell: string;
  status: PersonStatus;
  priority: PriorityCategory;
  priorityScore: number;
  lastSeen?: Date;
}

export interface Household {
  id: Id;
  address: string;
  lat: number;
  lng: number;
  h3Cell: string;
  hasSmartLock: boolean;
  lockbox: boolean;
}

export interface HexCell {
  h3Cell: string;
  totalPeople: number;
  safe: number;
  needsHelp: number;
  unknown: number;
  censusElderlyEstimate: number;
  coverageGap: boolean;
  alertLevel: string; // empty if none
}

export interface SafetyNetMember {
  id: Id;
  ownerId: Id;
  memberId: Id;
  ring: number; // 1 chosen, 2 next block, 3 wider
  skills: string; // comma list: truck, boat, generator, medical
}

export interface SosEvent {
  id: Id;
  clientId: string;
  personId: Id;
  message: string;
  lat: number;
  lng: number;
  h3Cell: string;
  channel: SosChannel;
  createdAt: Date;
  state: SosState;
}

export interface CheckIn {
  id: Id;
  clientId: string;
  personId: Id;
  kind: CheckInKind;
  result: CheckInResult;
  note: string;
  createdAt: Date;
}

export interface Signal {
  id: Id;
  personId: Id;
  kind: SignalKind;
  value: number;
  createdAt: Date;
}

export interface Triage {
  id: Id;
  sosId?: Id;
  personId: Id;
  urgency: number; // 1-5
  confidence: number; // 0-1
  needs: Needs;
  priority: Priority;
  reason: string;
  model: string;
  createdAt: Date;
}

export interface Assignment {
  id: Id;
  sosId: Id;
  helperId: Id;
  state: AssignmentState;
  offeredAt: Date;
  ring: number;
}

export interface IncidentReport {
  id: Id;
  h3Cell: string; // res 8
  summary: string;
  blockedRoads: string;
  p1: number;
  p2: number;
  unknown: number;
  createdAt: Date;
}

export interface AgentStep {
  id: Id;
  agent: AgentName;
  subject: string; // e.g. "sos:12", "person:40", "cell:88..."
  kind: AgentStepKind;
  content: string;
  confidence?: number;
  createdAt: Date;
}

// ---- reducer argument shapes ----

export interface RegisterPersonArgs {
  name: string;
  age: number;
  livesAlone: boolean;
  mobility: Mobility;
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
  channel: SosChannel;
}

export interface CheckInArgs {
  clientId: string;
  personId: Id;
  kind: CheckInKind;
  result: CheckInResult;
  note: string;
}

export interface SaveTriageArgs {
  sosId?: Id;
  personId: Id;
  urgency: number;
  confidence: number;
  needs: Needs;
  priority: Priority;
  reason: string;
  model: string;
}

export interface SaveIncidentReportArgs {
  h3Cell: string;
  summary: string;
  blockedRoads: string;
  p1: number;
  p2: number;
  unknown: number;
}

export interface LogAgentStepArgs {
  agent: AgentName;
  subject: string;
  kind: AgentStepKind;
  content: string;
  confidence?: number;
}

export type Unsubscribe = () => void;
export type Listener<T> = (row: T) => void | Promise<void>;

export interface FirstLineStore {
  // ---- phone / channel reducers (messaging, sim, app) ----
  registerPerson(args: RegisterPersonArgs): Promise<{ personId: Id; householdId: Id }>;
  setSafetyNet(ownerId: Id, members: SafetyNetMemberInput[]): Promise<void>;
  /** Returns the SOS id; a repeat clientId returns the existing id and changes nothing. */
  pressSos(args: PressSosArgs): Promise<Id>;
  checkIn(args: CheckInArgs): Promise<void>;
  reportSignal(personId: Id, kind: SignalKind, value: number): Promise<void>;

  // ---- helper reducers ----
  acceptAssignment(assignmentId: Id): Promise<void>;
  declineAssignment(assignmentId: Id): Promise<void>;
  markSafe(personId: Id, note: string): Promise<void>;

  // ---- worker reducers ----
  saveTriage(args: SaveTriageArgs): Promise<Id>;
  /** Creates an `offered` assignment; the module times it out after 10 minutes. */
  assignHelper(sosId: Id, helperId: Id, ring: number): Promise<Id>;
  escalate(sosId: Id, reason: string): Promise<void>;
  saveIncidentReport(args: SaveIncidentReportArgs): Promise<Id>;
  logAgentStep(args: LogAgentStepArgs): Promise<void>;
  setPriority(personId: Id, priority: PriorityCategory, priorityScore: number): Promise<void>;
  setCellAlert(h3Cell: string, alertLevel: string): Promise<void>;
  setCellCensus(h3Cell: string, censusElderlyEstimate: number): Promise<void>;

  // ---- reads ----
  getPerson(personId: Id): Promise<Person | undefined>;
  getHousehold(householdId: Id): Promise<Household | undefined>;
  listPeople(): Promise<Person[]>;
  getSafetyNet(ownerId: Id): Promise<SafetyNetMember[]>;
  getSos(sosId: Id): Promise<SosEvent | undefined>;
  listOpenSos(): Promise<SosEvent[]>; // state open, assigned or escalated
  listAssignments(sosId: Id): Promise<Assignment[]>;
  listTimedOutAssignments(): Promise<Assignment[]>;
  listUnknownPeople(): Promise<Person[]>; // status unknown
  listSignals(personId: Id): Promise<Signal[]>;
  listCheckIns(personId: Id): Promise<CheckIn[]>;
  getTriageForSos(sosId: Id): Promise<Triage | undefined>;
  getCell(h3Cell: string): Promise<HexCell | undefined>;
  listCells(): Promise<HexCell[]>;
  listAgentSteps(subject?: string): Promise<AgentStep[]>;
  listIncidentReports(): Promise<IncidentReport[]>;

  // ---- subscriptions (return an unsubscribe function) ----
  onSos(listener: Listener<SosEvent>): Unsubscribe;
  onSignal(listener: Listener<Signal>): Unsubscribe;
  onAssignmentTimeout(listener: Listener<Assignment>): Unsubscribe;
  onAssignmentDeclined(listener: Listener<Assignment>): Unsubscribe;
}

/** The module times out an offered assignment after this long. */
export const ASSIGNMENT_TIMEOUT_MS = 10 * 60 * 1000;
