# FirstLine backend contract

Every backend branch codes against these names. Changing a table, column or reducer name or
argument here is a breaking change: update this file in the same commit and say so in the
commit message. Source of truth for the product: the "FirstLine: Devpost Submission and
Build Setup" doc (both tabs).

## Decisions

- **SpacetimeDB module in TypeScript** (`server/`), SpacetimeDB CLI 2.14. Rust is not installed
  on the team machines, and TypeScript procedures can make HTTP calls.
- **Agent worker in TypeScript on Node 22** (`agents/`, ESM, `tsx` to run, `vitest` to test).
- **H3 resolution 9** for neighbor cells (`h3_cell`), resolution 8 for responder briefings.
  Store cells as the H3 hex string (`h3-js` `latLngToCell`).
- **Times** are SpacetimeDB `Timestamp` in the module and ISO strings / `Date` in the worker.
- **IDs**: `u64` auto-increment primary keys unless noted. `client_id` (string, from the phone)
  makes SOS and check-ins idempotent: the reducer ignores a repeat `client_id`.
- **The AI never writes tables directly.** The worker calls reducers, like phones do.
- **No secrets in the repo.** Worker config comes from `agents/.env` (see `.env.example`).

## Tables (module `server/`)

Every table with a location has `h3_cell` so clients can subscribe to their area.

| Table | Columns |
|---|---|
| `person` | `id`, `identity` (Identity, optional), `name`, `age` (u8), `lives_alone` (bool), `mobility` (`ok` / `limited` / `cannot_walk`), `medical_needs` (string, e.g. "oxygen, insulin"), `powered_device` (bool), `has_smartphone` (bool), `language` (string), `phone` (string), `household_id`, `last_lat`, `last_lng` (f64), `h3_cell`, `status` (`unknown` / `safe` / `needs_help`), `priority` (`P1` / `P2` / `P3` / `safe` / `unknown`), `priority_score` (f32), `last_seen` (Timestamp, optional) |
| `household` | `id`, `address`, `lat`, `lng`, `h3_cell`, `has_smart_lock` (bool), `lockbox` (bool) |
| `hex_cell` | `h3_cell` (PK string), `total_people`, `safe`, `needs_help`, `unknown` (u32), `census_elderly_estimate` (u32), `coverage_gap` (bool), `alert_level` (string, empty if none) |
| `safety_net` | `id`, `owner_id`, `member_id`, `ring` (u8: 1 chosen, 2 next block, 3 wider), `skills` (string, comma list: truck, boat, generator, medical) |
| `sos_event` | `id`, `client_id` (unique string), `person_id`, `message`, `lat`, `lng`, `h3_cell`, `channel` (`app` / `sms` / `voice` / `mesh`), `created_at`, `state` (`open` / `assigned` / `resolved` / `escalated`) |
| `check_in` | `id`, `client_id` (unique), `person_id`, `kind` (`app` / `voice` / `sms` / `neighbor_visit` / `mesh`), `result` (`safe` / `needs_help` / `no_answer`), `note`, `created_at` |
| `signal` | `id`, `person_id`, `kind` (`phone_offline` / `power_out` / `low_temp` / `no_motion`), `value` (f64), `created_at` |
| `triage` | `id`, `sos_id` (optional), `person_id`, `urgency` (u8 1-5), `confidence` (f32 0-1), `needs` (`neighbor` / `professional`), `priority` (`P1`/`P2`/`P3`), `reason`, `model`, `created_at` |
| `assignment` | `id`, `sos_id`, `helper_id`, `state` (`offered` / `accepted` / `declined` / `timed_out` / `done`), `offered_at`, `ring` (u8) |
| `key_pass` | `id`, `household_id`, `helper_id`, `sos_id`, `granted_at`, `expires_at`, `revoked` (bool), `approved_by` (string) |
| `incident_report` | `id`, `h3_cell` (res 8), `summary`, `blocked_roads` (string), `p1`, `p2`, `unknown` (u32), `created_at` |
| `agent_step` | `id`, `agent` (`triage` / `dispatch` / `silent_signal` / `reports`), `subject` (e.g. `sos:12`, `person:40`, `cell:88...`), `kind` (`thought` / `tool_call` / `tool_result` / `decision`), `content` (string, short), `confidence` (f32, optional), `created_at`. The map's reasoning panel subscribes to this. |
| `audit_log` | `id`, `actor` (identity string or `agent:<name>`), `action`, `target`, `created_at` |

Scheduled tables (SpacetimeDB scheduled reducers): `assignment_timeout_schedule`,
`key_pass_expiry_schedule`, `recount_schedule`.

### Access (breaking change, security audit)

The database is public on Maincloud, so **every table above except `hex_cell` is private**
(`config` and the new `staff` table too). Clients read through views, which are subscribed like
tables (`SELECT * FROM ops_person`):

| View | Returns |
|---|---|
| `ops_person`, `ops_household`, `ops_safety_net`, `ops_sos_event`, `ops_check_in`, `ops_signal`, `ops_triage`, `ops_assignment`, `ops_key_pass`, `ops_incident_report`, `ops_agent_step`, `ops_audit_log` | Every row of that table for the module owner, the worker and `staff` identities; no rows for anyone else. The worker and the dashboard use these. |
| `my_person`, `my_household`, `my_safety_net` | The caller's own people (`person.identity` = caller), their households and safety nets. |
| `my_sos_event` | SOS events of the caller's people, plus active SOS events one of them was offered or accepted as helper. |
| `my_assignment` | Assignments offered to the caller's people, and assignments on the caller's own SOS events. |
| `my_key_pass` | Key passes held by the caller's people and key passes to the caller's households. |

Views have no client-side indexes: look rows up with `iter()`, not `.id.find()`.
`staff` table: `identity` (PK), `added_at`.

Viewer role (addition, public dashboard): `viewer` table (`identity` PK, `added_at`). A viewer may
read `dash_person` and every `ops_*` view except `ops_person` and `ops_audit_log`, and may call no
reducer (`register_person` refuses viewers, so a viewer never owns people). `dash_person` returns
`person` rows with `phone` blanked and `identity` empty, for staff and viewers; the web dashboard
reads people from it. Owner-only `add_viewer(identity)` / `remove_viewer(identity)`. The viewer's
token ships in the public web bundle (`VITE_SPACETIME_TOKEN`); rotate it by removing the identity.

## Reducers

Who may call what: "self" = the identity that registered the person (`person.identity`),
"staff" = module owner, worker or a `staff` identity. Phones are anonymous identities today, so a
phone can act only for the people it registered.

From phones and channels:
- `register_person(name, age, lives_alone, mobility, medical_needs, powered_device, has_smartphone, language, phone, address, lat, lng)` creates household + person, sets `h3_cell`.
- `set_safety_net(owner_id, members: {member_id, ring, skills}[])` replaces the owner's net.
- `press_sos(client_id, person_id, message, lat, lng, channel)` creates an open `sos_event`, sets person `needs_help`.
- `check_in(client_id, person_id, kind, result, note)` updates person status and `last_seen`.
- `report_signal(person_id, kind, value)`.
- Rules: `register_person` is open (records the caller as `person.identity`; at most 20 people per
  non-staff identity). `set_safety_net`, `press_sos`, `check_in`, `report_signal`: self or staff.
  `press_sos` allows at most 5 active SOS per person for non-staff callers. `client_id` prefixes
  `sms:`, `voice:`, `mesh:` and `mark_safe:` are reserved for staff, and a repeat `client_id`
  for a different person fails instead of being ignored.

From helpers:
- `accept_assignment(assignment_id)`, `decline_assignment(assignment_id)`: the helper's own
  identity or staff.
- `mark_safe(person_id, note)`: self, staff, or a helper whose assignment on one of the person's
  active SOS events is `accepted`. Writes an `audit_log` row.

From the agent worker (only the worker's identity may call these; the module stores it in a
`config` row set by `set_worker_identity`, callable once by the module owner):
- `save_triage(sos_id?, person_id, urgency, confidence, needs, priority, reason, model)`
- `assign_helper(sos_id, helper_id, ring)` creates an `offered` assignment and schedules `assignment_timeout` 10 minutes out.
- `escalate(sos_id, reason)` sets the SOS `escalated`.
- `save_incident_report(h3_cell, summary, blocked_roads, p1, p2, unknown)`
- `log_agent_step(agent, subject, kind, content, confidence?)`
- `set_priority(person_id, priority, priority_score)`
- `set_cell_alert(h3_cell, alert_level)`, `set_cell_census(h3_cell, census_elderly_estimate)`

Key pass (every call writes `audit_log`):
- `grant_key_pass(household_id, helper_id, sos_id, approved_by)` succeeds only if the caller is a
  resident of that household (by identity) or staff (the worker relays a resident's approval),
  `approved_by` is non-empty, the SOS is `open`/`assigned`/`escalated` and belongs to a person in
  that household, and `helper_id` has an `accepted` assignment for that SOS. Expires after 4 hours.
- `revoke_key_pass(key_pass_id)`: a resident, the identity named in `approved_by`, the helper
  holding it, or staff. `log_unlock(key_pass_id)`: only the helper holding it or staff, and fails
  if expired, revoked, or the SOS is no longer active.

Scheduled:
- `assignment_timeout` marks an `offered` assignment `timed_out` after 10 minutes.
- `expire_key_pass` revokes at `expires_at`.
- `recount_cells` refreshes `hex_cell` counts and `coverage_gap` every 30 s.

Module notes (additions from the server branch; no names above changed):
- `config` row (`id` 0): `owner` (publisher identity), `worker` (Identity, optional),
  `assignment_timeout_secs`, `key_pass_ttl_secs`. `set_worker_identity(worker: Identity)`
  (owner only; calling it again replaces the worker, which is how a leaked worker token is rotated).
- Extra owner-only reducers: `set_timing(assignment_timeout_secs, key_pass_ttl_secs)` for demos
  and tests, `add_staff(identity)` / `remove_staff(identity)` for dashboard and dispatcher
  identities, and `recount_now()` (owner or worker).
- Key pass refusals are written to `audit_log` (`grant_key_pass_denied:<reason>`,
  `log_unlock_denied:<reason>`, ...) and the call returns without error, because a thrown error
  would roll back the audit row. Callers check for the `key_pass` row or the audit row.
- Generated TypeScript clients expose the snake_case names camelCase (`h3Cell`, `pressSos`).

## Worker interfaces (`agents/src/`)

Folders, one owner branch each:
- `agents/src/llm/`, `agents/src/agents/`, `agents/src/store/` (worker branch)
- `agents/src/feeds/`, `agents/src/tiger/`, `db/tiger/` (feeds branch)
- `agents/src/messaging/` (messaging branch)
- `sim/` (sim branch)

`agents/src/store/types.ts` defines `FirstLineStore`: one async method per worker reducer above
(camelCase: `saveTriage`, `assignHelper`, ...) plus reads (`getPerson`, `getSafetyNet`,
`listOpenSos`, `listTimedOutAssignments`, `listUnknownPeople`, `getCell`) and an
`onSos` / `onSignal` / `onAssignmentTimeout` subscription API. Branches that need it import the
type and use `InMemoryStore` for tests; the real SpacetimeDB adapter is wired at integration.

Messaging and sim call reducers through the same `FirstLineStore` (`pressSos`, `checkIn`,
`registerPerson`, `setSafetyNet`, `reportSignal`), so the worker branch's `store/types.ts` must
include those too.

## Priority score (plain code, explainable)

`score = vulnerability * exposure * contact_gap_factor`, each part returning a number and a list
of reason strings:
- vulnerability: age 75+, lives alone, powered device or oxygen, limited mobility, no smartphone,
  non-English language, cell SVI/emPOWER prior.
- exposure: weather alert in cell, home temperature trend, power out, distance to shelter/ER.
- contact gap: minutes since last contact, failed attempts.

Categories: `P1` life threat now (from triage), `P2` score over threshold and no contact,
`P3` supplies or ride, `safe`, `unknown`.

## Tiger Data (history)

Hypertables `readings(time, person_id, h3_cell, kind, value)`,
`feed_events(time, source, h3_cell, kind, payload jsonb)`,
`contact_events(time, person_id, h3_cell, channel, result)`. Continuous aggregates `cell_5m`,
`person_last_contact`. SQL tools: `at_risk_now`, `cell_trend(h3_cell, hours)`,
`person_timeline(person_id)`. Connection string in `agents/.env` as `TIGER_DATABASE_URL`.
