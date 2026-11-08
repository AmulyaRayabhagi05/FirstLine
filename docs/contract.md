# Porchlight backend contract

Every backend branch codes against these names. Changing a table, column or reducer name or
argument here is a breaking change: update this file in the same commit and say so in the
commit message. Source of truth for the product: the "Porchlight: Devpost Submission and
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

## Reducers

From phones and channels:
- `register_person(name, age, lives_alone, mobility, medical_needs, powered_device, has_smartphone, language, phone, address, lat, lng)` creates household + person, sets `h3_cell`.
- `set_safety_net(owner_id, members: {member_id, ring, skills}[])` replaces the owner's net.
- `press_sos(client_id, person_id, message, lat, lng, channel)` creates an open `sos_event`, sets person `needs_help`.
- `check_in(client_id, person_id, kind, result, note)` updates person status and `last_seen`.
- `report_signal(person_id, kind, value)`.

From helpers:
- `accept_assignment(assignment_id)`, `decline_assignment(assignment_id)`, `mark_safe(person_id, note)`.

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
- `grant_key_pass(household_id, helper_id, sos_id, approved_by)` succeeds only if that household
  has an `open`/`assigned`/`escalated` SOS and a person approved it (`approved_by` non-empty).
  Expires after 4 hours.
- `revoke_key_pass(key_pass_id)` (owner or approver), `log_unlock(key_pass_id)` fails if expired or revoked.

Scheduled:
- `assignment_timeout` marks an `offered` assignment `timed_out` after 10 minutes.
- `expire_key_pass` revokes at `expires_at`.
- `recount_cells` refreshes `hex_cell` counts and `coverage_gap` every 30 s.

## Worker interfaces (`agents/src/`)

Folders, one owner branch each:
- `agents/src/llm/`, `agents/src/agents/`, `agents/src/store/` (worker branch)
- `agents/src/feeds/`, `agents/src/tiger/`, `db/tiger/` (feeds branch)
- `agents/src/messaging/` (messaging branch)
- `sim/` (sim branch)

`agents/src/store/types.ts` defines `PorchlightStore`: one async method per worker reducer above
(camelCase: `saveTriage`, `assignHelper`, ...) plus reads (`getPerson`, `getSafetyNet`,
`listOpenSos`, `listTimedOutAssignments`, `listUnknownPeople`, `getCell`) and an
`onSos` / `onSignal` / `onAssignmentTimeout` subscription API. Branches that need it import the
type and use `InMemoryStore` for tests; the real SpacetimeDB adapter is wired at integration.

Messaging and sim call reducers through the same `PorchlightStore` (`pressSos`, `checkIn`,
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
