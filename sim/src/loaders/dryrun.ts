// A SimStore that only counts calls. Used by `npm run storm` with no target and by tests.
import type { CheckInArgs, Id, PressSosArgs, RegisterPersonArgs, SafetyNetMemberInput, SignalKind, SimStore } from "./types.js";

export class DryRunStore implements SimStore {
  counts: Record<string, number> = {};
  private nextPerson = 1;
  private nextSos = 1;
  readonly sos: PressSosArgs[] = [];

  private bump(k: string) {
    this.counts[k] = (this.counts[k] ?? 0) + 1;
  }
  async registerPerson(_args: RegisterPersonArgs) {
    this.bump("registerPerson");
    const id = this.nextPerson++;
    return { personId: id, householdId: id };
  }
  async setSafetyNet(_ownerId: Id, members: SafetyNetMemberInput[]) {
    this.bump("setSafetyNet");
    this.counts.netMembers = (this.counts.netMembers ?? 0) + members.length;
  }
  async pressSos(args: PressSosArgs) {
    this.bump("pressSos");
    this.sos.push(args);
    return this.nextSos++;
  }
  async checkIn(args: CheckInArgs) {
    this.bump(`checkIn:${args.result}`);
  }
  async reportSignal(_personId: Id, kind: SignalKind, _value: number) {
    this.bump(`reportSignal:${kind}`);
  }
}
