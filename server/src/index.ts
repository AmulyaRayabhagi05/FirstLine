// FirstLine SpacetimeDB module. Names follow docs/contract.md exactly.
import {
  schema,
  table,
  t,
  SenderError,
  CaseConversionPolicy,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';
import { ScheduleAt, Timestamp, type Identity, type Infer } from 'spacetimedb';
import './textdecoder_shim';
import { latLngToCell } from 'h3-js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const H3_RES = 9;
const DEFAULT_ASSIGNMENT_TIMEOUT_SECS = 10 * 60;
const DEFAULT_KEY_PASS_TTL_SECS = 4 * 60 * 60;
const RECOUNT_INTERVAL_MICROS = 30_000_000n;
// coverage_gap: census says many elderly live here but few people are registered.
const GAP_MIN_CENSUS = 10;
const GAP_RATIO = 0.25; // registered < 25% of census estimate
const MAX_TEXT = 2000;

const MOBILITY = ['ok', 'limited', 'cannot_walk'];
const PERSON_STATUS = ['unknown', 'safe', 'needs_help'];
const PERSON_PRIORITY = ['P1', 'P2', 'P3', 'safe', 'unknown'];
const SOS_CHANNEL = ['app', 'sms', 'voice', 'mesh'];
const CHECK_IN_KIND = ['app', 'voice', 'sms', 'neighbor_visit', 'mesh'];
const ACTION_KIND = ['respond', 'call', 'escalate', 'send_neighbor', 'claim_timeline'];
const ACTION_STATE = ['done', 'failed'];
const CHECK_IN_RESULT = ['safe', 'needs_help', 'no_answer'];
const SIGNAL_KIND = ['phone_offline', 'power_out', 'low_temp', 'no_motion', 'geofence_entered'];
const TRIAGE_NEEDS = ['neighbor', 'professional'];
const TRIAGE_PRIORITY = ['P1', 'P2', 'P3'];
const AGENTS = ['triage', 'dispatch', 'silent_signal', 'reports'];
const STEP_KIND = ['thought', 'tool_call', 'tool_result', 'decision'];
const SKILLS = ['truck', 'boat', 'generator', 'medical'];
const ACTIVE_SOS = ['open', 'assigned', 'escalated'];

// ---------------------------------------------------------------------------
// Tables
//
// Access: every table except hex_cell (aggregate counts only) is PRIVATE. The database is
// public on Maincloud, so any client could otherwise subscribe to names, ages, medical needs,
// phone numbers, home addresses, SOS texts and key passes. Clients read through views instead
// (see "Views" below): ops_* views return everything to the owner, the worker and staff
// identities (empty for anyone else); my_* views return only the caller's own rows.
// ---------------------------------------------------------------------------

const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(), // always 0
    owner: t.identity(), // identity that published the module (init sender)
    worker: t.option(t.identity()), // agent worker identity (owner can replace it to rotate)
    assignment_timeout_secs: t.u32(),
    key_pass_ttl_secs: t.u32(),
  }
);

/** Operator identities (dashboards, dispatchers) that may read ops_* views and act for anyone. */
const staff = table(
  { name: 'staff' },
  {
    identity: t.identity().primaryKey(),
    added_at: t.timestamp(),
  }
);

/** Read-only identities (the public dashboard): may read the dashboard views, may call nothing. */
const viewer = table(
  { name: 'viewer' },
  {
    identity: t.identity().primaryKey(),
    added_at: t.timestamp(),
  }
);

const person = table(
  { name: 'person' },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.option(t.identity()),
    name: t.string(),
    age: t.u8(),
    lives_alone: t.bool(),
    mobility: t.string(),
    medical_needs: t.string(),
    powered_device: t.bool(),
    has_smartphone: t.bool(),
    language: t.string(),
    phone: t.string(),
    household_id: t.u64().index('btree'),
    last_lat: t.f64(),
    last_lng: t.f64(),
    h3_cell: t.string().index('btree'),
    status: t.string(),
    priority: t.string(),
    priority_score: t.f32(),
    last_seen: t.option(t.timestamp()),
  }
);

const household = table(
  { name: 'household' },
  {
    id: t.u64().primaryKey().autoInc(),
    address: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    h3_cell: t.string().index('btree'),
    has_smart_lock: t.bool(),
    lockbox: t.bool(),
  }
);

const hex_cell = table(
  { name: 'hex_cell', public: true },
  {
    h3_cell: t.string().primaryKey(),
    total_people: t.u32(),
    safe: t.u32(),
    needs_help: t.u32(),
    unknown: t.u32(),
    census_elderly_estimate: t.u32(),
    coverage_gap: t.bool(),
    alert_level: t.string(),
  }
);

const safety_net = table(
  { name: 'safety_net' },
  {
    id: t.u64().primaryKey().autoInc(),
    owner_id: t.u64().index('btree'),
    member_id: t.u64().index('btree'),
    ring: t.u8(),
    skills: t.string(),
  }
);

const sos_event = table(
  { name: 'sos_event' },
  {
    id: t.u64().primaryKey().autoInc(),
    client_id: t.string().unique(),
    person_id: t.u64().index('btree'),
    message: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    h3_cell: t.string().index('btree'),
    channel: t.string(),
    created_at: t.timestamp(),
    state: t.string(),
  }
);

const check_in_table = table(
  { name: 'check_in' },
  {
    id: t.u64().primaryKey().autoInc(),
    client_id: t.string().unique(),
    person_id: t.u64().index('btree'),
    kind: t.string(),
    result: t.string(),
    note: t.string(),
    created_at: t.timestamp(),
  }
);

const signal = table(
  { name: 'signal' },
  {
    id: t.u64().primaryKey().autoInc(),
    person_id: t.u64().index('btree'),
    kind: t.string(),
    value: t.f64(),
    created_at: t.timestamp(),
  }
);

const triage = table(
  { name: 'triage' },
  {
    id: t.u64().primaryKey().autoInc(),
    sos_id: t.option(t.u64()),
    person_id: t.u64().index('btree'),
    urgency: t.u8(),
    confidence: t.f32(),
    needs: t.string(),
    priority: t.string(),
    reason: t.string(),
    model: t.string(),
    created_at: t.timestamp(),
  }
);

const assignment = table(
  { name: 'assignment' },
  {
    id: t.u64().primaryKey().autoInc(),
    sos_id: t.u64().index('btree'),
    helper_id: t.u64().index('btree'),
    state: t.string(),
    offered_at: t.timestamp(),
    ring: t.u8(),
  }
);

const key_pass = table(
  { name: 'key_pass' },
  {
    id: t.u64().primaryKey().autoInc(),
    household_id: t.u64().index('btree'),
    helper_id: t.u64(),
    sos_id: t.u64(),
    granted_at: t.timestamp(),
    expires_at: t.timestamp(),
    revoked: t.bool(),
    approved_by: t.string(),
  }
);

const incident_report = table(
  { name: 'incident_report' },
  {
    id: t.u64().primaryKey().autoInc(),
    h3_cell: t.string().index('btree'),
    summary: t.string(),
    blocked_roads: t.string(),
    p1: t.u32(),
    p2: t.u32(),
    unknown: t.u32(),
    created_at: t.timestamp(),
  }
);

const agent_step = table(
  { name: 'agent_step' },
  {
    id: t.u64().primaryKey().autoInc(),
    agent: t.string(),
    subject: t.string().index('btree'),
    kind: t.string(),
    content: t.string(),
    confidence: t.option(t.f32()),
    created_at: t.timestamp(),
  }
);

const audit_log = table(
  { name: 'audit_log' },
  {
    id: t.u64().primaryKey().autoInc(),
    actor: t.string(),
    action: t.string(),
    target: t.string(),
    created_at: t.timestamp(),
  }
);

// A staff request from the dashboard card (call, escalate, send a neighbor, claim timeline, or
// "let Nemotron decide"). The worker picks it up, runs the agents and writes back the outcome.
const action_request = table(
  { name: 'action_request' },
  {
    id: t.u64().primaryKey().autoInc(),
    person_id: t.u64().index('btree'),
    action: t.string(),
    note: t.string(),
    requested_by: t.string(),
    created_at: t.timestamp(),
    state: t.string(), // pending | done | failed
    result: t.string(),
  }
);

// Scheduled tables
const assignment_timeout_schedule = table(
  { name: 'assignment_timeout_schedule' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    assignment_id: t.u64(),
  }
);

const key_pass_expiry_schedule = table(
  { name: 'key_pass_expiry_schedule' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    key_pass_id: t.u64(),
  }
);

const recount_schedule = table(
  { name: 'recount_schedule' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

const spacetimedb = schema(
  {
  config,
  staff,
  viewer,
  person,
  household,
  hex_cell,
  safety_net,
  sos_event,
  check_in: check_in_table,
  signal,
  triage,
  assignment,
  key_pass,
  incident_report,
  agent_step,
  audit_log,
  action_request,
  assignment_timeout_schedule,
  key_pass_expiry_schedule,
  recount_schedule,
  },
  // Names in docs/contract.md are already snake_case; keep them verbatim (the default
  // SnakeCase policy would turn h3_cell into h_3_cell and p1 into p_1).
  { CASE_CONVERSION_POLICY: CaseConversionPolicy.None }
);
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ---------------------------------------------------------------------------
// Helpers (not exported)
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new SenderError(msg);
}

function oneOf(field: string, value: string, allowed: string[]): void {
  if (!allowed.includes(value)) {
    fail(`${field} must be one of ${allowed.join(', ')} (got "${value}")`);
  }
}

function text(field: string, value: string, max = MAX_TEXT): string {
  if (value.length > max) fail(`${field} is longer than ${max} characters`);
  return value;
}

function cellFor(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) fail(`lat out of range: ${lat}`);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) fail(`lng out of range: ${lng}`);
  return latLngToCell(lat, lng, H3_RES);
}

function addSecs(ts: Timestamp, secs: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(secs) * 1_000_000n);
}

function getConfig(ctx: Ctx) {
  const c = ctx.db.config.id.find(0);
  if (!c) fail('module not initialised (config row missing)');
  return c;
}

function isWorker(ctx: Ctx): boolean {
  const c = ctx.db.config.id.find(0);
  return !!c && c.worker !== undefined && c.worker.isEqual(ctx.sender);
}

function isOwner(ctx: Ctx): boolean {
  const c = ctx.db.config.id.find(0);
  return !!c && c.owner.isEqual(ctx.sender);
}

function requireWorker(ctx: Ctx): void {
  if (!isWorker(ctx)) fail('only the agent worker identity may call this reducer');
}

/** Read-only surface shared by reducers and views (views have no timestamp or writes). */
type Reader = {
  sender: Identity;
  db: {
    config: { id: { find(id: number): { owner: Identity; worker: Identity | undefined } | null | undefined } };
    staff: { identity: { find(identity: Identity): unknown } };
    viewer: { identity: { find(identity: Identity): unknown } };
  };
};

/** Owner, worker or a staff identity: may read ops_* views and act for any person. */
function isStaff(ctx: Reader): boolean {
  const c = ctx.db.config.id.find(0);
  if (!c) return false;
  if (c.owner.isEqual(ctx.sender)) return true;
  if (c.worker !== undefined && c.worker.isEqual(ctx.sender)) return true;
  return !!ctx.db.staff.identity.find(ctx.sender);
}

/** A read-only viewer identity (the public dashboard). */
function isViewer(ctx: Reader): boolean {
  return !!ctx.db.viewer.identity.find(ctx.sender);
}

/** Staff or viewer: may read the dashboard views (everything but ops_person and ops_audit_log). */
function canRead(ctx: Reader): boolean {
  return isStaff(ctx) || isViewer(ctx);
}

/** True when the caller registered this person (phones are anonymous identities today). */
function isSelf(ctx: { sender: Identity }, p: { identity: Identity | undefined }): boolean {
  return p.identity !== undefined && p.identity.isEqual(ctx.sender);
}

/** The person's own identity, or owner / worker / staff. */
function canActFor(ctx: Ctx, p: { identity: Identity | undefined }): boolean {
  return isSelf(ctx, p) || isStaff(ctx);
}

function requireActFor(ctx: Ctx, p: { id: bigint; identity: Identity | undefined }, what: string): void {
  if (!canActFor(ctx, p)) fail(`not allowed: only person ${p.id}'s own identity or staff may ${what}`);
}

// client_id prefixes the worker's channels use (sms:<MessageSid>, voice:<CallSid>, mesh:<node>:<id>)
// and mark_safe's own rows. Other callers may not use them, so nobody can pre-claim the
// client_id of a future SMS/voice/mesh SOS and make the worker's call a silent no-op.
const RESERVED_CLIENT_ID = /^(sms|voice|mesh|mark_safe):/i;

function checkClientId(ctx: Ctx, clientId: string): void {
  if (!clientId) fail('client_id is required');
  text('client_id', clientId, 200);
  if (RESERVED_CLIENT_ID.test(clientId) && !isStaff(ctx)) {
    fail('client_id prefixes sms:, voice:, mesh: and mark_safe: are reserved for the worker');
  }
}

// Anti-flooding limits for non-staff identities (the worker, sim and staff are exempt).
const MAX_PEOPLE_PER_IDENTITY = 20;
const MAX_ACTIVE_SOS_PER_PERSON = 5;

function requireScheduler(ctx: Ctx): void {
  // Scheduled reducers run as the database itself; block direct client calls.
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) fail('scheduled reducer: not callable by clients');
}

function actorOf(ctx: Ctx): string {
  if (isWorker(ctx)) return 'agent:worker';
  if (ctx.sender.isEqual(ctx.databaseIdentity)) return 'agent:scheduler';
  return ctx.sender.toHexString();
}

function audit(ctx: Ctx, action: string, target: string): void {
  ctx.db.audit_log.insert({
    id: 0n,
    actor: actorOf(ctx),
    action,
    target,
    created_at: ctx.timestamp,
  });
}

function getPerson(ctx: Ctx, id: bigint) {
  const p = ctx.db.person.id.find(id);
  if (!p) fail(`person ${id} not found`);
  return p;
}

function getSos(ctx: Ctx, id: bigint) {
  const s = ctx.db.sos_event.id.find(id);
  if (!s) fail(`sos ${id} not found`);
  return s;
}

function upsertCell(ctx: Ctx, h3: string, patch: { alert_level?: string; census_elderly_estimate?: number }) {
  const existing = ctx.db.hex_cell.h3_cell.find(h3);
  if (existing) {
    const next = { ...existing, ...patch };
    next.coverage_gap = gapFor(next.census_elderly_estimate, next.total_people);
    ctx.db.hex_cell.h3_cell.update(next);
  } else {
    const census = patch.census_elderly_estimate ?? 0;
    ctx.db.hex_cell.insert({
      h3_cell: h3,
      total_people: 0,
      safe: 0,
      needs_help: 0,
      unknown: 0,
      census_elderly_estimate: census,
      coverage_gap: gapFor(census, 0),
      alert_level: patch.alert_level ?? '',
    });
  }
}

function gapFor(census: number, total: number): boolean {
  return census >= GAP_MIN_CENSUS && total < census * GAP_RATIO;
}

function recount(ctx: Ctx): void {
  const counts = new Map<string, { total: number; safe: number; needs: number; unknown: number }>();
  for (const p of ctx.db.person.iter()) {
    let c = counts.get(p.h3_cell);
    if (!c) {
      c = { total: 0, safe: 0, needs: 0, unknown: 0 };
      counts.set(p.h3_cell, c);
    }
    c.total++;
    if (p.status === 'safe') c.safe++;
    else if (p.status === 'needs_help') c.needs++;
    else c.unknown++;
  }
  // Update existing cells (including ones that now have nobody).
  for (const cell of [...ctx.db.hex_cell.iter()]) {
    const c = counts.get(cell.h3_cell) ?? { total: 0, safe: 0, needs: 0, unknown: 0 };
    counts.delete(cell.h3_cell);
    const next = {
      ...cell,
      total_people: c.total,
      safe: c.safe,
      needs_help: c.needs,
      unknown: c.unknown,
      coverage_gap: gapFor(cell.census_elderly_estimate, c.total),
    };
    if (
      next.total_people !== cell.total_people ||
      next.safe !== cell.safe ||
      next.needs_help !== cell.needs_help ||
      next.unknown !== cell.unknown ||
      next.coverage_gap !== cell.coverage_gap
    ) {
      ctx.db.hex_cell.h3_cell.update(next);
    }
  }
  // Insert cells seen for the first time.
  for (const [h3, c] of counts) {
    ctx.db.hex_cell.insert({
      h3_cell: h3,
      total_people: c.total,
      safe: c.safe,
      needs_help: c.needs,
      unknown: c.unknown,
      census_elderly_estimate: 0,
      coverage_gap: false,
      alert_level: '',
    });
  }
}

function parseSkills(skills: string): string {
  const parts = skills
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
  for (const s of parts) oneOf('skill', s, SKILLS);
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const init = spacetimedb.init(ctx => {
  ctx.db.config.insert({
    id: 0,
    owner: ctx.sender,
    worker: undefined,
    assignment_timeout_secs: DEFAULT_ASSIGNMENT_TIMEOUT_SECS,
    key_pass_ttl_secs: DEFAULT_KEY_PASS_TTL_SECS,
  });
  ctx.db.recount_schedule.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(RECOUNT_INTERVAL_MICROS),
  });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * Module owner sets the agent worker's identity. Calling it again replaces the worker, which is
 * how a leaked worker token is rotated (connect a new worker, then point the module at it).
 */
export const set_worker_identity = spacetimedb.reducer(
  { worker: t.identity() },
  (ctx, { worker }) => {
    const c = getConfig(ctx);
    if (!c.owner.isEqual(ctx.sender)) fail('only the module owner may set the worker identity');
    const previous = c.worker?.toHexString() ?? 'none';
    ctx.db.config.id.update({ ...c, worker });
    audit(ctx, 'set_worker_identity', `${worker.toHexString()} (was ${previous})`);
  }
);

/** Owner-only: let an operator identity (dashboard, dispatcher) read ops_* views and act. */
export const add_staff = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    if (!isOwner(ctx)) fail('only the module owner may add staff');
    if (ctx.db.staff.identity.find(identity)) return;
    ctx.db.staff.insert({ identity, added_at: ctx.timestamp });
    audit(ctx, 'add_staff', identity.toHexString());
  }
);

/** Owner-only: remove an operator identity. */
export const remove_staff = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    if (!isOwner(ctx)) fail('only the module owner may remove staff');
    if (ctx.db.staff.identity.delete(identity)) audit(ctx, 'remove_staff', identity.toHexString());
  }
);

/** Owner-only: let a read-only identity (the public dashboard) read the dashboard views. */
export const add_viewer = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    if (!isOwner(ctx)) fail('only the module owner may add viewers');
    if (ctx.db.viewer.identity.find(identity)) return;
    ctx.db.viewer.insert({ identity, added_at: ctx.timestamp });
    audit(ctx, 'add_viewer', identity.toHexString());
  }
);

/** Owner-only: remove a viewer identity (rotate a leaked or retired dashboard token). */
export const remove_viewer = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    if (!isOwner(ctx)) fail('only the module owner may remove viewers');
    if (ctx.db.viewer.identity.delete(identity)) audit(ctx, 'remove_viewer', identity.toHexString());
  }
);

/** Owner-only: shorten timers for demos and tests. 0 keeps the current value. */
export const set_timing = spacetimedb.reducer(
  { assignment_timeout_secs: t.u32(), key_pass_ttl_secs: t.u32() },
  (ctx, { assignment_timeout_secs, key_pass_ttl_secs }) => {
    const c = getConfig(ctx);
    if (!c.owner.isEqual(ctx.sender)) fail('only the module owner may change timing');
    ctx.db.config.id.update({
      ...c,
      assignment_timeout_secs: assignment_timeout_secs || c.assignment_timeout_secs,
      key_pass_ttl_secs: key_pass_ttl_secs || c.key_pass_ttl_secs,
    });
  }
);

/** Owner or worker: recount hex cells immediately (the 30 s timer does this too). */
// After the event: delete what the night recorded about people. Owner only, and the confirm
// phrase must match so nobody wipes a live event by accident. With include_people the residents,
// households and safety nets go too (nothing personal is left); without it they stay registered
// and are reset to "unknown" for the next event. The audit log keeps one row saying it happened.
const PURGE_PHRASE = 'DELETE EVENT DATA';

export const purge_event = spacetimedb.reducer(
  { confirm: t.string(), include_people: t.bool() },
  (ctx, { confirm, include_people }) => {
    if (!isOwner(ctx)) fail('only the database owner may delete event data');
    if (confirm !== PURGE_PHRASE) fail(`confirm must be exactly "${PURGE_PHRASE}"`);
    let n = 0;
    for (const r of [...ctx.db.assignment_timeout_schedule.iter()]) ctx.db.assignment_timeout_schedule.scheduled_id.delete(r.scheduled_id);
    for (const r of [...ctx.db.key_pass_expiry_schedule.iter()]) ctx.db.key_pass_expiry_schedule.scheduled_id.delete(r.scheduled_id);
    for (const r of [...ctx.db.sos_event.iter()]) { ctx.db.sos_event.id.delete(r.id); n++; }
    for (const r of [...ctx.db.check_in.iter()]) { ctx.db.check_in.id.delete(r.id); n++; }
    for (const r of [...ctx.db.signal.iter()]) { ctx.db.signal.id.delete(r.id); n++; }
    for (const r of [...ctx.db.triage.iter()]) { ctx.db.triage.id.delete(r.id); n++; }
    for (const r of [...ctx.db.assignment.iter()]) { ctx.db.assignment.id.delete(r.id); n++; }
    for (const r of [...ctx.db.key_pass.iter()]) { ctx.db.key_pass.id.delete(r.id); n++; }
    for (const r of [...ctx.db.incident_report.iter()]) { ctx.db.incident_report.id.delete(r.id); n++; }
    for (const r of [...ctx.db.agent_step.iter()]) { ctx.db.agent_step.id.delete(r.id); n++; }
    for (const r of [...ctx.db.action_request.iter()]) { ctx.db.action_request.id.delete(r.id); n++; }
    if (include_people) {
      for (const r of [...ctx.db.safety_net.iter()]) { ctx.db.safety_net.id.delete(r.id); n++; }
      for (const r of [...ctx.db.person.iter()]) { ctx.db.person.id.delete(r.id); n++; }
      for (const r of [...ctx.db.household.iter()]) { ctx.db.household.id.delete(r.id); n++; }
    } else {
      for (const p of [...ctx.db.person.iter()]) {
        ctx.db.person.id.update({ ...p, status: 'unknown', priority: 'unknown', priority_score: 0, last_seen: undefined });
      }
    }
    for (const c of [...ctx.db.hex_cell.iter()]) ctx.db.hex_cell.h3_cell.update({ ...c, alert_level: '' });
    audit(ctx, 'purge_event', `${n} rows deleted${include_people ? ', people included' : ''}`);
  }
);

// Keep the live dashboards light: drop all but the newest agent steps and incident reports.
// (Every client subscribes to these; an unbounded log makes every page load slower.)
export const trim_history = spacetimedb.reducer(
  { keep_steps: t.u32(), keep_reports: t.u32() },
  (ctx, { keep_steps, keep_reports }) => {
    if (!isOwner(ctx) && !isWorker(ctx)) fail('only the owner or worker may trim history');
    if (keep_steps < 500 || keep_reports < 50) fail('keep at least 500 steps and 50 reports');
    const steps = [...ctx.db.agent_step.iter()];
    if (steps.length > keep_steps) {
      steps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const r of steps.slice(0, steps.length - keep_steps)) ctx.db.agent_step.id.delete(r.id);
    }
    const reports = [...ctx.db.incident_report.iter()];
    if (reports.length > keep_reports) {
      reports.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const r of reports.slice(0, reports.length - keep_reports)) ctx.db.incident_report.id.delete(r.id);
    }
  }
);

export const recount_now = spacetimedb.reducer(ctx => {
  if (!isOwner(ctx) && !isWorker(ctx)) fail('only the owner or worker may force a recount');
  recount(ctx);
});

// ---------------------------------------------------------------------------
// From phones and channels
// ---------------------------------------------------------------------------

export const register_person = spacetimedb.reducer(
  {
    name: t.string(),
    age: t.u8(),
    lives_alone: t.bool(),
    mobility: t.string(),
    medical_needs: t.string(),
    powered_device: t.bool(),
    has_smartphone: t.bool(),
    language: t.string(),
    phone: t.string(),
    address: t.string(),
    lat: t.f64(),
    lng: t.f64(),
  },
  (ctx, a) => {
    const name = a.name.trim();
    if (!name) fail('name is required');
    text('name', name, 200);
    if (a.age > 120) fail('age must be 0-120');
    oneOf('mobility', a.mobility, MOBILITY);
    text('medical_needs', a.medical_needs, 500);
    text('address', a.address, 500);
    text('phone', a.phone, 40);
    text('language', a.language, 20);
    const h3 = cellFor(a.lat, a.lng);
    // The viewer token ships in the public dashboard, so it must never own people (owning them
    // would let anyone with the token act for them).
    if (isViewer(ctx)) fail('viewer identities are read-only');
    if (!isStaff(ctx)) {
      let mine = 0;
      for (const p of ctx.db.person.iter()) if (isSelf(ctx, p)) mine++;
      if (mine >= MAX_PEOPLE_PER_IDENTITY) {
        fail(`one identity may register at most ${MAX_PEOPLE_PER_IDENTITY} people`);
      }
    }
    const hh = ctx.db.household.insert({
      id: 0n,
      address: a.address,
      lat: a.lat,
      lng: a.lng,
      h3_cell: h3,
      has_smart_lock: false,
      lockbox: false,
    });
    ctx.db.person.insert({
      id: 0n,
      identity: ctx.sender,
      name,
      age: a.age,
      lives_alone: a.lives_alone,
      mobility: a.mobility,
      medical_needs: a.medical_needs,
      powered_device: a.powered_device,
      has_smartphone: a.has_smartphone,
      language: a.language.trim() || 'en',
      phone: a.phone,
      household_id: hh.id,
      last_lat: a.lat,
      last_lng: a.lng,
      h3_cell: h3,
      status: 'unknown',
      priority: 'unknown',
      priority_score: 0,
      last_seen: ctx.timestamp,
    });
  }
);

const NetMember = t.object('NetMember', {
  member_id: t.u64(),
  ring: t.u8(),
  skills: t.string(),
});

export const set_safety_net = spacetimedb.reducer(
  { owner_id: t.u64(), members: t.array(NetMember) },
  (ctx, { owner_id, members }) => {
    requireActFor(ctx, getPerson(ctx, owner_id), 'change their safety net');
    if (members.length > 50) fail('a safety net can have at most 50 members');
    const seen = new Set<bigint>();
    const rows = members.map(m => {
      if (m.member_id === owner_id) fail('a person cannot be in their own safety net');
      if (seen.has(m.member_id)) fail(`member ${m.member_id} listed twice`);
      seen.add(m.member_id);
      getPerson(ctx, m.member_id);
      if (m.ring < 1 || m.ring > 3) fail('ring must be 1, 2 or 3');
      return { member_id: m.member_id, ring: m.ring, skills: parseSkills(m.skills) };
    });
    for (const row of [...ctx.db.safety_net.owner_id.filter(owner_id)]) {
      ctx.db.safety_net.id.delete(row.id);
    }
    for (const r of rows) {
      ctx.db.safety_net.insert({ id: 0n, owner_id, ...r });
    }
  }
);

export const press_sos = spacetimedb.reducer(
  {
    client_id: t.string(),
    person_id: t.u64(),
    message: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    channel: t.string(),
  },
  (ctx, a) => {
    checkClientId(ctx, a.client_id);
    const prior = ctx.db.sos_event.client_id.find(a.client_id);
    if (prior) {
      if (prior.person_id !== a.person_id) fail('client_id was already used for another person');
      return; // idempotent repeat
    }
    oneOf('channel', a.channel, SOS_CHANNEL);
    text('message', a.message);
    const p = getPerson(ctx, a.person_id);
    requireActFor(ctx, p, 'send an SOS for them');
    if (!isStaff(ctx)) {
      let active = 0;
      for (const s of ctx.db.sos_event.person_id.filter(a.person_id)) if (ACTIVE_SOS.includes(s.state)) active++;
      if (active >= MAX_ACTIVE_SOS_PER_PERSON) fail(`person already has ${active} active SOS events`);
    }
    const h3 = cellFor(a.lat, a.lng);
    ctx.db.sos_event.insert({
      id: 0n,
      client_id: a.client_id,
      person_id: a.person_id,
      message: a.message,
      lat: a.lat,
      lng: a.lng,
      h3_cell: h3,
      channel: a.channel,
      created_at: ctx.timestamp,
      state: 'open',
    });
    ctx.db.person.id.update({
      ...p,
      status: 'needs_help',
      last_lat: a.lat,
      last_lng: a.lng,
      h3_cell: h3,
      last_seen: ctx.timestamp,
    });
  }
);

export const check_in_reducer = spacetimedb.reducer(
  { name: 'check_in' },
  {
    client_id: t.string(),
    person_id: t.u64(),
    kind: t.string(),
    result: t.string(),
    note: t.string(),
  },
  (ctx, a) => {
    checkClientId(ctx, a.client_id);
    const prior = ctx.db.check_in.client_id.find(a.client_id);
    if (prior) {
      if (prior.person_id !== a.person_id) fail('client_id was already used for another person');
      return; // idempotent repeat
    }
    oneOf('kind', a.kind, CHECK_IN_KIND);
    oneOf('result', a.result, CHECK_IN_RESULT);
    text('note', a.note);
    const p = getPerson(ctx, a.person_id);
    requireActFor(ctx, p, 'check in for them');
    ctx.db.check_in.insert({
      id: 0n,
      client_id: a.client_id,
      person_id: a.person_id,
      kind: a.kind,
      result: a.result,
      note: a.note,
      created_at: ctx.timestamp,
    });
    if (a.result === 'no_answer') return; // no contact: status and last_seen unchanged
    ctx.db.person.id.update({
      ...p,
      status: a.result,
      priority: a.result === 'safe' ? 'safe' : p.priority,
      last_seen: ctx.timestamp,
    });
  }
);

export const report_signal = spacetimedb.reducer(
  { person_id: t.u64(), kind: t.string(), value: t.f64() },
  (ctx, { person_id, kind, value }) => {
    oneOf('kind', kind, SIGNAL_KIND);
    if (!Number.isFinite(value)) fail('value must be a finite number');
    requireActFor(ctx, getPerson(ctx, person_id), 'report signals for them');
    ctx.db.signal.insert({ id: 0n, person_id, kind, value, created_at: ctx.timestamp });
  }
);

// Geofence: a person's location moves them into an H3 cell. If that cell carries an alert
// (set_cell_alert), log a geofence_entered signal once per entry. Staying in the cell, or
// moving between unflagged cells, logs nothing.
export const update_location = spacetimedb.reducer(
  { person_id: t.u64(), lat: t.f64(), lng: t.f64() },
  (ctx, { person_id, lat, lng }) => {
    const p = getPerson(ctx, person_id);
    requireActFor(ctx, p, 'update their location');
    const h3 = cellFor(lat, lng);
    const previous = p.h3_cell;
    ctx.db.person.id.update({ ...p, last_lat: lat, last_lng: lng, h3_cell: h3 });
    const cell = ctx.db.hex_cell.h3_cell.find(h3);
    if (h3 !== previous && cell && cell.alert_level !== '') {
      ctx.db.signal.insert({ id: 0n, person_id, kind: 'geofence_entered', value: 1, created_at: ctx.timestamp });
    }
  }
);

// ---------------------------------------------------------------------------
// From helpers
// ---------------------------------------------------------------------------

function requireHelperOrAgent(ctx: Ctx, helperId: bigint) {
  if (isStaff(ctx)) return;
  const helper = ctx.db.person.id.find(helperId);
  // Fail closed: a missing helper or a helper with no identity can only be answered by staff.
  if (!helper || !isSelf(ctx, helper)) fail('only the assigned helper may answer this assignment');
}

/**
 * mark_safe may come from the person, staff, or a helper whose assignment for one of the
 * person's active SOS events is accepted (the neighbor who is at the door).
 */
function isAcceptedHelperFor(ctx: Ctx, personId: bigint): boolean {
  for (const s of ctx.db.sos_event.person_id.filter(personId)) {
    if (!ACTIVE_SOS.includes(s.state)) continue;
    for (const a of ctx.db.assignment.sos_id.filter(s.id)) {
      if (a.state !== 'accepted') continue;
      const helper = ctx.db.person.id.find(a.helper_id);
      if (helper && isSelf(ctx, helper)) return true;
    }
  }
  return false;
}

export const accept_assignment = spacetimedb.reducer(
  { assignment_id: t.u64() },
  (ctx, { assignment_id }) => {
    const a = ctx.db.assignment.id.find(assignment_id);
    if (!a) fail(`assignment ${assignment_id} not found`);
    requireHelperOrAgent(ctx, a.helper_id);
    if (a.state !== 'offered') fail(`assignment is ${a.state}, not offered`);
    ctx.db.assignment.id.update({ ...a, state: 'accepted' });
    // An escalated SOS stays escalated: a neighbor on the way does not take it off the
    // professional responders' list.
    const s = ctx.db.sos_event.id.find(a.sos_id);
    if (s && s.state === 'open') {
      ctx.db.sos_event.id.update({ ...s, state: 'assigned' });
    }
  }
);

export const decline_assignment = spacetimedb.reducer(
  { assignment_id: t.u64() },
  (ctx, { assignment_id }) => {
    const a = ctx.db.assignment.id.find(assignment_id);
    if (!a) fail(`assignment ${assignment_id} not found`);
    requireHelperOrAgent(ctx, a.helper_id);
    if (a.state !== 'offered') fail(`assignment is ${a.state}, not offered`);
    ctx.db.assignment.id.update({ ...a, state: 'declined' });
  }
);

export const mark_safe = spacetimedb.reducer(
  { person_id: t.u64(), note: t.string() },
  (ctx, { person_id, note }) => {
    text('note', note);
    const p = getPerson(ctx, person_id);
    if (!canActFor(ctx, p) && !isAcceptedHelperFor(ctx, person_id)) {
      fail(`not allowed: only person ${person_id}, staff or their accepted helper may mark them safe`);
    }
    ctx.db.person.id.update({
      ...p,
      status: 'safe',
      priority: 'safe',
      priority_score: 0,
      last_seen: ctx.timestamp,
    });
    ctx.db.check_in.insert({
      id: 0n,
      client_id: `mark_safe:${person_id}:${ctx.timestamp.microsSinceUnixEpoch}`,
      person_id,
      kind: 'neighbor_visit',
      result: 'safe',
      note,
      created_at: ctx.timestamp,
    });
    for (const s of [...ctx.db.sos_event.person_id.filter(person_id)]) {
      if (!ACTIVE_SOS.includes(s.state)) continue;
      ctx.db.sos_event.id.update({ ...s, state: 'resolved' });
      for (const a of [...ctx.db.assignment.sos_id.filter(s.id)]) {
        if (a.state === 'accepted') ctx.db.assignment.id.update({ ...a, state: 'done' });
      }
    }
    audit(ctx, 'mark_safe', `person:${person_id}`);
  }
);

// ---------------------------------------------------------------------------
// From the agent worker (worker identity only)
// ---------------------------------------------------------------------------

export const save_triage = spacetimedb.reducer(
  {
    sos_id: t.option(t.u64()),
    person_id: t.u64(),
    urgency: t.u8(),
    confidence: t.f32(),
    needs: t.string(),
    priority: t.string(),
    reason: t.string(),
    model: t.string(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    if (a.urgency < 1 || a.urgency > 5) fail('urgency must be 1-5');
    if (!(a.confidence >= 0 && a.confidence <= 1)) fail('confidence must be 0-1');
    oneOf('needs', a.needs, TRIAGE_NEEDS);
    oneOf('priority', a.priority, TRIAGE_PRIORITY);
    text('reason', a.reason);
    text('model', a.model, 200);
    getPerson(ctx, a.person_id);
    if (a.sos_id !== undefined) getSos(ctx, a.sos_id);
    ctx.db.triage.insert({ id: 0n, ...a, sos_id: a.sos_id, created_at: ctx.timestamp });
  }
);

export const assign_helper = spacetimedb.reducer(
  { sos_id: t.u64(), helper_id: t.u64(), ring: t.u8() },
  (ctx, { sos_id, helper_id, ring }) => {
    requireWorker(ctx);
    const s = getSos(ctx, sos_id);
    if (!ACTIVE_SOS.includes(s.state)) fail(`sos ${sos_id} is ${s.state}`);
    getPerson(ctx, helper_id);
    if (helper_id === s.person_id) fail('a person cannot be their own helper');
    if (ring < 1 || ring > 3) fail('ring must be 1, 2 or 3');
    const a = ctx.db.assignment.insert({
      id: 0n,
      sos_id,
      helper_id,
      state: 'offered',
      offered_at: ctx.timestamp,
      ring,
    });
    const at = addSecs(ctx.timestamp, getConfig(ctx).assignment_timeout_secs);
    ctx.db.assignment_timeout_schedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(at.microsSinceUnixEpoch),
      assignment_id: a.id,
    });
  }
);

export const escalate = spacetimedb.reducer(
  { sos_id: t.u64(), reason: t.string() },
  (ctx, { sos_id, reason }) => {
    requireWorker(ctx);
    text('reason', reason);
    const s = getSos(ctx, sos_id);
    if (s.state === 'resolved') fail(`sos ${sos_id} is already resolved`);
    ctx.db.sos_event.id.update({ ...s, state: 'escalated' });
    audit(ctx, 'escalate', `sos:${sos_id} ${reason}`.slice(0, 500));
  }
);

export const request_action = spacetimedb.reducer(
  { person_id: t.u64(), action: t.string(), note: t.string() },
  (ctx, { person_id, action, note }) => {
    if (!isStaff(ctx)) fail('only staff may ask the agents to act');
    oneOf('action', action, ACTION_KIND);
    text('note', note);
    getPerson(ctx, person_id);
    const r = ctx.db.action_request.insert({
      id: 0n,
      person_id,
      action,
      note,
      requested_by: actorOf(ctx),
      created_at: ctx.timestamp,
      state: 'pending',
      result: '',
    });
    audit(ctx, 'request_action', `action:${r.id} ${action} person:${person_id}`);
  }
);

export const finish_action = spacetimedb.reducer(
  { request_id: t.u64(), state: t.string(), result: t.string() },
  (ctx, { request_id, state, result }) => {
    requireWorker(ctx);
    oneOf('state', state, ACTION_STATE);
    const r = ctx.db.action_request.id.find(request_id);
    if (!r) fail(`action request ${request_id} not found`);
    ctx.db.action_request.id.update({ ...r, state, result: result.slice(0, 4000) });
  }
);

export const save_incident_report = spacetimedb.reducer(
  {
    h3_cell: t.string(),
    summary: t.string(),
    blocked_roads: t.string(),
    p1: t.u32(),
    p2: t.u32(),
    unknown: t.u32(),
  },
  (ctx, a) => {
    requireWorker(ctx);
    if (!a.h3_cell) fail('h3_cell is required');
    text('h3_cell', a.h3_cell, 32);
    text('summary', a.summary, 8000);
    text('blocked_roads', a.blocked_roads);
    ctx.db.incident_report.insert({ id: 0n, ...a, created_at: ctx.timestamp });
  }
);

export const log_agent_step = spacetimedb.reducer(
  {
    agent: t.string(),
    subject: t.string(),
    kind: t.string(),
    content: t.string(),
    confidence: t.option(t.f32()),
  },
  (ctx, a) => {
    requireWorker(ctx);
    oneOf('agent', a.agent, AGENTS);
    oneOf('kind', a.kind, STEP_KIND);
    text('subject', a.subject, 200);
    if (a.confidence !== undefined && !(a.confidence >= 0 && a.confidence <= 1)) {
      fail('confidence must be 0-1');
    }
    ctx.db.agent_step.insert({
      id: 0n,
      agent: a.agent,
      subject: a.subject,
      kind: a.kind,
      content: a.content.slice(0, MAX_TEXT),
      confidence: a.confidence,
      created_at: ctx.timestamp,
    });
  }
);

export const set_priority = spacetimedb.reducer(
  { person_id: t.u64(), priority: t.string(), priority_score: t.f32() },
  (ctx, { person_id, priority, priority_score }) => {
    requireWorker(ctx);
    oneOf('priority', priority, PERSON_PRIORITY);
    if (!Number.isFinite(priority_score) || priority_score < 0) fail('priority_score must be >= 0');
    const p = getPerson(ctx, person_id);
    ctx.db.person.id.update({ ...p, priority, priority_score });
  }
);

export const set_cell_alert = spacetimedb.reducer(
  { h3_cell: t.string(), alert_level: t.string() },
  (ctx, { h3_cell, alert_level }) => {
    requireWorker(ctx);
    if (!h3_cell) fail('h3_cell is required');
    text('h3_cell', h3_cell, 32);
    text('alert_level', alert_level, 100);
    upsertCell(ctx, h3_cell, { alert_level });
  }
);

export const set_cell_census = spacetimedb.reducer(
  { h3_cell: t.string(), census_elderly_estimate: t.u32() },
  (ctx, { h3_cell, census_elderly_estimate }) => {
    requireWorker(ctx);
    if (!h3_cell) fail('h3_cell is required');
    text('h3_cell', h3_cell, 32);
    upsertCell(ctx, h3_cell, { census_elderly_estimate });
  }
);

// ---------------------------------------------------------------------------
// Key pass (every call writes audit_log, including refusals)
// ---------------------------------------------------------------------------

// A failed reducer rolls back its writes, so refusals are logged by returning
// early (after the audit insert) instead of throwing. Callers see the refusal
// in audit_log and in the module log; the call itself does not error.
// Exception: the call still errors when the caller passes malformed input.

function isResident(ctx: Ctx, householdId: bigint): boolean {
  for (const p of ctx.db.person.household_id.filter(householdId)) if (isSelf(ctx, p)) return true;
  return false;
}

export const grant_key_pass = spacetimedb.reducer(
  { household_id: t.u64(), helper_id: t.u64(), sos_id: t.u64(), approved_by: t.string() },
  (ctx, { household_id, helper_id, sos_id, approved_by }) => {
    const target = `household:${household_id} helper:${helper_id} sos:${sos_id}`;
    const refuse = (why: string) => {
      audit(ctx, `grant_key_pass_denied:${why}`, target);
      console.warn(`grant_key_pass refused: ${why} (${target})`);
    };
    if (!approved_by.trim()) return refuse('no_approval');
    text('approved_by', approved_by, 200);
    if (!ctx.db.household.id.find(household_id)) return refuse('no_household');
    // Only someone who lives there (by identity) or staff (the worker relays a resident's
    // approval from SMS/voice) may hand out a key. approved_by alone is just a label.
    if (!isStaff(ctx) && !isResident(ctx, household_id)) return refuse('not_resident_or_staff');
    if (!ctx.db.person.id.find(helper_id)) return refuse('no_helper');
    const s = ctx.db.sos_event.id.find(sos_id);
    if (!s || !ACTIVE_SOS.includes(s.state)) return refuse('no_active_sos');
    const sosPerson = ctx.db.person.id.find(s.person_id);
    if (!sosPerson || sosPerson.household_id !== household_id) return refuse('sos_not_for_household');
    // The key goes only to the neighbor who accepted this SOS.
    const accepted = [...ctx.db.assignment.sos_id.filter(sos_id)].some(
      a => a.helper_id === helper_id && a.state === 'accepted'
    );
    if (!accepted) return refuse('helper_not_accepted');
    const expires = addSecs(ctx.timestamp, getConfig(ctx).key_pass_ttl_secs);
    const kp = ctx.db.key_pass.insert({
      id: 0n,
      household_id,
      helper_id,
      sos_id,
      granted_at: ctx.timestamp,
      expires_at: expires,
      revoked: false,
      approved_by: approved_by.trim(),
    });
    ctx.db.key_pass_expiry_schedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(expires.microsSinceUnixEpoch),
      key_pass_id: kp.id,
    });
    audit(ctx, 'grant_key_pass', `key_pass:${kp.id} ${target} approved_by:${approved_by.trim()}`);
  }
);

export const revoke_key_pass = spacetimedb.reducer(
  { key_pass_id: t.u64() },
  (ctx, { key_pass_id }) => {
    const target = `key_pass:${key_pass_id}`;
    const kp = ctx.db.key_pass.id.find(key_pass_id);
    if (!kp) {
      audit(ctx, 'revoke_key_pass_denied:not_found', target);
      return;
    }
    // A resident of the household (by identity), the identity named in approved_by, the helper
    // giving the key back, or owner / worker / staff.
    const sender = ctx.sender.toHexString();
    const helper = ctx.db.person.id.find(kp.helper_id);
    const allowed =
      isStaff(ctx) ||
      kp.approved_by === sender ||
      isResident(ctx, kp.household_id) ||
      (!!helper && isSelf(ctx, helper));
    if (!allowed) {
      audit(ctx, 'revoke_key_pass_denied:not_owner_or_approver', target);
      return;
    }
    if (!kp.revoked) ctx.db.key_pass.id.update({ ...kp, revoked: true });
    audit(ctx, 'revoke_key_pass', target);
  }
);

export const log_unlock = spacetimedb.reducer(
  { key_pass_id: t.u64() },
  (ctx, { key_pass_id }) => {
    const target = `key_pass:${key_pass_id}`;
    const kp = ctx.db.key_pass.id.find(key_pass_id);
    if (!kp) {
      audit(ctx, 'log_unlock_denied:not_found', target);
      return;
    }
    if (kp.revoked) {
      audit(ctx, 'log_unlock_denied:revoked', target);
      return;
    }
    if (ctx.timestamp.microsSinceUnixEpoch >= kp.expires_at.microsSinceUnixEpoch) {
      audit(ctx, 'log_unlock_denied:expired', target);
      return;
    }
    // Only the helper holding the pass (or staff) can record an unlock; otherwise anyone could
    // forge "helper X opened the door" entries.
    const helper = ctx.db.person.id.find(kp.helper_id);
    if (!isStaff(ctx) && !(helper && isSelf(ctx, helper))) {
      audit(ctx, 'log_unlock_denied:not_helper', target);
      return;
    }
    const s = ctx.db.sos_event.id.find(kp.sos_id);
    if (!s || !ACTIVE_SOS.includes(s.state)) {
      audit(ctx, 'log_unlock_denied:sos_not_active', target);
      return;
    }
    audit(ctx, 'log_unlock', `${target} household:${kp.household_id} helper:${kp.helper_id}`);
  }
);

// ---------------------------------------------------------------------------
// Views (how clients read the private tables)
//
// ops_<table>: every row for the owner, the worker and staff; no rows for anyone else.
//   Viewers (read-only public dashboard) also read them, except ops_person (they get
//   dash_person, without phone numbers or identities) and ops_audit_log.
//   The worker subscribes to these instead of the tables (agents/src/store/spacetime.ts).
// my_<table>: only rows that belong to the caller's identity (people it registered, their
//   households, SOS events and safety nets, plus the assignments, SOS events and key passes
//   offered to people it registered as helpers). This is what a phone app subscribes to.
// hex_cell stays a public table (aggregate counts, no personal data).
// ---------------------------------------------------------------------------

const NO_ROW = 0n; // auto_inc ids start at 1, so `id = 0` selects nothing

export const ops_person = spacetimedb.view({ name: 'ops_person', public: true }, t.array(person.rowType), ctx =>
  (isStaff(ctx) ? ctx.from.person : ctx.from.person.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_household = spacetimedb.view({ name: 'ops_household', public: true }, t.array(household.rowType), ctx =>
  (canRead(ctx) ? ctx.from.household : ctx.from.household.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_safety_net = spacetimedb.view({ name: 'ops_safety_net', public: true }, t.array(safety_net.rowType), ctx =>
  (canRead(ctx) ? ctx.from.safety_net : ctx.from.safety_net.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_sos_event = spacetimedb.view({ name: 'ops_sos_event', public: true }, t.array(sos_event.rowType), ctx =>
  (canRead(ctx) ? ctx.from.sos_event : ctx.from.sos_event.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_check_in = spacetimedb.view({ name: 'ops_check_in', public: true }, t.array(check_in_table.rowType), ctx =>
  (canRead(ctx) ? ctx.from.check_in : ctx.from.check_in.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_signal = spacetimedb.view({ name: 'ops_signal', public: true }, t.array(signal.rowType), ctx =>
  (canRead(ctx) ? ctx.from.signal : ctx.from.signal.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_triage = spacetimedb.view({ name: 'ops_triage', public: true }, t.array(triage.rowType), ctx =>
  (canRead(ctx) ? ctx.from.triage : ctx.from.triage.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_assignment = spacetimedb.view({ name: 'ops_assignment', public: true }, t.array(assignment.rowType), ctx =>
  (canRead(ctx) ? ctx.from.assignment : ctx.from.assignment.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_key_pass = spacetimedb.view({ name: 'ops_key_pass', public: true }, t.array(key_pass.rowType), ctx =>
  (canRead(ctx) ? ctx.from.key_pass : ctx.from.key_pass.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_incident_report = spacetimedb.view(
  { name: 'ops_incident_report', public: true },
  t.array(incident_report.rowType),
  ctx => (canRead(ctx) ? ctx.from.incident_report : ctx.from.incident_report.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_agent_step = spacetimedb.view({ name: 'ops_agent_step', public: true }, t.array(agent_step.rowType), ctx =>
  (canRead(ctx) ? ctx.from.agent_step : ctx.from.agent_step.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_action_request = spacetimedb.view(
  { name: 'ops_action_request', public: true },
  t.array(action_request.rowType),
  ctx => (canRead(ctx) ? ctx.from.action_request : ctx.from.action_request.where(r => r.id.eq(NO_ROW))).build()
);
export const ops_audit_log = spacetimedb.view({ name: 'ops_audit_log', public: true }, t.array(audit_log.rowType), ctx =>
  (isStaff(ctx) ? ctx.from.audit_log : ctx.from.audit_log.where(r => r.id.eq(NO_ROW))).build()
);

/** People for the dashboard: staff and viewers, with phone numbers and identities blanked. */
export const dash_person = spacetimedb.view({ name: 'dash_person', public: true }, t.array(person.rowType), ctx =>
  canRead(ctx) ? [...ctx.db.person.iter()].map(p => ({ ...p, phone: '', identity: undefined })) : []
);

type ViewDb = { sender: Identity; db: { person: { iter(): Iterable<{ id: bigint; identity: Identity | undefined; household_id: bigint }> } } };

/** Ids of the people the caller registered. */
function myPersonIds(ctx: ViewDb): Set<bigint> {
  const ids = new Set<bigint>();
  for (const p of ctx.db.person.iter()) if (isSelf(ctx, p)) ids.add(p.id);
  return ids;
}

export const my_person = spacetimedb.view({ name: 'my_person', public: true }, t.array(person.rowType), ctx =>
  [...ctx.db.person.iter()].filter(p => isSelf(ctx, p))
);

export const my_household = spacetimedb.view({ name: 'my_household', public: true }, t.array(household.rowType), ctx => {
  const ids = new Set<bigint>();
  for (const p of ctx.db.person.iter()) if (isSelf(ctx, p)) ids.add(p.household_id);
  return [...ids].map(id => ctx.db.household.id.find(id)).filter((h): h is NonNullable<typeof h> => h != null);
});

export const my_safety_net = spacetimedb.view({ name: 'my_safety_net', public: true }, t.array(safety_net.rowType), ctx => {
  const out = [];
  for (const id of myPersonIds(ctx)) out.push(...ctx.db.safety_net.owner_id.filter(id));
  return out;
});

/** Assignments offered to the caller's people, and assignments on the caller's own SOS events. */
export const my_assignment = spacetimedb.view({ name: 'my_assignment', public: true }, t.array(assignment.rowType), ctx => {
  const mine = myPersonIds(ctx);
  const out = new Map<bigint, Infer<typeof assignment.rowType>>();
  for (const id of mine) {
    for (const a of ctx.db.assignment.helper_id.filter(id)) out.set(a.id, a);
    for (const s of ctx.db.sos_event.person_id.filter(id)) {
      for (const a of ctx.db.assignment.sos_id.filter(s.id)) out.set(a.id, a);
    }
  }
  return [...out.values()];
});

/** The caller's own SOS events, and SOS events a person they registered was offered or accepted. */
export const my_sos_event = spacetimedb.view({ name: 'my_sos_event', public: true }, t.array(sos_event.rowType), ctx => {
  const mine = myPersonIds(ctx);
  const out = new Map<bigint, Infer<typeof sos_event.rowType>>();
  for (const id of mine) {
    for (const s of ctx.db.sos_event.person_id.filter(id)) out.set(s.id, s);
    for (const a of ctx.db.assignment.helper_id.filter(id)) {
      if (a.state !== 'offered' && a.state !== 'accepted') continue;
      const s = ctx.db.sos_event.id.find(a.sos_id);
      if (s && ACTIVE_SOS.includes(s.state)) out.set(s.id, s);
    }
  }
  return [...out.values()];
});

/** Key passes held by the caller's people, and key passes to the caller's households. */
export const my_key_pass = spacetimedb.view({ name: 'my_key_pass', public: true }, t.array(key_pass.rowType), ctx => {
  const out = new Map<bigint, Infer<typeof key_pass.rowType>>();
  const households = new Set<bigint>();
  for (const p of ctx.db.person.iter()) {
    if (!isSelf(ctx, p)) continue;
    households.add(p.household_id);
  }
  for (const hh of households) for (const k of ctx.db.key_pass.household_id.filter(hh)) out.set(k.id, k);
  const mine = myPersonIds(ctx);
  for (const k of ctx.db.key_pass.iter()) if (mine.has(k.helper_id)) out.set(k.id, k);
  return [...out.values()];
});

// ---------------------------------------------------------------------------
// Scheduled
// ---------------------------------------------------------------------------

export const assignment_timeout = spacetimedb.reducer(
  { onSchedule: assignment_timeout_schedule },
  { timer: assignment_timeout_schedule.rowType },
  (ctx, { timer }) => {
    requireScheduler(ctx);
    const a = ctx.db.assignment.id.find(timer.assignment_id);
    if (a && a.state === 'offered') {
      ctx.db.assignment.id.update({ ...a, state: 'timed_out' });
    }
  }
);

export const expire_key_pass = spacetimedb.reducer(
  { onSchedule: key_pass_expiry_schedule },
  { timer: key_pass_expiry_schedule.rowType },
  (ctx, { timer }) => {
    requireScheduler(ctx);
    const kp = ctx.db.key_pass.id.find(timer.key_pass_id);
    if (kp && !kp.revoked) {
      ctx.db.key_pass.id.update({ ...kp, revoked: true });
      audit(ctx, 'expire_key_pass', `key_pass:${kp.id}`);
    }
  }
);

export const recount_cells = spacetimedb.reducer(
  { onSchedule: recount_schedule },
  { timer: recount_schedule.rowType },
  (ctx, _args) => {
    requireScheduler(ctx);
    recount(ctx);
  }
);
