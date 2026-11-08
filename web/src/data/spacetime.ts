// Seam between the map and the backend.
//
// The map only needs one thing per household: a map status. In the live build these come
// from the SpacetimeDB module in ../../server/src/index.ts:
//   person.status      'unknown' | 'needs_help' | 'safe'
//   person.priority    'P1' | 'P2' | 'P3'
//   assignment.state   'offered' | 'accepted' | 'declined' | 'timed_out' | 'done'
//   agent_step         { agent, subject, kind, content, confidence, created_at }  (feeds the activity panel)
//
// To go live: generate TypeScript bindings into web/src/module_bindings with
//   spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path server
// connect with DbConnection from those bindings, subscribe to person, assignment and agent_step,
// and feed each row through toMapStatus. Until then the app runs the simulated replay in ../sim/world.ts.

import type { Status } from '../sim/world';

export interface PersonRow {
  status: 'unknown' | 'needs_help' | 'safe' | string;
  priority: 'P1' | 'P2' | 'P3' | string;
}
export interface AssignmentRow {
  state: 'offered' | 'accepted' | 'declined' | 'timed_out' | 'done' | string;
}

export function toMapStatus(person: PersonRow, activeAssignment?: AssignmentRow | null): Status {
  if (person.status === 'safe') return 'safe';
  if (activeAssignment && (activeAssignment.state === 'offered' || activeAssignment.state === 'accepted')) return 'enroute';
  if (person.status === 'needs_help') return person.priority === 'P1' ? 'p1' : 'p2';
  return person.priority === 'P2' ? 'p2' : 'unknown';
}

export const DATA_MODE: 'simulated' | 'live' = import.meta.env.VITE_DATA_MODE === 'live' ? 'live' : 'simulated';
