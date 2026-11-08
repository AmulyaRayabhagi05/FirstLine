// FirstLineStore on a live SpacetimeDB database (generated bindings in ../module_bindings).
// Writes call reducers; reads come from the subscribed client cache; subscriptions are table
// insert/update callbacks. IDs are u64 (bigint) on the wire and numbers here.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Infer } from "spacetimedb";
import { DbConnection } from "../module_bindings/index";
import type AgentStepRowT from "../module_bindings/agent_step_table";
import type AssignmentRowT from "../module_bindings/assignment_table";
import type CheckInRowT from "../module_bindings/check_in_table";
import type HexCellRowT from "../module_bindings/hex_cell_table";
import type HouseholdRowT from "../module_bindings/household_table";
import type IncidentReportRowT from "../module_bindings/incident_report_table";
import type PersonRowT from "../module_bindings/person_table";
import type SafetyNetRowT from "../module_bindings/safety_net_table";
import type SignalRowT from "../module_bindings/signal_table";
import type SosEventRowT from "../module_bindings/sos_event_table";
import type TriageRowT from "../module_bindings/triage_table";
import type {
  AgentStep,
  Assignment,
  CheckIn,
  CheckInArgs,
  FirstLineStore,
  HexCell,
  Household,
  Id,
  IncidentReport,
  Listener,
  LogAgentStepArgs,
  Person,
  PressSosArgs,
  PriorityCategory,
  RegisterPersonArgs,
  SafetyNetMember,
  SafetyNetMemberInput,
  SaveIncidentReportArgs,
  SaveTriageArgs,
  Signal,
  SignalKind,
  SosEvent,
  Triage,
  Unsubscribe,
} from "./types.js";

type PersonRow = Infer<typeof PersonRowT>;
type HouseholdRow = Infer<typeof HouseholdRowT>;
type HexCellRow = Infer<typeof HexCellRowT>;
type SafetyNetRow = Infer<typeof SafetyNetRowT>;
type SosRow = Infer<typeof SosEventRowT>;
type CheckInRow = Infer<typeof CheckInRowT>;
type SignalRow = Infer<typeof SignalRowT>;
type TriageRow = Infer<typeof TriageRowT>;
type AssignmentRow = Infer<typeof AssignmentRowT>;
type IncidentReportRow = Infer<typeof IncidentReportRowT>;
type AgentStepRow = Infer<typeof AgentStepRowT>;

export const DEFAULT_TOKEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spacetime-token");

export interface SpacetimeConfig {
  host: string;
  dbName: string;
  /** Explicit token (SPACETIME_TOKEN). Otherwise the saved token file is used, then anonymous. */
  token?: string;
  tokenPath: string;
  /** How long to wait for the connection and initial subscription. */
  connectTimeoutMs: number;
}

export function spacetimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpacetimeConfig {
  return {
    host: env.SPACETIME_HOST || "https://maincloud.spacetimedb.com",
    dbName: env.SPACETIME_DB_NAME || "firstline",
    token: env.SPACETIME_TOKEN || undefined,
    tokenPath: env.SPACETIME_TOKEN_PATH || DEFAULT_TOKEN_PATH,
    connectTimeoutMs: Number(env.SPACETIME_CONNECT_TIMEOUT_MS ?? 20_000),
  };
}

/** Tables the worker reads. agent_step, audit_log, key_pass and config are not needed. */
export const WORKER_QUERIES = [
  "SELECT * FROM person",
  "SELECT * FROM household",
  "SELECT * FROM hex_cell",
  "SELECT * FROM safety_net",
  "SELECT * FROM sos_event",
  "SELECT * FROM check_in",
  "SELECT * FROM signal",
  "SELECT * FROM triage",
  "SELECT * FROM assignment",
  "SELECT * FROM incident_report",
];

// ---------------- row conversion ----------------

const n = (v: bigint) => Number(v);
const big = (v: number) => BigInt(v);

const toPerson = (r: PersonRow): Person => ({
  id: n(r.id),
  identity: r.identity?.toHexString(),
  name: r.name,
  age: r.age,
  livesAlone: r.livesAlone,
  mobility: r.mobility as Person["mobility"],
  medicalNeeds: r.medicalNeeds,
  poweredDevice: r.poweredDevice,
  hasSmartphone: r.hasSmartphone,
  language: r.language,
  phone: r.phone,
  householdId: n(r.householdId),
  lastLat: r.lastLat,
  lastLng: r.lastLng,
  h3Cell: r.h3Cell,
  status: r.status as Person["status"],
  priority: r.priority as Person["priority"],
  priorityScore: r.priorityScore,
  lastSeen: r.lastSeen?.toDate(),
});
const toHousehold = (r: HouseholdRow): Household => ({
  id: n(r.id),
  address: r.address,
  lat: r.lat,
  lng: r.lng,
  h3Cell: r.h3Cell,
  hasSmartLock: r.hasSmartLock,
  lockbox: r.lockbox,
});
const toCell = (r: HexCellRow): HexCell => ({
  h3Cell: r.h3Cell,
  totalPeople: r.totalPeople,
  safe: r.safe,
  needsHelp: r.needsHelp,
  unknown: r.unknown,
  censusElderlyEstimate: r.censusElderlyEstimate,
  coverageGap: r.coverageGap,
  alertLevel: r.alertLevel,
});
const toNet = (r: SafetyNetRow): SafetyNetMember => ({
  id: n(r.id),
  ownerId: n(r.ownerId),
  memberId: n(r.memberId),
  ring: r.ring,
  skills: r.skills,
});
const toSos = (r: SosRow): SosEvent => ({
  id: n(r.id),
  clientId: r.clientId,
  personId: n(r.personId),
  message: r.message,
  lat: r.lat,
  lng: r.lng,
  h3Cell: r.h3Cell,
  channel: r.channel as SosEvent["channel"],
  createdAt: r.createdAt.toDate(),
  state: r.state as SosEvent["state"],
});
const toCheckIn = (r: CheckInRow): CheckIn => ({
  id: n(r.id),
  clientId: r.clientId,
  personId: n(r.personId),
  kind: r.kind as CheckIn["kind"],
  result: r.result as CheckIn["result"],
  note: r.note,
  createdAt: r.createdAt.toDate(),
});
const toSignal = (r: SignalRow): Signal => ({
  id: n(r.id),
  personId: n(r.personId),
  kind: r.kind as SignalKind,
  value: r.value,
  createdAt: r.createdAt.toDate(),
});
const toTriage = (r: TriageRow): Triage => ({
  id: n(r.id),
  sosId: r.sosId === undefined ? undefined : n(r.sosId),
  personId: n(r.personId),
  urgency: r.urgency,
  confidence: r.confidence,
  needs: r.needs as Triage["needs"],
  priority: r.priority as Triage["priority"],
  reason: r.reason,
  model: r.model,
  createdAt: r.createdAt.toDate(),
});
const toAssignment = (r: AssignmentRow): Assignment => ({
  id: n(r.id),
  sosId: n(r.sosId),
  helperId: n(r.helperId),
  state: r.state as Assignment["state"],
  offeredAt: r.offeredAt.toDate(),
  ring: r.ring,
});
const toReport = (r: IncidentReportRow): IncidentReport => ({
  id: n(r.id),
  h3Cell: r.h3Cell,
  summary: r.summary,
  blockedRoads: r.blockedRoads,
  p1: r.p1,
  p2: r.p2,
  unknown: r.unknown,
  createdAt: r.createdAt.toDate(),
});
export const toAgentStep = (r: AgentStepRow): AgentStep => ({
  id: n(r.id),
  agent: r.agent as AgentStep["agent"],
  subject: r.subject,
  kind: r.kind as AgentStep["kind"],
  content: r.content,
  confidence: r.confidence ?? undefined,
  createdAt: r.createdAt.toDate(),
});

function maxId<T extends { id: bigint }>(rows: Iterable<T>): bigint {
  let m = 0n;
  for (const r of rows) if (r.id > m) m = r.id;
  return m;
}

// ---------------- store ----------------

export class SpacetimeStore implements FirstLineStore {
  /** Steps this process wrote (agent_step is not subscribed; the UI reads it directly). */
  private readonly ownSteps: AgentStep[] = [];
  private stepSeq = 0;
  private readonly listeners = {
    sos: new Set<Listener<SosEvent>>(),
    signal: new Set<Listener<Signal>>(),
    timeout: new Set<Listener<Assignment>>(),
    declined: new Set<Listener<Assignment>>(),
  };
  /** Fires on any cache change; used to wait for a reducer's rows to arrive. */
  private readonly changeWaiters = new Set<() => void>();

  private constructor(
    readonly conn: DbConnection,
    readonly identityHex: string,
  ) {}

  /** Connect, subscribe to the worker's tables and resolve once the cache is filled. */
  static async connect(cfg: SpacetimeConfig): Promise<SpacetimeStore> {
    let token = cfg.token;
    if (!token && existsSync(cfg.tokenPath)) token = readFileSync(cfg.tokenPath, "utf8").trim() || undefined;
    const savedFromFile = !cfg.token && !!token;

    const { conn, identityHex } = await new Promise<{ conn: DbConnection; identityHex: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SpacetimeDB connect timed out after ${cfg.connectTimeoutMs} ms (${cfg.host}, ${cfg.dbName})`)),
        cfg.connectTimeoutMs,
      );
      DbConnection.builder()
        .withUri(cfg.host)
        .withDatabaseName(cfg.dbName)
        .withToken(token)
        .onConnect((c, identity, newToken) => {
          clearTimeout(timer);
          if (!cfg.token && newToken && newToken !== token) {
            writeFileSync(cfg.tokenPath, newToken, { encoding: "utf8", mode: 0o600 });
            console.log(`[spacetime] saved ${savedFromFile ? "refreshed" : "new"} token to ${cfg.tokenPath}`);
          }
          resolve({ conn: c, identityHex: identity.toHexString() });
        })
        .onConnectError((_ctx, err) => {
          clearTimeout(timer);
          reject(err);
        })
        .onDisconnect((_ctx, err) => {
          if (err) console.error("[spacetime] disconnected:", err.message);
        })
        .build();
    });

    const store = new SpacetimeStore(conn, identityHex);
    await new Promise<void>((resolve, reject) => {
      conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((ctx) => reject(new Error(`subscription failed: ${String((ctx as { event?: unknown }).event ?? "unknown")}`)))
        .subscribe(WORKER_QUERIES);
    });
    store.attachCallbacks();
    return store;
  }

  private attachCallbacks() {
    const db = this.conn.db;
    const changed = () => {
      for (const w of [...this.changeWaiters]) w();
    };
    db.sosEvent.onInsert((_ctx, row) => {
      changed();
      this.emit(this.listeners.sos, toSos(row));
    });
    db.signal.onInsert((_ctx, row) => {
      changed();
      this.emit(this.listeners.signal, toSignal(row));
    });
    db.assignment.onInsert(() => changed());
    db.assignment.onUpdate((_ctx, oldRow, newRow) => {
      changed();
      if (oldRow.state === "offered" && newRow.state === "timed_out") this.emit(this.listeners.timeout, toAssignment(newRow));
      if (oldRow.state === "offered" && newRow.state === "declined") this.emit(this.listeners.declined, toAssignment(newRow));
    });
    for (const t of [db.person, db.triage, db.incidentReport, db.checkIn, db.hexCell, db.safetyNet, db.household] as const) {
      (t as { onInsert(cb: () => void): void }).onInsert(changed);
    }
  }

  private emit<T>(set: Set<Listener<T>>, row: T) {
    for (const l of set) {
      Promise.resolve()
        .then(() => l(row))
        .catch((err) => console.error("[spacetime] listener failed:", err));
    }
  }

  /** Wait until `probe` returns a value (checked now and after each cache change). */
  private waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
    const now = probe();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const v = probe();
        if (v !== undefined) {
          cleanup();
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.changeWaiters.delete(check);
      };
      this.changeWaiters.add(check);
    });
  }

  disconnect() {
    this.conn.disconnect();
  }

  // ---------------- phone / channel reducers ----------------

  async registerPerson(args: RegisterPersonArgs): Promise<{ personId: Id; householdId: Id }> {
    const before = maxId(this.conn.db.person.iter());
    await this.conn.reducers.registerPerson(args);
    const row = await this.waitFor(
      () => [...this.conn.db.person.iter()].find((p) => p.id > before && p.name === args.name && p.phone === args.phone),
      "registered person",
    );
    return { personId: n(row.id), householdId: n(row.householdId) };
  }

  async setSafetyNet(ownerId: Id, members: SafetyNetMemberInput[]): Promise<void> {
    await this.conn.reducers.setSafetyNet({
      ownerId: big(ownerId),
      members: members.map((m) => ({ memberId: big(m.memberId), ring: m.ring, skills: m.skills })),
    });
  }

  async pressSos(args: PressSosArgs): Promise<Id> {
    await this.conn.reducers.pressSos({ ...args, personId: big(args.personId) });
    const row = await this.waitFor(() => [...this.conn.db.sosEvent.client_id.filter(args.clientId)][0], `sos ${args.clientId}`);
    return n(row.id);
  }

  async checkIn(args: CheckInArgs): Promise<void> {
    await this.conn.reducers.checkIn({ ...args, personId: big(args.personId) });
  }

  async reportSignal(personId: Id, kind: SignalKind, value: number): Promise<void> {
    await this.conn.reducers.reportSignal({ personId: big(personId), kind, value });
  }

  // ---------------- helper reducers (the worker identity may call these too) ----------------

  async acceptAssignment(assignmentId: Id): Promise<void> {
    await this.conn.reducers.acceptAssignment({ assignmentId: big(assignmentId) });
  }
  async declineAssignment(assignmentId: Id): Promise<void> {
    await this.conn.reducers.declineAssignment({ assignmentId: big(assignmentId) });
  }
  async markSafe(personId: Id, note: string): Promise<void> {
    await this.conn.reducers.markSafe({ personId: big(personId), note });
  }

  // ---------------- worker reducers ----------------

  async saveTriage(args: SaveTriageArgs): Promise<Id> {
    const before = maxId(this.conn.db.triage.iter());
    await this.conn.reducers.saveTriage({
      sosId: args.sosId === undefined ? undefined : big(args.sosId),
      personId: big(args.personId),
      urgency: args.urgency,
      confidence: args.confidence,
      needs: args.needs,
      priority: args.priority,
      reason: args.reason,
      model: args.model,
    });
    const row = await this.waitFor(
      () => [...this.conn.db.triage.iter()].find((t) => t.id > before && t.personId === big(args.personId)),
      "saved triage",
    );
    return n(row.id);
  }

  async assignHelper(sosId: Id, helperId: Id, ring: number): Promise<Id> {
    const before = maxId(this.conn.db.assignment.iter());
    await this.conn.reducers.assignHelper({ sosId: big(sosId), helperId: big(helperId), ring });
    const row = await this.waitFor(
      () =>
        [...this.conn.db.assignment.sos_id.filter(big(sosId))].find((a) => a.id > before && a.helperId === big(helperId)),
      "new assignment",
    );
    return n(row.id);
  }

  async escalate(sosId: Id, reason: string): Promise<void> {
    await this.conn.reducers.escalate({ sosId: big(sosId), reason });
  }

  async saveIncidentReport(args: SaveIncidentReportArgs): Promise<Id> {
    const before = maxId(this.conn.db.incidentReport.iter());
    await this.conn.reducers.saveIncidentReport(args);
    const row = await this.waitFor(
      () => [...this.conn.db.incidentReport.iter()].find((r) => r.id > before && r.h3Cell === args.h3Cell),
      "incident report",
    );
    return n(row.id);
  }

  async logAgentStep(args: LogAgentStepArgs): Promise<void> {
    await this.conn.reducers.logAgentStep({ ...args, confidence: args.confidence });
    this.ownSteps.push({ id: ++this.stepSeq, ...args, createdAt: new Date() });
    if (this.ownSteps.length > 5000) this.ownSteps.splice(0, 1000);
  }

  async setPriority(personId: Id, priority: PriorityCategory, priorityScore: number): Promise<void> {
    await this.conn.reducers.setPriority({ personId: big(personId), priority, priorityScore });
  }
  async setCellAlert(h3Cell: string, alertLevel: string): Promise<void> {
    await this.conn.reducers.setCellAlert({ h3Cell, alertLevel });
  }
  async setCellCensus(h3Cell: string, censusElderlyEstimate: number): Promise<void> {
    await this.conn.reducers.setCellCensus({ h3Cell, censusElderlyEstimate });
  }

  // ---------------- reads (client cache) ----------------

  async getPerson(personId: Id) {
    const r = this.conn.db.person.id.find(big(personId));
    return r ? toPerson(r) : undefined;
  }
  async getHousehold(householdId: Id) {
    const r = this.conn.db.household.id.find(big(householdId));
    return r ? toHousehold(r) : undefined;
  }
  async listPeople() {
    return [...this.conn.db.person.iter()].map(toPerson);
  }
  async getSafetyNet(ownerId: Id) {
    return [...this.conn.db.safetyNet.iter()].filter((m) => m.ownerId === big(ownerId)).map(toNet);
  }
  async getSos(sosId: Id) {
    const r = this.conn.db.sosEvent.id.find(big(sosId));
    return r ? toSos(r) : undefined;
  }
  async listOpenSos() {
    return [...this.conn.db.sosEvent.iter()].filter((s) => s.state !== "resolved").map(toSos);
  }
  async listAssignments(sosId: Id) {
    return [...this.conn.db.assignment.sos_id.filter(big(sosId))].map(toAssignment).sort((a, b) => a.id - b.id);
  }
  async listTimedOutAssignments() {
    return [...this.conn.db.assignment.iter()].filter((a) => a.state === "timed_out").map(toAssignment);
  }
  async listUnknownPeople() {
    return [...this.conn.db.person.iter()].filter((p) => p.status === "unknown").map(toPerson);
  }
  async listSignals(personId: Id) {
    return [...this.conn.db.signal.iter()].filter((s) => s.personId === big(personId)).map(toSignal);
  }
  async listCheckIns(personId: Id) {
    return [...this.conn.db.checkIn.person_id.filter(big(personId))].map(toCheckIn);
  }
  async getTriageForSos(sosId: Id) {
    let best: TriageRow | undefined;
    for (const t of this.conn.db.triage.iter()) {
      if (t.sosId === big(sosId) && (!best || t.id > best.id)) best = t;
    }
    return best ? toTriage(best) : undefined;
  }
  async getCell(h3Cell: string) {
    const r = this.conn.db.hexCell.h3_cell.find(h3Cell);
    return r ? toCell(r) : undefined;
  }
  async listCells() {
    return [...this.conn.db.hexCell.iter()].map(toCell);
  }
  async listAgentSteps(subject?: string) {
    return this.ownSteps.filter((s) => subject === undefined || s.subject === subject);
  }
  async listIncidentReports() {
    return [...this.conn.db.incidentReport.iter()].map(toReport);
  }

  // ---------------- subscriptions ----------------

  private sub<T>(set: Set<Listener<T>>, l: Listener<T>): Unsubscribe {
    set.add(l);
    return () => set.delete(l);
  }
  onSos(l: Listener<SosEvent>) {
    return this.sub(this.listeners.sos, l);
  }
  onSignal(l: Listener<Signal>) {
    return this.sub(this.listeners.signal, l);
  }
  onAssignmentTimeout(l: Listener<Assignment>) {
    return this.sub(this.listeners.timeout, l);
  }
  onAssignmentDeclined(l: Listener<Assignment>) {
    return this.sub(this.listeners.declined, l);
  }
}
