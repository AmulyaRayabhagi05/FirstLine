// Minimal store surface the messaging channels need. Method names and argument shapes follow
// the reducers in docs/contract.md (camelCase), so at merge this maps 1:1 onto PorchlightStore
// from agents/src/store/types.ts.

export type SosChannel = "app" | "sms" | "voice" | "mesh";
export type CheckInKind = "app" | "voice" | "sms" | "neighbor_visit" | "mesh";
export type CheckInResult = "safe" | "needs_help" | "no_answer";
export type AgentName = "triage" | "dispatch" | "silent_signal" | "reports";
export type AgentStepKind = "thought" | "tool_call" | "tool_result" | "decision";

export interface PressSosArgs {
  clientId: string;
  personId: number;
  message: string;
  lat: number;
  lng: number;
  channel: SosChannel;
}

export interface CheckInArgs {
  clientId: string;
  personId: number;
  kind: CheckInKind;
  result: CheckInResult;
  note: string;
}

export interface LogAgentStepArgs {
  agent: AgentName;
  subject: string;
  kind: AgentStepKind;
  content: string;
  confidence?: number;
}

/** The subset of the `person` row messaging reads. */
export interface ChannelPerson {
  id: number;
  name: string;
  phone: string;
  language: string;
  lastLat: number;
  lastLng: number;
}

export interface ChannelStore {
  /** Reducer `press_sos`. Repeat `clientId` is ignored by the reducer. */
  pressSos(args: PressSosArgs): Promise<void>;
  /** Reducer `check_in`. Repeat `clientId` is ignored by the reducer. */
  checkIn(args: CheckInArgs): Promise<void>;
  /** Reducer `log_agent_step`. */
  logAgentStep(args: LogAgentStepArgs): Promise<void>;
  /** Read: person by E.164 phone number (digits compared, formatting ignored). */
  findPersonByPhone(phone: string): Promise<ChannelPerson | undefined>;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // Treat 10-digit US numbers and +1 numbers as the same person.
  return digits.length === 10 ? `1${digits}` : digits;
}

/** In-memory fake that mirrors the reducers' idempotency on client_id. */
export class InMemoryChannelStore implements ChannelStore {
  readonly sos: PressSosArgs[] = [];
  readonly checkIns: CheckInArgs[] = [];
  readonly steps: LogAgentStepArgs[] = [];
  readonly people: ChannelPerson[];
  private seen = new Set<string>();

  constructor(people: ChannelPerson[] = []) {
    this.people = [...people];
  }

  async pressSos(args: PressSosArgs): Promise<void> {
    if (this.seen.has(`sos:${args.clientId}`)) return;
    this.seen.add(`sos:${args.clientId}`);
    this.sos.push(args);
  }

  async checkIn(args: CheckInArgs): Promise<void> {
    if (this.seen.has(`ci:${args.clientId}`)) return;
    this.seen.add(`ci:${args.clientId}`);
    this.checkIns.push(args);
  }

  async logAgentStep(args: LogAgentStepArgs): Promise<void> {
    this.steps.push(args);
  }

  async findPersonByPhone(phone: string): Promise<ChannelPerson | undefined> {
    const n = normalizePhone(phone);
    return this.people.find((p) => normalizePhone(p.phone) === n);
  }
}
