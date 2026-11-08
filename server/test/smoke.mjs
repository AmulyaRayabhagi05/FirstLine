#!/usr/bin/env node
// Smoke test for the FirstLine module against a local SpacetimeDB.
// Publishes a fresh database (default name "firstline-smoke", data wiped), then drives it with
// `spacetime call` and checks state with `spacetime sql`.
//
//   spacetime start                 # in another terminal
//   cd server && npm install && node test/smoke.mjs
//
// Env: STDB_SERVER (default "local"), STDB_HOST (default http://127.0.0.1:3000, used for the
// extra "phone" identities in the authorization checks), STDB_DB (default "firstline-smoke"),
// SKIP_PUBLISH=1.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { latLngToCell } from 'h3-js';

const SERVER = process.env.STDB_SERVER ?? 'local';
const HOST = (process.env.STDB_HOST ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const DB = process.env.STDB_DB ?? 'firstline-smoke';
const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
const failures = [];

function run(args, { stderr = true } = {}) {
  const r = spawnSync('spacetime', args, { encoding: 'utf8', shell: false });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout ?? '') + (stderr || r.status !== 0 ? r.stderr ?? '' : '') };
}

const j = v => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));
const some = v => ({ some: v });
const none = { none: [] };

function call(reducer, args = [], { anonymous = false } = {}) {
  const flags = ['call', '-s', SERVER];
  if (anonymous) flags.push('--anonymous');
  return run([...flags, '--', DB, reducer, ...args.map(j)]);
}

function sql(query) {
  const r = run(['sql', '-s', SERVER, DB, query], { stderr: false });
  if (r.code !== 0) throw new Error(`sql failed: ${query}\n${r.out}`);
  const lines = r.out.split(/\r?\n/);
  const sep = lines.findIndex(l => /^-+(\+-+)*\s*$/.test(l));
  if (sep < 1) return [];
  const cols = lines[sep - 1].split('|').map(s => s.trim());
  return lines.slice(sep + 1).filter(l => l.includes('|') || (cols.length === 1 && l.trim() && !l.startsWith('WARNING'))).map(l => {
    const cells = l.split('|').map(s => s.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]?.replace(/^"(.*)"$/, '$1')]));
  });
}

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function mustOk(reducer, args, opts) {
  const r = call(reducer, args, opts);
  if (r.code !== 0) throw new Error(`${reducer} failed unexpectedly:\n${r.out}`);
  return r;
}

function mustFail(name, reducer, args, opts) {
  const r = call(reducer, args, opts);
  check(name, r.code !== 0, r.code === 0 ? 'call succeeded' : '');
}

// ---- extra identities over HTTP (a phone is just another identity with its own token) ----
async function newIdentity() {
  const res = await fetch(`${HOST}/v1/identity`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /v1/identity: ${res.status}`);
  const { identity, token } = await res.json();
  return { hex: identity.replace(/^0x/, ''), token };
}

async function callAs(who, reducer, args = []) {
  const res = await fetch(`${HOST}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
    body: j(args),
  });
  return { ok: res.ok, text: await res.text() };
}

/** Rows as objects, or null when the query is refused (e.g. a private table). */
async function sqlAs(who, query) {
  const res = await fetch(`${HOST}/v1/database/${DB}/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}`, 'content-type': 'text/plain' },
    body: query,
  });
  if (!res.ok) return null;
  const [stmt] = await res.json();
  const cols = stmt.schema.elements.map(e => e.name?.some ?? e.name);
  return stmt.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function okAs(who, reducer, args) {
  const r = await callAs(who, reducer, args);
  if (!r.ok) throw new Error(`${reducer} failed unexpectedly: ${r.text}`);
}

async function failAs(name, who, reducer, args, match = /not allowed|only|reserved/) {
  const r = await callAs(who, reducer, args);
  check(name, !r.ok && match.test(r.text), r.ok ? 'call succeeded' : r.text.slice(0, 200));
}

const count = (table, where = '') => sql(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`).length;
const audit = () => sql('SELECT * FROM audit_log').map(r => `${r.action} ${r.target}`);

async function main() {
  const me = run(['login', 'show']).out.match(/[0-9a-f]{64}/)?.[0];
  if (!me) throw new Error('could not read CLI identity from `spacetime login show`');

  if (!process.env.SKIP_PUBLISH) {
    console.log(`publishing ${DB} to ${SERVER} (fresh data)...`);
    const p = run(['publish', DB, '-s', SERVER, '--module-path', MODULE_DIR, '--yes', '--delete-data=always']);
    if (p.code !== 0) throw new Error(`publish failed:\n${p.out}`);
  }

  console.log('setup');
  mustOk('set_timing', [5, 8]); // assignment timeout 5 s, key pass ttl 8 s (owner-only)

  console.log('register_person');
  const ann = [32.9857, -96.7502];
  mustOk('register_person', ['Ann Lee', 81, true, 'limited', 'oxygen', true, false, 'en', '555-0101', '1 Elm St', ...ann]);
  mustOk('register_person', ['Bob Diaz', 45, false, 'ok', '', false, true, 'es', '555-0102', '3 Elm St', 32.9861, -96.7498]);
  mustOk('register_person', ['Cara Ng', 38, false, 'ok', '', false, true, 'en', '555-0103', '9 Oak St', 32.9902, -96.7441]);
  const people = sql('SELECT * FROM person');
  check('3 people registered', people.length === 3);
  check('3 households created', count('household') === 3);
  const annRow = people.find(p => p.name === 'Ann Lee');
  check('h3_cell is res-9 cell of home', annRow?.h3_cell === latLngToCell(...ann, 9), `${annRow?.h3_cell}`);
  check('new person status unknown', annRow?.status === 'unknown');
  mustFail('rejects bad mobility', 'register_person', ['X', 50, false, 'flying', '', false, true, 'en', '', '', 1, 1]);
  mustFail('rejects lat out of range', 'register_person', ['X', 50, false, 'ok', '', false, true, 'en', '', '', 91, 1]);
  const [ANN, BOB, CARA] = [1, 2, 3];

  console.log('set_safety_net');
  mustOk('set_safety_net', [ANN, [
    { member_id: BOB, ring: 1, skills: 'truck, generator' },
    { member_id: CARA, ring: 2, skills: 'medical' },
  ]]);
  check('net has 2 members', count('safety_net', `owner_id = ${ANN}`) === 2);
  mustOk('set_safety_net', [ANN, [{ member_id: BOB, ring: 1, skills: 'boat' }]]);
  check('net replaced (1 member)', count('safety_net', `owner_id = ${ANN}`) === 1);
  mustFail('rejects ring 4', 'set_safety_net', [ANN, [{ member_id: BOB, ring: 4, skills: '' }]]);
  mustFail('rejects unknown skill', 'set_safety_net', [ANN, [{ member_id: BOB, ring: 1, skills: 'jetpack' }]]);

  console.log('press_sos / check_in idempotency');
  const sosArgs = ['sos-abc-1', ANN, 'Water rising, need help with oxygen', ...ann, 'app'];
  mustOk('press_sos', sosArgs);
  mustOk('press_sos', sosArgs);
  check('same client_id -> one sos row', count('sos_event', "client_id = 'sos-abc-1'") === 1);
  check('person needs_help after sos', sql(`SELECT * FROM person WHERE id = ${ANN}`)[0]?.status === 'needs_help');
  mustFail('rejects bad channel', 'press_sos', ['sos-x', ANN, 'm', ...ann, 'pigeon']);
  mustOk('check_in', ['ci-1', CARA, 'app', 'safe', 'all good']);
  mustOk('check_in', ['ci-1', CARA, 'app', 'safe', 'all good']);
  check('same client_id -> one check_in row', count('check_in', "client_id = 'ci-1'") === 1);
  check('check_in safe sets status', sql(`SELECT * FROM person WHERE id = ${CARA}`)[0]?.status === 'safe');
  mustOk('report_signal', [ANN, 'power_out', 1]);
  check('signal stored', count('signal') === 1);

  console.log('worker-only reducers');
  mustFail('worker reducer before worker is set', 'log_agent_step', ['triage', 'sos:1', 'thought', 'x', none]);
  mustFail('non-owner cannot set worker', 'set_worker_identity', [me], { anonymous: true });
  mustOk('set_worker_identity', [me]); // in the test, the CLI identity plays the worker
  mustOk('set_worker_identity', [me]); // the owner may replace the worker (token rotation)
  mustFail('non-worker save_triage fails', 'save_triage', [some(1), ANN, 5, 0.9, 'professional', 'P1', 'oxygen', 'nemotron'], { anonymous: true });
  mustFail('non-worker assign_helper fails', 'assign_helper', [1, BOB, 1], { anonymous: true });
  mustFail('non-worker log_agent_step fails', 'log_agent_step', ['triage', 'sos:1', 'thought', 'x', none], { anonymous: true });
  mustOk('save_triage', [some(1), ANN, 5, 0.9, 'professional', 'P1', 'oxygen user, water rising', 'nemotron']);
  mustOk('log_agent_step', ['triage', 'sos:1', 'decision', 'P1: oxygen + flooding', some(0.9)]);
  mustOk('set_priority', [ANN, 'P1', 9.5]);
  check('triage row', count('triage') === 1);
  check('agent_step row', count('agent_step') === 1);
  check('priority set', sql(`SELECT * FROM person WHERE id = ${ANN}`)[0]?.priority === 'P1');
  mustFail('rejects urgency 9', 'save_triage', [none, ANN, 9, 0.5, 'neighbor', 'P2', 'r', 'm']);

  console.log('assignments');
  mustOk('assign_helper', [1, BOB, 1]); // assignment 1
  mustOk('decline_assignment', [1]);
  check('assignment 1 declined', sql('SELECT * FROM assignment WHERE id = 1')[0]?.state === 'declined');
  mustFail('cannot accept a declined assignment', 'accept_assignment', [1]);
  mustOk('assign_helper', [1, CARA, 2]); // assignment 2
  mustOk('accept_assignment', [2]);
  check('assignment 2 accepted', sql('SELECT * FROM assignment WHERE id = 2')[0]?.state === 'accepted');
  check('sos assigned', sql('SELECT * FROM sos_event WHERE id = 1')[0]?.state === 'assigned');
  mustOk('assign_helper', [1, BOB, 1]); // assignment 3, left to time out

  console.log('key pass');
  const auditBefore = audit().length;
  mustOk('grant_key_pass', [2, BOB, 1, 'Bob']); // Bob's household has no SOS
  check('grant without SOS -> no key_pass', count('key_pass') === 0);
  mustOk('grant_key_pass', [1, CARA, 1, '']);
  check('grant without approval -> no key_pass', count('key_pass') === 0);
  mustOk('grant_key_pass', [1, CARA, 1, 'Ann Lee']);
  const kp = sql('SELECT * FROM key_pass');
  check('grant with SOS + approval -> key_pass', kp.length === 1 && kp[0].revoked === 'false');
  mustOk('log_unlock', [1]);
  mustOk('revoke_key_pass', [1]);
  check('key pass revoked', sql('SELECT * FROM key_pass WHERE id = 1')[0]?.revoked === 'true');
  mustOk('log_unlock', [1]);
  mustOk('grant_key_pass', [1, CARA, 1, 'Ann Lee']); // key pass 2, left to expire
  const log = audit();
  const has = (prefix, target = '') => log.some(l => l.startsWith(prefix) && l.includes(target));
  check('audit: denied without SOS for household', has('grant_key_pass_denied:sos_not_for_household', 'household:2'));
  check('audit: denied without approval', has('grant_key_pass_denied:no_approval'));
  check('audit: grant', has('grant_key_pass ', 'key_pass:1'));
  check('audit: unlock', has('log_unlock ', 'key_pass:1'));
  check('audit: revoke', has('revoke_key_pass ', 'key_pass:1'));
  check('audit: unlock after revoke denied', has('log_unlock_denied:revoked', 'key_pass:1'));
  check('every key-pass call audited (7 rows)', log.length - auditBefore === 7, `got ${log.length - auditBefore}`);

  console.log('timers (waiting ~10 s)');
  await sleep(10_000);
  check('assignment 3 timed_out after 5 s', sql('SELECT * FROM assignment WHERE id = 3')[0]?.state === 'timed_out');
  check('accepted assignment untouched by timer', sql('SELECT * FROM assignment WHERE id = 2')[0]?.state === 'accepted');
  check('key pass 2 expired', sql('SELECT * FROM key_pass WHERE id = 2')[0]?.revoked === 'true');
  check('audit: expire_key_pass', audit().some(l => l.startsWith('expire_key_pass') && l.includes('key_pass:2')));
  mustOk('log_unlock', [2]);
  check('unlock after expiry denied', audit().some(l => l.startsWith('log_unlock_denied') && l.includes('key_pass:2')));

  console.log('recount_cells (scheduled every 30 s; waiting up to 35 s)');
  let cells = [];
  for (let i = 0; i < 35; i++) {
    cells = sql('SELECT * FROM hex_cell');
    if (cells.reduce((n, c) => n + Number(c.total_people), 0) === 3) break;
    await sleep(1000);
  }
  check('scheduled recount counted 3 people', cells.reduce((n, c) => n + Number(c.total_people), 0) === 3);
  const annCell = latLngToCell(...ann, 9);
  mustOk('set_cell_census', [annCell, 100]);
  mustOk('set_cell_alert', [annCell, 'flash_flood_warning']);
  mustOk('recount_now', []);
  const c = sql(`SELECT * FROM hex_cell WHERE h3_cell = '${annCell}'`)[0];
  check('coverage_gap when census high, few registered', c?.coverage_gap === 'true', j(c));
  check('alert level stored', c?.alert_level === 'flash_flood_warning');
  check('needs_help counted', Number(c?.needs_help) >= 1, j(c));

  console.log('mark_safe / escalate / report');
  mustOk('mark_safe', [ANN, 'Cara checked in person']);
  check('sos resolved', sql('SELECT * FROM sos_event WHERE id = 1')[0]?.state === 'resolved');
  check('accepted assignment done', sql('SELECT * FROM assignment WHERE id = 2')[0]?.state === 'done');
  check('person safe', sql(`SELECT * FROM person WHERE id = ${ANN}`)[0]?.status === 'safe');
  mustFail('cannot escalate resolved sos', 'escalate', [1, 'late']);
  mustOk('press_sos', ['sos-abc-2', BOB, 'Tree on car', 32.9861, -96.7498, 'sms']);
  mustOk('escalate', [2, 'no helper in range']);
  check('sos escalated', sql('SELECT * FROM sos_event WHERE id = 2')[0]?.state === 'escalated');
  mustOk('save_incident_report', [annCell.slice(0, 15), 'Flooding near Elm St', 'Elm St', 1, 0, 2]);
  check('incident report stored', count('incident_report') === 1);

  await authorization();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failed: ${failures.join('; ')}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e.message ?? e);
  process.exit(1);
});

// Phones are separate identities. They see only their own rows and may act only for the people
// they registered; a stranger cannot read private tables, mark someone safe, answer someone
// else's assignment, hand out or use a key pass, or call owner/worker reducers.
async function authorization() {
  console.log('authorization (separate identities over HTTP)');
  mustOk('set_timing', [600, 600]); // keep offers alive while the phones answer
  const phone = await newIdentity(); // Dee's phone
  const helperPhone = await newIdentity(); // Hal's phone
  const stranger = await newIdentity();

  check('stranger cannot read private person table', (await sqlAs(stranger, 'SELECT * FROM person')) === null);
  check('stranger cannot read private household table', (await sqlAs(stranger, 'SELECT * FROM household')) === null);
  check('stranger cannot read private key_pass table', (await sqlAs(stranger, 'SELECT * FROM key_pass')) === null);
  check('stranger cannot read private audit_log table', (await sqlAs(stranger, 'SELECT * FROM audit_log')) === null);
  check('stranger sees no rows in ops_person', (await sqlAs(stranger, 'SELECT * FROM ops_person'))?.length === 0);
  check('stranger sees no rows in ops_audit_log', (await sqlAs(stranger, 'SELECT * FROM ops_audit_log'))?.length === 0);
  check('hex_cell stays public', ((await sqlAs(stranger, 'SELECT * FROM hex_cell'))?.length ?? 0) > 0);
  check('owner/worker sees every person in ops_person', count('ops_person') === count('person'));

  const dee = [32.9871, -96.7512];
  await okAs(phone, 'register_person', ['Dee Park', 77, true, 'limited', 'insulin', false, true, 'en', '555-0104', '5 Elm St', ...dee]);
  await okAs(helperPhone, 'register_person', ['Hal Ruiz', 33, false, 'ok', '', false, true, 'en', '555-0105', '7 Elm St', 32.9875, -96.7509]);
  const DEE = Number(sql("SELECT * FROM person WHERE name = 'Dee Park'")[0]?.id);
  const HAL = Number(sql("SELECT * FROM person WHERE name = 'Hal Ruiz'")[0]?.id);
  const DEE_HH = Number(sql(`SELECT * FROM person WHERE id = ${DEE}`)[0]?.household_id);
  const ANN = 1;
  const mine = await sqlAs(phone, 'SELECT * FROM my_person');
  check('phone sees only its own person in my_person', mine?.length === 1 && Number(mine[0].id) === DEE, j(mine));
  check('phone sees its household in my_household', (await sqlAs(phone, 'SELECT * FROM my_household'))?.length === 1);
  check('phone sees nothing in ops_person', (await sqlAs(phone, 'SELECT * FROM ops_person'))?.length === 0);

  // Acting for someone else.
  await failAs('stranger cannot mark someone safe', stranger, 'mark_safe', [DEE, 'fake']);
  await failAs('stranger cannot press SOS for someone else', stranger, 'press_sos', ['x-1', DEE, 'fake', ...dee, 'app']);
  await failAs('stranger cannot check in someone else', stranger, 'check_in', ['x-2', DEE, 'app', 'safe', 'fake']);
  await failAs('stranger cannot report signals for someone else', stranger, 'report_signal', [DEE, 'power_out', 1]);
  await failAs("stranger cannot change someone's safety net", stranger, 'set_safety_net', [DEE, [{ member_id: HAL, ring: 1, skills: '' }]]);
  await failAs('phone cannot press SOS for another person', phone, 'press_sos', ['x-3', ANN, 'fake', ...dee, 'app']);
  await failAs('phone cannot use reserved sms: client_id', phone, 'press_sos', ['sms:SMfuture', DEE, 'help', ...dee, 'app']);
  await failAs('stranger cannot add staff', stranger, 'add_staff', [[`0x${stranger.hex}`]]);
  await failAs('stranger cannot set the worker identity', stranger, 'set_worker_identity', [[`0x${stranger.hex}`]]); // HTTP JSON: Identity is a 1-tuple
  await failAs('stranger cannot change timing', stranger, 'set_timing', [1, 1]);
  await failAs('stranger cannot force a recount', stranger, 'recount_now', []);
  await failAs('stranger cannot save triage', stranger, 'save_triage', [none, DEE, 1, 0.9, 'neighbor', 'P3', 'fake', 'm']);
  await failAs('stranger cannot set priority', stranger, 'set_priority', [DEE, 'safe', 0]);

  // The phone acting for its own person works.
  await okAs(phone, 'set_safety_net', [DEE, [{ member_id: HAL, ring: 1, skills: 'truck' }]]);
  await okAs(phone, 'press_sos', ['dee-sos-1', DEE, 'Cannot get insulin, power out', ...dee, 'app']);
  const deeSos = Number(sql("SELECT * FROM sos_event WHERE client_id = 'dee-sos-1'")[0]?.id);
  check('phone pressed SOS for its own person', deeSos > 0);
  check('phone sees its SOS in my_sos_event', (await sqlAs(phone, 'SELECT * FROM my_sos_event'))?.length === 1);
  await failAs('client_id reused for another person is refused', stranger, 'press_sos', ['dee-sos-1', ANN, 'x', ...dee, 'app'], /already used|not allowed/);

  // Helper flow: the worker offers, only the helper's identity can answer.
  mustOk('assign_helper', [deeSos, HAL, 1]);
  const offer = Number(sql(`SELECT * FROM assignment WHERE sos_id = ${deeSos}`)[0]?.id);
  check('helper sees the offered SOS in my_sos_event', !!(await sqlAs(helperPhone, 'SELECT * FROM my_sos_event'))?.some(r => Number(r.id) === deeSos));
  check('helper sees the offer in my_assignment', !!(await sqlAs(helperPhone, 'SELECT * FROM my_assignment'))?.some(r => Number(r.id) === offer));
  await failAs("stranger cannot accept someone else's assignment", stranger, 'accept_assignment', [offer]);
  await failAs("stranger cannot decline someone else's assignment", stranger, 'decline_assignment', [offer]);
  await failAs('helper cannot mark safe before accepting', helperPhone, 'mark_safe', [DEE, 'early']);
  await okAs(helperPhone, 'accept_assignment', [offer]);
  check('helper accepted', sql(`SELECT * FROM assignment WHERE id = ${offer}`)[0]?.state === 'accepted');

  // Key pass: only a resident (or staff) can grant, only to the accepted helper; only the
  // helper (or staff) can log an unlock.
  const kpBefore = count('key_pass');
  await okAs(stranger, 'grant_key_pass', [DEE_HH, HAL, deeSos, 'Dee Park']);
  check('stranger grant -> no key pass', count('key_pass') === kpBefore);
  await okAs(phone, 'grant_key_pass', [DEE_HH, DEE, deeSos, 'Dee Park']);
  check('grant to someone who did not accept -> no key pass', count('key_pass') === kpBefore);
  await okAs(phone, 'grant_key_pass', [DEE_HH, HAL, deeSos, 'Dee Park']);
  const kp = sql(`SELECT * FROM key_pass WHERE sos_id = ${deeSos}`);
  check('resident grant to accepted helper -> key pass', kp.length === 1);
  const KP = Number(kp[0]?.id);
  check('helper sees the key pass in my_key_pass', (await sqlAs(helperPhone, 'SELECT * FROM my_key_pass'))?.length === 1);
  check('stranger sees no key pass in my_key_pass', (await sqlAs(stranger, 'SELECT * FROM my_key_pass'))?.length === 0);
  await okAs(stranger, 'log_unlock', [KP]);
  await okAs(stranger, 'revoke_key_pass', [KP]);
  await okAs(helperPhone, 'log_unlock', [KP]);
  const log = audit();
  const has = (prefix, target = '') => log.some(l => l.startsWith(prefix) && l.includes(target));
  check('audit: stranger grant denied', has('grant_key_pass_denied:not_resident_or_staff', `household:${DEE_HH}`));
  check('audit: grant to non-accepted helper denied', has('grant_key_pass_denied:helper_not_accepted', `household:${DEE_HH}`));
  check('audit: stranger unlock denied', has('log_unlock_denied:not_helper', `key_pass:${KP}`));
  check('audit: stranger revoke denied', has('revoke_key_pass_denied:not_owner_or_approver', `key_pass:${KP}`));
  check('audit: helper unlock recorded', has('log_unlock ', `key_pass:${KP}`));
  check('key pass not revoked by stranger', sql(`SELECT * FROM key_pass WHERE id = ${KP}`)[0]?.revoked === 'false');

  // The accepted helper can mark the person safe; that resolves the SOS.
  await okAs(helperPhone, 'mark_safe', [DEE, 'Hal is with Dee']);
  check('accepted helper marked safe', sql(`SELECT * FROM person WHERE id = ${DEE}`)[0]?.status === 'safe');
  check('mark_safe audited', audit().some(l => l.startsWith('mark_safe') && l.includes(`person:${DEE}`)));
  await okAs(helperPhone, 'log_unlock', [KP]);
  check('unlock after SOS resolved denied', audit().some(l => l.startsWith('log_unlock_denied:sos_not_active') && l.includes(`key_pass:${KP}`)));

  // Staff (dashboard identity) added by the owner can read ops_* views; removal takes it away.
  mustOk('add_staff', [stranger.hex]);
  check('staff sees every person in ops_person', ((await sqlAs(stranger, 'SELECT * FROM ops_person'))?.length ?? -1) === count('person'));
  mustOk('remove_staff', [stranger.hex]);
  check('removed staff sees no ops_person rows', (await sqlAs(stranger, 'SELECT * FROM ops_person'))?.length === 0);
}
