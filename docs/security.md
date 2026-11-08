# Security review

Scope: the SpacetimeDB module (`server/`), the agent worker (`agents/`: reducers it calls,
Twilio SMS/voice webhooks, Meshtastic MQTT bridge, Nemotron agents, Tiger SQL, public feeds), the
sim loaders (`sim/`), the full git history and the npm dependency trees. Branch
`fix/security-audit`, reviewed from `main` at `da94ca6`.

The SpacetimeDB database is published on Maincloud, and anyone can connect to it, call any
public reducer and subscribe to any public table. Phones are anonymous identities; there is no
login yet. The fixes below work within that: a person row records the identity that registered
it, and only that identity, the worker, the module owner or a `staff` identity can act on it.

## Findings

| # | Severity | Issue | Status | Where |
|---|---|---|---|---|
| 1 | Critical | Every table was public: anyone could subscribe to names, ages, medical needs, phone numbers, home addresses and coordinates, SOS texts, triage reasons, key passes and the audit log. `incident_report` and `agent_step` also carry names and SOS text. | Fixed: all tables except `hex_cell` are private. Clients read `ops_*` views (all rows for owner, worker and staff; empty for anyone else) or `my_*` views (only the caller's own people, households, SOS events, assignments, key passes). | `server/src/index.ts` (tables, Views section), `agents/src/store/spacetime.ts` |
| 2 | Critical | `mark_safe` had no caller check: anyone could mark any person safe, resolve their SOS and close the helper's assignment, silencing an emergency. | Fixed: the person's identity, staff, or a helper whose assignment on that person's active SOS is `accepted`. Now audited. | `mark_safe` |
| 3 | Critical | `grant_key_pass` had no caller check and `approved_by` was free text: anyone could issue a home-entry key pass for any household with an active SOS, to a person they registered. | Fixed: caller must be a resident of the household (by identity) or staff, and the helper must have `accepted` that SOS. Refusals are still audited. | `grant_key_pass` |
| 4 | High | `press_sos`, `check_in`, `report_signal` and `set_safety_net` accepted any `person_id` from anyone: fake SOS, false "safe" check-ins, fake sensor signals, or rewiring someone's safety net so offers go to the attacker. | Fixed: person's own identity or staff. | `server/src/index.ts` |
| 5 | High | By SMS or mesh, `FL OK #<id>` from any phone or radio marked person `<id>` safe through the worker identity, bypassing any reducer rule. | Fixed: `FL OK` always checks in the sender's own person (phone number or node map). `#<id>` for someone else only raises an alarm and the SOS text says so. | `agents/src/messaging/inbound.ts` |
| 6 | High | Twilio webhooks skipped signature checks when `TWILIO_AUTH_TOKEN` was unset (standalone `messaging/main.ts`): `POST /voice/result?personId=N` with `Digits=1` marked anyone safe. | Fixed: fails closed (403) without a token unless `TWILIO_ALLOW_UNSIGNED=1` (local dev only). | `agents/src/messaging/twilio.ts`, `server.ts` |
| 7 | High | `log_unlock` had no caller check: anyone could write "helper X unlocked household Y" records into the audit log. | Fixed: only the helper holding the pass or staff, and only while the SOS is active. | `log_unlock` |
| 8 | High | `client_id` idempotency was global: anyone could pre-insert a row with a future channel id (mesh ids are `mesh:<node>:<packet>`, guessable) so the worker's real SOS became a silent no-op. | Fixed: `sms:`, `voice:`, `mesh:`, `mark_safe:` prefixes are reserved for staff; a repeat `client_id` for a different person fails loudly. | `checkClientId`, `press_sos`, `check_in` |
| 9 | High | The worker identity could be set only once, so a leaked worker token meant permanent full control with no way to rotate short of wiping the database. | Fixed: the owner can call `set_worker_identity` again to replace it (audited). | `set_worker_identity` |
| 10 | Medium | `accept_assignment` / `decline_assignment` failed open when the helper row was missing or had no identity. | Fixed: fail closed; staff can still answer. | `requireHelperOrAgent` |
| 11 | Medium | The sim's Tiger loader connected with `rejectUnauthorized: false` (no certificate check). The worker's pool used plaintext for remote hosts without `sslmode`. | Fixed: Tiger Cloud verified against the bundled CA, other remote hosts against system CAs, plaintext only for localhost or explicit `sslmode=disable`. | `sim/src/loaders/tiger.ts`, `agents/src/tiger/client.ts` |
| 12 | Medium | No flood limits: one phone number or mesh node could trigger unlimited SOS events (each costs an LLM run and outbound SMS); one identity could register unlimited people. | Fixed in part: 10 inbound messages per sender per 10 minutes (SMS and mesh); at most 20 people per non-staff identity and 5 active SOS per person. New identities are free to create, so this is a speed bump, not a wall. | `agents/src/messaging/ratelimit.ts`, `register_person`, `press_sos` |
| 13 | Medium | Prompt injection: SOS text, names and notes go into agent prompts. Tools were already allowlisted per agent and `assign_helper` only accepts ranked candidates, but `request_visit` let the model text any registered phone. | Fixed: public text is wrapped in `<<public>>` blocks the system prompt says never to obey; `request_visit` only routes to the person's own safety net. Tests script a compromised model. | `agents/src/agents/*.ts`, `injection.test.ts` |
| 14 | Medium | Personal data in logs: the mesh bridge logged every message text; the comms stub logged SMS bodies and visit reasons (names, health details). | Fixed: logs show sender and length; `COMMS_LOG_TEXT=1` shows stub bodies for a local demo. | `meshtastic-bridge.ts`, `runtime/services.ts` |
| 15 | Low | Webhook server: oversized bodies returned 500, no request timeouts, very long SMS text made the reducer throw (500, Twilio retries). | Fixed: 413 over 64 KB, 10 s header / 15 s request timeouts, text clipped to 1000 characters. | `agents/src/messaging/server.ts`, `inbound.ts` |
| 16 | Low | Mesh positions from any MQTT publisher were stored unvalidated in an unbounded map. | Fixed: range-checked, map bounded. | `meshtastic-bridge.ts` |
| 17 | Low | The NWS forecast feed followed a URL taken from an API response. | Fixed: only `https://api.weather.gov` links are followed. | `agents/src/feeds/nwsForecast.ts` |
| 18 | Low | `.gitignore` did not cover key stores, SSH keys, credential JSON, `.npmrc`, `*.token`. | Fixed. | `.gitignore` |
| 19 | Info | Secrets in git history: none found (all 40 commits, all branches). Only the local Docker Timescale passwords used in docs and tests (`localhost:55432`) and fake `555` phone numbers. `agents/.env` and `.spacetime-token` were never committed. | No action | `git log -p --all` |
| 20 | Info | SQL injection: every Tiger query is parameterized (`$1`, `unnest($n::type[])`); the sim's batch insert interpolates only constant table/column names. | No issue | `agents/src/tiger/`, `sim/src/loaders/tiger.ts` |
| 21 | Info | TwiML injection: replies and spoken names go through the `twilio` TwiML builders (escaped); the retry fragment uses constant text plus `xmlEscape`. | No issue | `agents/src/messaging/voice.ts` |
| 22 | Info | `npm audit`: 0 vulnerabilities in `agents/`, `server/` and `sim/`. | No action | |

## Still open, and why

- **The public dashboard can read everyone's name, age, address, medical needs, SOS text and the
  agents' reasoning.** It runs as a read-only `viewer` identity whose token is in the public JS
  bundle, by choice for the demo. Phone numbers and identities are blanked (`dash_person`) and the
  audit log stays staff-only; viewers cannot call any reducer. Before real residents use the
  Maincloud database, put the site behind a login or drop the viewer and use staff grants.

- **Phones are anonymous.** Anyone can create identities, register people with any phone number
  and address, and get the worker to call or text that number (silent-signal checks, helper
  offers). Phone ownership is never verified. Fix: verify the phone by SMS code before a person
  becomes callable, and move phones to a real login (SpacetimeDB OIDC / `spacetimeauth`).
- **Losing a phone's token loses access** to the people it registered. Staff can still act for
  them. Needs account recovery once there is a login.
- **Safety-net members do not consent.** An owner can add any person id as a helper; that person
  gets SMS offers with the requester's name and message. Fix: an invite/accept step.
- **Mesh sender spoofing.** Meshtastic `from` is not authenticated over MQTT, so anyone who can
  publish to the broker can pose as a mapped radio (including `FL OK` for that radio's person).
  Rate limits cap the volume only. Run a private broker with credentials and an encrypted channel
  (PSK); never bridge the public `msh/US` broker.
- **SOS for someone else (`FL SOS #<id>`, voice, mesh) is allowed by design** so neighbors and
  shared phones can raise the alarm. It is labeled and rate-limited; false alarms are possible.
- **Prompt injection is mitigated, not solved.** A message can still talk the model into a lower
  priority or an odd decision for that SOS. The bounds that hold regardless: per-agent tool
  allowlists, candidate-only `assign_helper`, the triage safety floor (life-threat keywords force
  P1), dispatch guards (escalate on P1, always offer a helper), and reducer rules. No agent has a
  tool for key passes or `mark_safe`.
- **Audit-log growth.** Refused key-pass calls are written to `audit_log` on purpose (they are
  security events), so an anonymous caller can grow that table. Low impact; a per-identity cap or
  periodic pruning would close it.
- **`hex_cell` is public.** It holds counts per res-9 cell. A cell with one registered person
  reveals that person's status. A minimum-count threshold before publishing counts would fix it.
- **Staff identities see everything.** Dashboard tokens must be protected like passwords.
- **Not security, found during the review:** `FL SOS` from an unregistered number calls
  `press_sos` with `person_id = 0`, which the module rejects (person 0 does not exist), so that
  SOS is lost after Twilio's retries. The module needs an "unknown person" path.

## Deploy steps after this branch

1. Publish the module over the existing database (automatic migration, data kept; tested
   locally from `main` with data in place):
   `spacetime publish firstline --server maincloud --module-path server --yes`
   Do not add `--delete-data`.
2. Restart the worker with this branch. Old worker code subscribes to `person` etc., which are now
   private, and will fail to subscribe. The worker must be the configured worker identity, or its
   `ops_*` views stay empty.
3. Any dashboard or other reader: subscribe to `ops_*` / `my_*` views, regenerate bindings, and
   have the owner run `add_staff` for the dashboard's identity.
4. Assume everything already in the Maincloud `firstline` database was readable by anyone while
   the tables were public. If it ever held real people's data, treat it as disclosed.

## Operator guidance

Rotating keys (do this if a key may have leaked, and once after any data exposure):

- **Nemotron API key**: on the Brev instance, replace `~/nemotron.key`
  (`openssl rand -hex 32 > ~/nemotron.key`), restart vLLM, update everyone's `agents/.env`.
- **Twilio**: create a secondary auth token in the Twilio console, update `TWILIO_AUTH_TOKEN`,
  restart the worker, then promote it (this retires the old one).
- **Tiger Data**: reset the service password in the Tiger console and update
  `TIGER_DATABASE_URL`.
- **SpacetimeDB worker token**: stop the worker, delete `agents/.spacetime-token`, start it
  (a new identity is created and printed), then as the owner:
  `spacetime call --server maincloud firstline set_worker_identity '"0x<new identity>"'`.
  The old identity loses worker rights immediately.
- **Staff identities**: `remove_staff` for any dashboard token that may have leaked.
- **Census key, MQTT credentials**: regenerate at the provider and update `agents/.env`.

Keeping the repo free of secrets:

- Secrets live only in `agents/.env` (git-ignored); `agents/.env.example` keeps empty values.
- Never put real keys, tokens, connection strings or phone numbers in docs, tests or commit
  messages. Tests use fake values (`test_auth_token_not_real`, `555` numbers, localhost DBs).
- Before pushing: `git diff --cached` and, ideally, `gitleaks protect --staged` as a pre-commit
  hook. On GitHub, turn on secret scanning and push protection for the public repo.
- If a secret is ever committed, rotate it first; rewriting history does not un-leak a pushed key.
- Deployments: always set `TWILIO_AUTH_TOKEN` and `PUBLIC_BASE_URL`; never set
  `TWILIO_ALLOW_UNSIGNED`; keep `COMMS_LOG_TEXT` unset.

## Retention

Opt-in only: residents register themselves (or a neighbor registers them with consent). Phones,
addresses and health details are readable only by staff and the worker; the public viewer sees
no phone numbers or identities. After the event the owner runs

    spacetime call --server maincloud firstline purge_event -- '"DELETE EVENT DATA"' true

which deletes everything recorded about the event and, with `true`, the residents themselves.
