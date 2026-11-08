// Case traces for the Trace page: one person's case as hops between lanes (who called what).
// live.ts hands over plain rows on every update; the Trace page builds cases from them only while
// it is open, so the map pays nothing for it.

export type Lane = 'resident' | 'triage' | 'dispatch' | 'silent_signal' | 'reports' | 'tools' | 'database' | 'people';

export const LANES: { id: Lane; label: string; hint: string }[] = [
  { id: 'resident', label: 'Resident', hint: 'SOS messages and check-ins from the person' },
  { id: 'triage', label: 'Triage', hint: 'Nemotron agent: how urgent, who is needed' },
  { id: 'dispatch', label: 'Dispatch', hint: 'Nemotron agent: picks the nearest neighbor or escalates' },
  { id: 'silent_signal', label: 'Silent signal', hint: "Nemotron agent: people who haven't asked for help" },
  { id: 'reports', label: 'Reports', hint: 'Nemotron agent: briefings for responders' },
  { id: 'tools', label: 'Tools', hint: 'Lookups the agents call (also served over MCP)' },
  { id: 'database', label: 'SpacetimeDB', hint: 'Saves: triage, priority, reports' },
  { id: 'people', label: 'Helpers & phone', hint: 'Calls, texts, neighbor offers' },
];

/** Tools the FirstLine MCP server also serves (agents/src/mcp/tools.ts). */
export const MCP_TOOLS = new Set([
  'lookup_protocol', 'get_person_profile', 'explain_priority', 'get_signals', 'get_history',
  'get_case_trace', 'list_open_sos', 'check_message', 'get_cell_overview',
]);

export interface TraceRows {
  people: { id: string; name: string; age: number; status: string; priority: string }[];
  sos: { id: string; personId: string; channel: string; message: string; state: string; at: number }[];
  assignments: { sosId: string; helperId: string; state: string; ring: number; at: number }[];
  checkIns: { personId: string; kind: string; result: string; note: string; at: number }[];
  steps: { agent: string; subject: string; kind: string; content: string; conf: number | null; at: number }[];
}

export interface TraceEvent {
  at: number;
  from: Lane;
  to: Lane;
  kind: string;
  label: string;
  conf: number | null;
  /** The tool name for tool calls and results. */
  tool?: string;
}

export interface TraceCase {
  personId: string;
  name: string;
  age: number;
  status: string;
  priority: string;
  events: number;
  toolCalls: number;
  agents: Set<string>;
  lastAt: number;
}

let rows: TraceRows | null = null;
export const setTraceRows = (r: TraceRows) => {
  rows = r;
};
export const getTraceRows = () => rows;

const SAVE = /^(save_|set_priority)/;
const CONTACT = /^(request_call|request_visit|offer|escalate|assign)/;
export const laneForTool = (tool: string): Lane => (SAVE.test(tool) ? 'database' : CONTACT.test(tool) ? 'people' : 'tools');
const AGENT_LANES = new Set<string>(['triage', 'dispatch', 'silent_signal', 'reports']);

/** person id for every subject a step can have ("person:12", "sos:40"). */
function subjectOwner(r: TraceRows) {
  const sosOwner = new Map(r.sos.map((s) => [s.id, s.personId]));
  return (subject: string): string | undefined => {
    const [kind, id] = subject.split(':');
    if (kind === 'person') return id;
    if (kind === 'sos') return sosOwner.get(id!);
    return undefined;
  };
}

export function buildCases(r: TraceRows): TraceCase[] {
  const owner = subjectOwner(r);
  const byPerson = new Map<string, TraceCase>();
  const person = new Map(r.people.map((p) => [p.id, p]));
  const touch = (pid: string | undefined, at: number, agent?: string, tool = false) => {
    if (!pid) return;
    const p = person.get(pid);
    if (!p) return;
    let c = byPerson.get(pid);
    if (!c) {
      c = { personId: pid, name: p.name, age: p.age, status: p.status, priority: p.priority, events: 0, toolCalls: 0, agents: new Set(), lastAt: 0 };
      byPerson.set(pid, c);
    }
    c.events++;
    if (tool) c.toolCalls++;
    if (agent) c.agents.add(agent);
    c.lastAt = Math.max(c.lastAt, at);
  };
  for (const s of r.steps) touch(owner(s.subject), s.at, s.agent, s.kind === 'tool_call');
  for (const s of r.sos) touch(s.personId, s.at);
  return [...byPerson.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export function buildEvents(r: TraceRows, personId: string): TraceEvent[] {
  const owner = subjectOwner(r);
  const name = new Map(r.people.map((p) => [p.id, p.name]));
  const mySos = new Set(r.sos.filter((s) => s.personId === personId).map((s) => s.id));
  const ev: TraceEvent[] = [];
  for (const s of r.sos)
    if (s.personId === personId) ev.push({ at: s.at, from: 'resident', to: 'triage', kind: 'sos', label: `SOS via ${s.channel}: "${s.message}"`, conf: null });
  for (const c of r.checkIns)
    if (c.personId === personId)
      ev.push({ at: c.at, from: 'resident', to: 'database', kind: 'check_in', label: `Check-in (${c.kind.replace(/_/g, ' ')}): ${c.result.replace(/_/g, ' ')}${c.note ? ` · ${c.note}` : ''}`, conf: null });
  for (const a of r.assignments) {
    if (!mySos.has(a.sosId)) continue;
    const helper = name.get(a.helperId) ?? `#${a.helperId}`;
    ev.push({ at: a.at, from: 'dispatch', to: 'people', kind: 'offer', label: `Offered to ${helper} (ring ${a.ring})`, conf: null });
    if (a.state !== 'offered') ev.push({ at: a.at + 1, from: 'people', to: 'dispatch', kind: a.state, label: `${helper}: ${a.state.replace(/_/g, ' ')}`, conf: null });
  }
  for (const s of r.steps) {
    if (owner(s.subject) !== personId) continue;
    const agent = (AGENT_LANES.has(s.agent) ? s.agent : 'tools') as Lane;
    if (s.kind === 'tool_call') {
      const tool = s.content.split('(')[0]!.trim();
      ev.push({ at: s.at, from: agent, to: laneForTool(tool), kind: 'tool_call', label: s.content, conf: null, tool });
    } else if (s.kind === 'tool_result') {
      const tool = s.content.split(' → ')[0]!.trim();
      ev.push({ at: s.at, from: laneForTool(tool), to: agent, kind: 'tool_result', label: s.content, conf: null, tool });
    } else ev.push({ at: s.at, from: agent, to: agent, kind: s.kind, label: s.content, conf: s.conf });
  }
  return ev.sort((a, b) => a.at - b.at);
}
