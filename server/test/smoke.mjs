#!/usr/bin/env node
// Smoke test for the FirstLine module against a local SpacetimeDB.
// Publishes a fresh database (default name "firstline-smoke", data wiped), then drives it with
// `spacetime call` and checks state with `spacetime sql`.
//
//   spacetime start                 # in another terminal
//   cd server && npm install && node test/smoke.mjs
//
// Env: STDB_SERVER (default "local"), STDB_DB (default "firstline-smoke"), SKIP_PUBLISH=1.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { latLngToCell } from 'h3-js';

const SERVER = process.env.STDB_SERVER ?? 'local';
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
  mustFail('set_worker_identity only once', 'set_worker_identity', [me]);
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
