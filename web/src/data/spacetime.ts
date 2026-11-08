// Seam between the map and the backend: how one person row becomes a map status.
//   person.status      'unknown' | 'needs_help' | 'safe'
//   person.priority    'P1' | 'P2' | 'P3' | 'safe' | 'unknown'
//   assignment.state   'offered' | 'accepted' | 'declined' | 'timed_out' | 'done'
// The live connection itself is in ./live.ts.

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
  return person.priority === 'P1' ? 'p1' : person.priority === 'P2' ? 'p2' : 'unknown';
}
