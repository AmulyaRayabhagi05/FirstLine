import { latLngToCell } from "h3-js";
import {
  ASSIGNMENT_TIMEOUT_MS,
  type AgentStep,
  type Assignment,
  type CheckIn,
  type CheckInArgs,
  type HexCell,
  type Household,
  type Id,
  type IncidentReport,
  type Listener,
  type LogAgentStepArgs,
  type Person,
  type FirstLineStore,
  type PressSosArgs,
  type PriorityCategory,
  type RegisterPersonArgs,
  type SafetyNetMember,
  type SafetyNetMemberInput,
  type SaveIncidentReportArgs,
  type SaveTriageArgs,
  type Signal,
  type SignalKind,
  type SosEvent,
  type Triage,
  type Unsubscribe,
} from "./types.js";

export const H3_RES = 9;

export interface InMemoryStoreOptions {
  /** Clock used for created_at / offered_at. Defaults to the wall clock. */
  now?: () => Date;
}

/**
 * In-process stand-in for the SpacetimeDB module. Behaves like the reducers in
 * docs/contract.md closely enough for tests and the offline demo. The module's scheduled
 * 10-minute assignment timeout is simulated by calling `tick(now)`.
 */
export class InMemoryStore implements FirstLineStore {
  readonly people = new Map<Id, Person>();
  readonly households = new Map<Id, Household>();
  readonly cells = new Map<string, HexCell>();
  readonly safetyNet: SafetyNetMember[] = [];
  readonly sos = new Map<Id, SosEvent>();
  readonly checkIns: CheckIn[] = [];
  readonly signals: Signal[] = [];
  readonly triages: Triage[] = [];
  readonly assignments = new Map<Id, Assignment>();
  readonly incidentReports: IncidentReport[] = [];
  readonly agentSteps: AgentStep[] = [];
  readonly auditLog: { actor: string; action: string; target: string; createdAt: Date }[] = [];

  private seq = 0;
  private readonly clock: () => Date;
  private readonly listeners = {
    sos: new Set<Listener<SosEvent>>(),
    signal: new Set<Listener<Signal>>(),
    timeout: new Set<Listener<Assignment>>(),
    declined: new Set<Listener<Assignment>>(),
  };
  /** Promises returned by listeners, so tests can await quiescence. */
  private pending = new Set<Promise<unknown>>();

  constructor(opts: InMemoryStoreOptions = {}) {
    this.clock = opts.now ?? (() => new Date());
  }

  private nextId(): Id {
    return ++this.seq;
  }

  private emit<T>(set: Set<Listener<T>>, row: T): void {
    for (const l of set) {
      try {
        const r = l(row);
        if (r && typeof (r as Promise<void>).then === "function") {
          const p = (r as Promise<void>).catch((err) => {
            console.error("[store] listener failed:", err);
          });
          this.pending.add(p);
          p.finally(() => this.pending.delete(p));
        }
      } catch (err) {
        console.error("[store] listener failed:", err);
      }
    }
  }

  /** Wait until every async listener (and anything they triggered) has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private subscribe<T>(set: Set<Listener<T>>, l: Listener<T>): Unsubscribe {
    set.add(l);
    return () => set.delete(l);
  }

  private ensureCell(h3Cell: string): HexCell {
    let cell = this.cells.get(h3Cell);
    if (!cell) {
      cell = {
        h3Cell,
        totalPeople: 0,
        safe: 0,
        needsHelp: 0,
        unknown: 0,
        censusElderlyEstimate: 0,
        coverageGap: false,
        alertLevel: "",
      };
      this.cells.set(h3Cell, cell);
    }
    return cell;
  }

  /** Mirrors the module's recount_cells. */
  recountCells(): void {
    for (const cell of this.cells.values()) {
      cell.totalPeople = cell.safe = cell.needsHelp = cell.unknown = 0;
    }
    for (const p of this.people.values()) {
      const cell = this.ensureCell(p.h3Cell);
      cell.totalPeople++;
      if (p.status === "safe") cell.safe++;
      else if (p.status === "needs_help") cell.needsHelp++;
      else cell.unknown++;
    }
    for (const cell of this.cells.values()) {
      cell.coverageGap = cell.censusElderlyEstimate > cell.totalPeople;
    }
  }

  /**
   * Simulates the scheduled `assignment_timeout` reducer: every `offered` assignment older
   * than 10 minutes at `now` becomes `timed_out`, and onAssignmentTimeout listeners fire.
   */
  tick(now: Date = this.clock()): Assignment[] {
    const timedOut: Assignment[] = [];
    for (const a of this.assignments.values()) {
      if (a.state === "offered" && now.getTime() - a.offeredAt.getTime() >= ASSIGNMENT_TIMEOUT_MS) {
        a.state = "timed_out";
        timedOut.push({ ...a });
      }
    }
    for (const a of timedOut) this.emit(this.listeners.timeout, a);
    return timedOut;
  }

  // ---------------- phone / channel reducers ----------------

  async registerPerson(args: RegisterPersonArgs): Promise<{ personId: Id; householdId: Id }> {
    const h3Cell = latLngToCell(args.lat, args.lng, H3_RES);
    const household: Household = {
      id: this.nextId(),
      address: args.address,
      lat: args.lat,
      lng: args.lng,
      h3Cell,
      hasSmartLock: false,
      lockbox: false,
    };
    this.households.set(household.id, household);
    const person: Person = {
      id: this.nextId(),
      name: args.name,
      age: args.age,
      livesAlone: args.livesAlone,
      mobility: args.mobility,
      medicalNeeds: args.medicalNeeds,
      poweredDevice: args.poweredDevice,
      hasSmartphone: args.hasSmartphone,
      language: args.language,
      phone: args.phone,
      householdId: household.id,
      lastLat: args.lat,
      lastLng: args.lng,
      h3Cell,
      status: "unknown",
      priority: "unknown",
      priorityScore: 0,
    };
    this.people.set(person.id, person);
    this.recountCells();
    return { personId: person.id, householdId: household.id };
  }

  async setSafetyNet(ownerId: Id, members: SafetyNetMemberInput[]): Promise<void> {
    for (let i = this.safetyNet.length - 1; i >= 0; i--) {
      if (this.safetyNet[i]!.ownerId === ownerId) this.safetyNet.splice(i, 1);
    }
    for (const m of members) {
      this.safetyNet.push({ id: this.nextId(), ownerId, memberId: m.memberId, ring: m.ring, skills: m.skills });
    }
  }

  async pressSos(args: PressSosArgs): Promise<Id> {
    for (const s of this.sos.values()) if (s.clientId === args.clientId) return s.id;
    const sos: SosEvent = {
      id: this.nextId(),
      clientId: args.clientId,
      personId: args.personId,
      message: args.message,
      lat: args.lat,
      lng: args.lng,
      h3Cell: latLngToCell(args.lat, args.lng, H3_RES),
      channel: args.channel,
      createdAt: this.clock(),
      state: "open",
    };
    this.sos.set(sos.id, sos);
    const person = this.people.get(args.personId);
    if (person) {
      person.status = "needs_help";
      person.lastSeen = sos.createdAt;
      person.lastLat = args.lat;
      person.lastLng = args.lng;
    }
    this.recountCells();
    this.emit(this.listeners.sos, { ...sos });
    return sos.id;
  }

  async checkIn(args: CheckInArgs): Promise<void> {
    if (this.checkIns.some((c) => c.clientId === args.clientId)) return;
    const row: CheckIn = { id: this.nextId(), ...args, createdAt: this.clock() };
    this.checkIns.push(row);
    const person = this.people.get(args.personId);
    if (person && args.result !== "no_answer") {
      person.status = args.result;
      person.lastSeen = row.createdAt;
      if (args.result === "safe") person.priority = "safe";
    }
    this.recountCells();
  }

  async reportSignal(personId: Id, kind: SignalKind, value: number): Promise<void> {
    const row: Signal = { id: this.nextId(), personId, kind, value, createdAt: this.clock() };
    this.signals.push(row);
    this.emit(this.listeners.signal, { ...row });
  }

  // ---------------- helper reducers ----------------

  async acceptAssignment(assignmentId: Id): Promise<void> {
    const a = this.assignments.get(assignmentId);
    if (!a || a.state !== "offered") throw new Error(`assignment ${assignmentId} is not offered`);
    a.state = "accepted";
  }

  async declineAssignment(assignmentId: Id): Promise<void> {
    const a = this.assignments.get(assignmentId);
    if (!a || a.state !== "offered") throw new Error(`assignment ${assignmentId} is not offered`);
    a.state = "declined";
    this.emit(this.listeners.declined, { ...a });
  }

  async markSafe(personId: Id, note: string): Promise<void> {
    const person = this.people.get(personId);
    if (!person) throw new Error(`no person ${personId}`);
    person.status = "safe";
    person.priority = "safe";
    person.lastSeen = this.clock();
    for (const s of this.sos.values()) {
      if (s.personId === personId && s.state !== "resolved") {
        s.state = "resolved";
        for (const a of this.assignments.values()) {
          if (a.sosId === s.id && (a.state === "accepted" || a.state === "offered")) a.state = "done";
        }
      }
    }
    this.auditLog.push({ actor: "helper", action: `mark_safe: ${note}`, target: `person:${personId}`, createdAt: this.clock() });
    this.recountCells();
  }

  // ---------------- worker reducers ----------------

  async saveTriage(args: SaveTriageArgs): Promise<Id> {
    const row: Triage = { id: this.nextId(), ...args, createdAt: this.clock() };
    this.triages.push(row);
    const person = this.people.get(args.personId);
    if (person) person.priority = args.priority;
    return row.id;
  }

  async assignHelper(sosId: Id, helperId: Id, ring: number): Promise<Id> {
    const sos = this.sos.get(sosId);
    if (!sos) throw new Error(`no sos ${sosId}`);
    if (sos.state === "resolved") throw new Error(`sos ${sosId} is resolved`);
    if (!this.people.has(helperId)) throw new Error(`no person ${helperId}`);
    const a: Assignment = { id: this.nextId(), sosId, helperId, state: "offered", offeredAt: this.clock(), ring };
    this.assignments.set(a.id, a);
    if (sos.state === "open") sos.state = "assigned";
    return a.id;
  }

  async escalate(sosId: Id, reason: string): Promise<void> {
    const sos = this.sos.get(sosId);
    if (!sos) throw new Error(`no sos ${sosId}`);
    sos.state = "escalated";
    this.auditLog.push({ actor: "agent:dispatch", action: `escalate: ${reason}`, target: `sos:${sosId}`, createdAt: this.clock() });
  }

  async saveIncidentReport(args: SaveIncidentReportArgs): Promise<Id> {
    const row: IncidentReport = { id: this.nextId(), ...args, createdAt: this.clock() };
    this.incidentReports.push(row);
    return row.id;
  }

  async logAgentStep(args: LogAgentStepArgs): Promise<void> {
    this.agentSteps.push({ id: this.nextId(), ...args, createdAt: this.clock() });
  }

  async setPriority(personId: Id, priority: PriorityCategory, priorityScore: number): Promise<void> {
    const person = this.people.get(personId);
    if (!person) throw new Error(`no person ${personId}`);
    person.priority = priority;
    person.priorityScore = priorityScore;
  }

  async setCellAlert(h3Cell: string, alertLevel: string): Promise<void> {
    this.ensureCell(h3Cell).alertLevel = alertLevel;
  }

  async setCellCensus(h3Cell: string, censusElderlyEstimate: number): Promise<void> {
    this.ensureCell(h3Cell).censusElderlyEstimate = censusElderlyEstimate;
    this.recountCells();
  }

  // ---------------- reads (return copies) ----------------

  async getPerson(personId: Id) {
    const p = this.people.get(personId);
    return p && { ...p };
  }
  async getHousehold(householdId: Id) {
    const h = this.households.get(householdId);
    return h && { ...h };
  }
  async listPeople() {
    return [...this.people.values()].map((p) => ({ ...p }));
  }
  async getSafetyNet(ownerId: Id) {
    return this.safetyNet.filter((m) => m.ownerId === ownerId).map((m) => ({ ...m }));
  }
  async getSos(sosId: Id) {
    const s = this.sos.get(sosId);
    return s && { ...s };
  }
  async listOpenSos() {
    return [...this.sos.values()].filter((s) => s.state !== "resolved").map((s) => ({ ...s }));
  }
  async listAssignments(sosId: Id) {
    return [...this.assignments.values()].filter((a) => a.sosId === sosId).map((a) => ({ ...a }));
  }
  async listTimedOutAssignments() {
    return [...this.assignments.values()].filter((a) => a.state === "timed_out").map((a) => ({ ...a }));
  }
  async listUnknownPeople() {
    return [...this.people.values()].filter((p) => p.status === "unknown").map((p) => ({ ...p }));
  }
  async listSignals(personId: Id) {
    return this.signals.filter((s) => s.personId === personId).map((s) => ({ ...s }));
  }
  async listCheckIns(personId: Id) {
    return this.checkIns.filter((c) => c.personId === personId).map((c) => ({ ...c }));
  }
  async getTriageForSos(sosId: Id) {
    const t = [...this.triages].reverse().find((t) => t.sosId === sosId);
    return t && { ...t };
  }
  async getCell(h3Cell: string) {
    const c = this.cells.get(h3Cell);
    return c && { ...c };
  }
  async listCells() {
    return [...this.cells.values()].map((c) => ({ ...c }));
  }
  async listAgentSteps(subject?: string) {
    return this.agentSteps.filter((s) => subject === undefined || s.subject === subject).map((s) => ({ ...s }));
  }
  async listIncidentReports() {
    return this.incidentReports.map((r) => ({ ...r }));
  }

  // ---------------- subscriptions ----------------

  onSos(l: Listener<SosEvent>) {
    return this.subscribe(this.listeners.sos, l);
  }
  onSignal(l: Listener<Signal>) {
    return this.subscribe(this.listeners.signal, l);
  }
  onAssignmentTimeout(l: Listener<Assignment>) {
    return this.subscribe(this.listeners.timeout, l);
  }
  onAssignmentDeclined(l: Listener<Assignment>) {
    return this.subscribe(this.listeners.declined, l);
  }
}
