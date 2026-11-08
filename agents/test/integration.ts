// End-to-end: local SpacetimeDB + the real worker process + live Nemotron.
//
//   spacetime start                         # terminal 1 (local server on 127.0.0.1:3000)
//   cd server && npm ci                     # once, module build deps
//   cd agents && npm run test:integration   # needs the Nemotron tunnel (agents/.env)
//
// Publishes a fresh database `firstline-it` (data wiped) from ../server, shortens the
// assignment timeout, registers Rosa + two neighbors with the CLI (as phones would), starts
// `src/index.ts` as a child process with SPACETIME_DB_NAME=firstline-it, sets the worker
// identity it prints, then presses Rosa's Spanish SOS with the CLI and checks with `spacetime sql`:
// triage saved by the model, agent_step rows, SOS escalated, Marcus offered (ring 1), and after
// the offer times out, Priya offered (ring 2).
//
// Env: STDB_SERVER (default local), STDB_HOST (default http://127.0.0.1:3000),
//      STDB_DB (default firstline-it), IT_TIMEOUT_SECS (assignment timeout, default 20).

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.env.STDB_SERVER ?? "local";
const HOST = process.env.STDB_HOST ?? "http://127.0.0.1:3000";
const DB = process.env.STDB_DB ?? "firstline-it";
const TIMEOUT_SECS = Number(process.env.IT_TIMEOUT_SECS ?? 20);
const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_DIR = path.resolve(AGENTS_DIR, "..", "server");
const ROSA_MSG = "agua entrando, mi mamá no puede caminar";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function stdb(args: string[]) {
  const r = spawnSync("spacetime", args, { encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const j = (v: unknown) => JSON.stringify(v);
function call(reducer: string, args: unknown[] = []) {
  const r = stdb(["call", "-s", SERVER, "--", DB, reducer, ...args.map(j)]);
  if (r.code !== 0) throw new Error(`call ${reducer} failed:\n${r.out}`);
  return r.out;
}
function sql(query: string): Record<string, string>[] {
  const r = spawnSync("spacetime", ["sql", "-s", SERVER, DB, query], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sql failed: ${query}\n${r.stdout}${r.stderr}`);
  const lines = (r.stdout ?? "").split(/\r?\n/);
  const sep = lines.findIndex((l) => /^-+(\+-+)*\s*$/.test(l));
  if (sep < 1) return [];
  const cols = lines[sep - 1]!.split("|").map((s) => s.trim());
  return lines
    .slice(sep + 1)
    .filter((l) => l.includes("|") || (cols.length === 1 && l.trim()))
    .map((l) => {
      const cells = l.split("|").map((s) => s.trim());
      return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").replace(/^"(.*)"$/, "$1")]));
    });
}
async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = probe();
    if (v !== undefined) return v;
    await sleep(1000);
  }
  console.log(`  .. gave up waiting for ${what} after ${timeoutMs / 1000} s`);
  return undefined;
}

async function main() {
  console.log(`[it] publishing ${DB} to ${SERVER} (fresh data)`);
  const pub = stdb(["publish", DB, "--server", SERVER, "--module-path", MODULE_DIR, "--yes", "--delete-data=always"]);
  if (pub.code !== 0) throw new Error(`publish failed:\n${pub.out}`);
  call("set_timing", [TIMEOUT_SECS, 0]);

  const person = (name: string, age: number, mobility: string, language: string, phone: string, lat: number, lng: number) =>
    call("register_person", [name, age, false, mobility, "", false, true, language, phone, `${name}'s house`, lat, lng]);
  person("Rosa", 58, "limited", "es", "+15550100001", 32.7767, -96.797);
  person("Marcus", 40, "ok", "en", "+15550100002", 32.777, -96.7975);
  person("Priya", 35, "ok", "en", "+15550100003", 32.78, -96.799);
  const ids = Object.fromEntries(sql("SELECT id, name FROM person").map((r) => [r.name, Number(r.id)]));
  call("set_safety_net", [
    ids.Rosa,
    [
      { member_id: ids.Marcus, ring: 1, skills: "truck" },
      { member_id: ids.Priya, ring: 2, skills: "boat,medical" },
    ],
  ]);
  check("people and safety net created", !!ids.Rosa && !!ids.Marcus && !!ids.Priya && sql("SELECT * FROM safety_net").length === 2);

  // Start the real worker process against the local database.
  const tokenDir = mkdtempSync(path.join(tmpdir(), "firstline-it-"));
  const worker = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: AGENTS_DIR,
    env: {
      ...process.env,
      SPACETIME_HOST: HOST,
      SPACETIME_DB_NAME: DB,
      SPACETIME_TOKEN: "",
      SPACETIME_TOKEN_PATH: path.join(tokenDir, "token"),
      // Keep the test to the SOS path: no outbound SMS, no feeds, no sweeps.
      TWILIO_ACCOUNT_SID: "",
      MQTT_URL: "",
      FEEDS: "0",
      SILENT_SIGNAL_EVERY_MS: "0",
      REPORTS_EVERY_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stdout.on("data", (d) => (log += d.toString()));
  worker.stderr.on("data", (d) => (log += d.toString()));
  const cleanup = () => {
    worker.kill();
    rmSync(tokenDir, { recursive: true, force: true });
  };

  try {
    const idHex = await waitFor("worker identity", () => log.match(/worker identity: (0x[0-9a-f]{64})/)?.[1], 30_000);
    check("worker connected and printed its identity", !!idHex, log.slice(-500));
    if (!idHex) return;
    call("set_worker_identity", [idHex]);
    await waitFor("worker running", () => (log.includes("running; Ctrl+C") ? true : undefined), 15_000);

    const t0 = Date.now();
    call("press_sos", ["it-rosa-1", ids.Rosa, ROSA_MSG, 32.7767, -96.797, "app"]);
    const sosId = Number(sql("SELECT id FROM sos_event WHERE client_id = 'it-rosa-1'")[0]?.id);
    check("press_sos created the SOS", sosId > 0);

    const triage = await waitFor("triage", () => sql(`SELECT * FROM triage WHERE person_id = ${ids.Rosa}`)[0], 120_000);
    console.log(`  .. triage after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, triage);
    check("triage saved by the model (not rules)", !!triage && triage.model !== "rules", JSON.stringify(triage));
    check("triage is P1 / professional", triage?.priority === "P1" && triage?.needs === "professional", JSON.stringify(triage));

    const firstOffer = await waitFor(
      "first assignment",
      () => sql(`SELECT * FROM assignment WHERE sos_id = ${sosId}`)[0],
      120_000,
    );
    check("Marcus offered (ring 1)", Number(firstOffer?.helper_id) === ids.Marcus && firstOffer?.ring === "1", JSON.stringify(firstOffer));
    check("SOS escalated", sql(`SELECT state FROM sos_event WHERE id = ${sosId}`)[0]?.state === "escalated");

    const steps =
      (await waitFor(
        "dispatch decision step",
        () => {
          const rows = sql(`SELECT agent, kind, content FROM agent_step WHERE subject = 'sos:${sosId}'`);
          return rows.some((s) => s.agent === "dispatch" && s.kind === "decision") ? rows : undefined;
        },
        60_000,
      )) ?? [];
    check(
      "agent_step rows from triage and dispatch",
      steps.some((s) => s.agent === "triage" && s.kind === "tool_call") && steps.some((s) => s.agent === "dispatch" && s.kind === "decision"),
      `${steps.length} steps`,
    );

    console.log(`  .. waiting ${TIMEOUT_SECS} s for the offer to Marcus to time out`);
    const replan = await waitFor(
      "replan to ring 2",
      () => {
        const rows = sql(`SELECT * FROM assignment WHERE sos_id = ${sosId}`);
        return rows.length >= 2 ? rows : undefined;
      },
      TIMEOUT_SECS * 1000 + 120_000,
    );
    const marcus = replan?.find((a) => Number(a.helper_id) === ids.Marcus);
    const priya = replan?.find((a) => Number(a.helper_id) === ids.Priya);
    check("Marcus's offer timed out", marcus?.state === "timed_out", JSON.stringify(replan));
    check("replanned: Priya offered (ring 2)", priya?.state === "offered" && priya?.ring === "2", JSON.stringify(replan));

    const all = sql(`SELECT agent, kind, content FROM agent_step WHERE subject = 'sos:${sosId}'`);
    console.log(`\n  agent_step for sos:${sosId} (${all.length} rows):`);
    for (const s of all) console.log(`    ${s.agent}/${s.kind}: ${(s.content ?? "").slice(0, 140)}`);
  } finally {
    cleanup();
    if (failures.length) console.log(`\n  worker log tail:\n${log.slice(-2000)}`);
  }
}

main()
  .catch((err) => {
    failures.push(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  })
  .finally(() => {
    console.log(`\n[it] ${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
    process.exit(failures.length ? 1 : 0);
  });
