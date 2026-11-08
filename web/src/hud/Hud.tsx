import { useEffect, useMemo, useRef, useState } from 'react';
import { traceHref } from './TraceView';
import { createPortal } from 'react-dom';
import { COMMS, fmtTime, homes, type Status } from '../sim/world';
import { useMap, counts, isKeyDecision, STATUS_COLOR, STATUS_LABEL, type ActionKind, type AgentLine, type Resident } from '../state/store';
import { SPACETIME_DB, SPACETIME_HOST, clearFlood, markHouseholdSafe, requestAction, signIn, signOut, startFlood } from '../data/live';

export function Wordmark() {
  return (
    <div className="wordmark">
      <i />
      FIRSTLINE
    </div>
  );
}

/** Re-renders every `ms` so wall-clock text stays current. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const AGENT_NAME: Record<string, string> = {
  triage: 'Triage',
  dispatch: 'Dispatch',
  silent_signal: 'Silent signal',
  reports: 'Reports',
};
const agentName = (a: string) => AGENT_NAME[a] ?? a;

// Compact top-left badge: the one number that matters, the clock, and a thin status breakdown.
export function CounterBadge() {
  const statuses = useMap((s) => s.statuses);
  const people = useMap((s) => s.liveInfo.people);
  const now = useNow();
  const c = counts(statuses);
  return (
    <section className="panel badge" aria-label="City overview">
      <Wordmark />
      <div className="counter">
        <div className={`big ${c.unreached === 0 && people > 0 ? 'zero' : ''}`}>{c.unreached}</div>
        <div className="cap">
          Not yet reached
          <span className="clock">{fmtTime(now)}</span>
        </div>
      </div>
      <div className="mix" aria-label={`${c.p1} help now, ${c.p2} silent, ${c.enroute} en route, ${c.safe} safe`}>
        <span style={{ color: STATUS_COLOR.p1 }}>{c.p1} P1</span>
        <span style={{ color: STATUS_COLOR.p2 }}>{c.p2} silent</span>
        <span style={{ color: STATUS_COLOR.enroute }}>{c.enroute} en route</span>
        <span style={{ color: STATUS_COLOR.safe }}>{c.safe} safe</span>
      </div>
    </section>
  );
}

// One line at the top for agent decisions a person should know about. It fades after a few seconds.
export function DecisionTicker() {
  const feed = useMap((s) => s.feed);
  const latest = useMemo(() => [...feed].reverse().find(isKeyDecision), [feed]);
  const [shown, setShown] = useState<AgentLine | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!latest || latest === shown || Date.now() - latest.at > 60_000) return;
    setShown(latest);
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 5200);
    return () => clearTimeout(id);
  }, [latest]);
  if (!shown) return null;
  const home = shown.homeIdx === null ? undefined : homes[shown.homeIdx];
  return (
    <div className={`panel ticker ${visible ? 'on' : ''}`} role="status">
      <span className="who">Nemotron · {agentName(shown.agent)}</span>
      <span className="nc">
        {home ? `#${home.id} ${COMMS[home.comm].name}: ` : ''}
        {shown.text}
        {shown.conf !== null && <span className="conf"> ({shown.conf.toFixed(2)})</span>}
      </span>
    </div>
  );
}

// Compact top-right toolbar; layers and legend live in a menu that opens on demand.
export function Toolbar() {
  const s = useMap();
  const demoOn = s.demo !== 'off';
  const startDemo = () => {
    if (demoOn) return s.setDemo('off');
    s.setFinale(false);
    s.select(null);
    s.setPlaying(false);
    s.setT(0);
    s.setDim(1);
    s.setDemo('sweep');
  };
  return (
    <div className="toolbar">
      <div className="panel seg" role="group" aria-label="View">
        <button aria-pressed={s.dimTarget < 0.5} onClick={() => s.setDim(0)}>2D</button>
        <button aria-pressed={s.dimTarget >= 0.5} onClick={() => s.setDim(1)}>3D</button>
      </div>
      <button className="panel tbtn" aria-expanded={s.layersOpen} onClick={() => s.setLayersOpen(!s.layersOpen)}>Layers</button>
      <button className="panel tbtn red" onClick={startDemo} aria-pressed={demoOn}>{demoOn ? '■ Stop' : '▶ Tour'}</button>
      <a className="panel tbtn" href={traceHref()} title="Every case, hop by hop: which agent called which tool">Trace</a>
      {s.liveInfo.viewer ? (
        <button className="panel tbtn" onClick={() => { s.setWantStaff(true); s.setSignedIn(false); }} title="Sign in with a staff access key to act on households">Staff sign-in</button>
      ) : (
        <button className="panel tbtn" onClick={() => { signOut(); s.setSignedIn(false); }} title="Forget this browser's access key">Sign out</button>
      )}
      {s.layersOpen && (
        <section className="panel layers" aria-label="Layers and legend">
          <div className="slide">
            <div className="label">2D map ↔ 3D city</div>
            <input type="range" min={0} max={1} step={0.001} value={s.dimTarget} aria-label="Slide between the 2D map and the 3D city" onChange={(e) => s.setDim(+e.target.value)} />
          </div>
          <div className="toggles">
            <label className="toggle"><input type="checkbox" checked={s.showBeams} onChange={() => s.toggle('showBeams')} /> Porch beams</label>
            <label className="toggle"><input type="checkbox" checked={s.showZone} onChange={() => s.toggle('showZone')} /> Flood danger zone</label>
            <label className="toggle"><input type="checkbox" checked={s.showNames} onChange={() => s.toggle('showNames')} /> Neighborhood names</label>
          </div>
          <div className="legend" aria-label="Legend">
            {([
              ['safe', '✓', 'Safe · short green beam'],
              ['p1', '!', 'Needs help · tall red beam'],
              ['enroute', '→', 'Help on the way · blue'],
            ] as const).map(([k, g, t]) => (
              <div key={k}><span className="sq" style={{ background: STATUS_COLOR[k] }}>{g}</span>{t}</div>
            ))}
          </div>
          <div className="source">Data: live SpacetimeDB · {SPACETIME_DB} @ {SPACETIME_HOST.replace(/^https?:\/\//, '')}</div>
        </section>
      )}
    </div>
  );
}

// Opening sequence: one idea per screen over the slowly turning city, then the map.
const STEPS = [
  { kicker: 'Winter Storm Uri · Texas · 2021', big: '246', line: 'people died. Most were 60 or older. Many were alone, with neighbors next door who never knew.' },
  { kicker: 'The first hours', big: '', line: 'When 911 is overwhelmed, the people who reach you first are your neighbors.' },
  { kicker: 'FirstLine · Dallas', big: '', line: 'Every household gets a safety net of neighbors. AI finds who needs help most, including people who never ask.' },
];
export function Intro() {
  const intro = useMap((s) => s.intro);
  const setIntro = useMap((s) => s.setIntro);
  const [step, setStep] = useState(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!intro || step !== 0) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 1600);
      setN(Math.round(246 * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [intro, step]);
  if (!intro) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const enter = (tour: boolean) => {
    setIntro(false);
    const st = useMap.getState();
    if (tour) {
      st.setT(0);
      st.setDim(1);
      st.setDemo('sweep');
    }
  };
  return (
    <div className="intro" role="dialog" aria-label="Introduction">
      <div className="introbox" key={step}>
        <div className="kicker">{s.kicker}</div>
        {s.big && <div className="introbig">{step === 0 ? n : s.big}</div>}
        {last && <Wordmark />}
        <p className="introline nc">{s.line}</p>
        <div className="introbtns">
          {!last && <button className="btn" onClick={() => setStep(step + 1)}>Next</button>}
          {last && <button className="btn primary" onClick={() => enter(true)}>▶ Tour the city</button>}
          {last && <button className="btn" onClick={() => enter(false)}>Open the live map</button>}
        </div>
        <button className="skip" onClick={() => enter(false)}>Skip intro</button>
      </div>
    </div>
  );
}

// Bottom bar: connection state and what the database holds right now.
export function LiveBar() {
  const info = useMap((s) => s.liveInfo);
  const now = useNow(5_000);
  const color = info.state === 'error' ? STATUS_COLOR.p1 : info.state === 'subscribed' && info.people > 0 ? STATUS_COLOR.safe : STATUS_COLOR.unknown;
  const ago = info.lastUpdate ? Math.max(0, Math.round((now - info.lastUpdate) / 1000)) : null;
  return (
    <section className="panel timeline livebar" aria-label="Live data">
      <span className="dot" style={{ background: color }} aria-hidden="true" />
      <div>
        <div className="livemsg nc">{info.message}</div>
        <div className="ticks">
          <span>{info.people} people</span>
          <span>{info.households} households</span>
          <span>{info.openSos} open SOS</span>
          <span>{info.alertedCells} alerted cells</span>
          <span>{info.triaged} triaged</span>
          <span>{info.agentSteps} agent steps</span>
          {info.activeKeyPasses > 0 && <span>{info.activeKeyPasses} key passes</span>}
          <span>{ago === null ? '—' : `updated ${ago}s ago`}</span>
        </div>
        <div className="privacy nc">Opt-in only. Phones and health details are staff-only. Everything is deleted after the event.</div>
      </div>
      <FloodControls />
    </section>
  );
}

// Demo controls for a flood. They write to the database (one reducer call per person), so each asks first.
function FloodControls() {
  const info = useMap((s) => s.liveInfo);
  const statuses = useMap((s) => s.statuses);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<'flood' | 'clear' | null>(null);
  if (info.state !== 'subscribed' || info.people === 0 || info.viewer) return null;
  const active = statuses.some((s) => s === 'p1' || s === 'p2' || s === 'unknown' || s === 'enroute');
  const run = async (kind: 'flood' | 'clear') => {
    setConfirm(null);
    try {
      const n = kind === 'flood' ? await startFlood((d, t) => setBusy(`Flooding ${d}/${t}`)) : await clearFlood((d, t) => setBusy(`Marking safe ${d}/${t}`));
      setBusy(n ? '' : kind === 'flood' ? 'No safe households in the flood zone' : 'Nobody needs help');
    } catch (e) {
      setBusy(`Failed: ${(e as Error).message}`);
    }
  };
  if (confirm)
    return (
      <div className="lb-actions">
        <span className="lb-q nc">{confirm === 'flood' ? 'Flood the river zone? Residents there report needing help.' : 'Mark everyone who needs help as safe?'}</span>
        <button className="btn danger" onClick={() => run(confirm)}>Yes</button>
        <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
      </div>
    );
  return (
    <div className="lb-actions">
      {busy && <span className="lb-q nc">{busy}</span>}
      <button className="btn danger" onClick={() => setConfirm('flood')}>Start flood</button>
      <button className="btn" disabled={!active} onClick={() => setConfirm('clear')}>Clear flood</button>
    </div>
  );
}

const hasBlocked = (roads: string) => !!roads && !/^(none|no blocked roads?)\.?$/i.test(roads.trim());

// Left panel: incident reports the reports agent writes per res-8 cell. Clicking one opens them
// all in a larger, scrollable pop-up, starting at the one clicked.
export function IncidentReports() {
  const reports = useMap((s) => s.reports);
  const wave = useMap((s) => s.liveInfo.wave);
  const [open, setOpen] = useState(true);
  const [viewing, setViewing] = useState<string | null>(null); // id of the report the pop-up opened on
  if (reports.length === 0 && !wave) return null;
  const all = wave && wave.triaged >= wave.people;
  return (
    <>
      <section className="panel reports" aria-label="Incident reports">
        {wave && (
          <div className="wavestat">
            <div className="big">
              {all ? (
                <>All <b>{wave.people}</b> at-risk people triaged in <b>{wave.minutes} min</b></>
              ) : (
                <><b>{wave.triaged}</b> of {wave.people} at-risk people triaged · {wave.minutes} min so far</>
              )}
            </div>
            <div className="small nc">
              {wave.neighbors} neighbors sent · {wave.escalated} escalated to responders · by Nemotron, no one clicking
            </div>
            <div className="small nc muted">Harvey, 2017: high-water rescue waits passed 20 hours (Houston Chronicle review of 120,000 911 calls).</div>
          </div>
        )}
        <div className="rhead">
          <button onClick={() => setOpen(!open)} aria-expanded={open}>
            Incident reports · {reports.length} <span>{open ? '−' : '+'}</span>
          </button>
          {reports.length > 0 && <button className="rview" onClick={() => setViewing(reports[0].id)}>View all</button>}
        </div>
        {open && (
          <ol className="log">
            {reports.slice(0, 8).map((r) => (
              <li key={r.id} className="nc">
                <button className="ritem" onClick={() => setViewing(r.id)} title="Open this report">
                  <time>{fmtTime(r.at)}</time>
                  <b style={{ color: STATUS_COLOR.p1 }}>{r.p1} P1</b> · <b style={{ color: STATUS_COLOR.p2 }}>{r.p2} P2</b> · {r.unknown} unknown
                  <div className="rclip">{r.summary}</div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      {viewing && <ReportsDialog startId={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function ReportsDialog({ startId, onClose }: { startId: string; onClose: () => void }) {
  const reports = useMap((s) => s.reports);
  // Scroll to the clicked report once; live updates don't move the reader.
  useEffect(() => {
    document.getElementById(`report-${startId}`)?.scrollIntoView({ block: 'start' });
    document.getElementById('reports-close')?.focus();
  }, [startId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="irep-back" onClick={onClose}>
      <div className="panel irep" role="dialog" aria-modal="true" aria-labelledby="reports-title" onClick={(e) => e.stopPropagation()}>
        <header className="irep-head">
          <h2 id="reports-title">Incident reports · {reports.length}</h2>
          <button id="reports-close" className="btn" onClick={onClose}>Close ✕</button>
        </header>
        <ol className="irep-list">
          {reports.map((r) => (
            <li key={r.id} id={`report-${r.id}`} className={r.id === startId ? 'on' : undefined}>
              <div className="irep-meta">
                <time>{fmtTime(r.at)}</time>
                <span style={{ color: STATUS_COLOR.p1 }}>{r.p1} P1</span>
                <span style={{ color: STATUS_COLOR.p2 }}>{r.p2} P2</span>
                <span style={{ color: STATUS_COLOR.unknown }}>{r.unknown} unknown</span>
              </div>
              <p>{r.summary}</p>
              {hasBlocked(r.blockedRoads) && <p className="irep-blocked">Blocked roads: {r.blockedRoads}</p>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function HouseIcon({ dark }: { dark: boolean }) {
  return (
    <svg width="34" height="34" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M1 5h8v5H1z" fill="#d4cfc4" />
      <path d="M0 5L5 1l5 4z" fill="#e8283d" />
      <path d="M2 6h2v2H2zM6 6h2v2H6z" fill={dark ? '#2a2f44' : '#ffd27a'} />
      <path d="M4 7h2v3H4z" fill="#3a2f2a" />
    </svg>
  );
}

const CODE: Record<string, string> = { p1: 'P1', p2: 'P2', unknown: '?', enroute: '→', safe: '✓', normal: '—' };
const LANG: Record<string, string> = { es: 'Speaks Spanish', vi: 'Speaks Vietnamese' };
const STEP_LABEL: Record<string, string> = { thought: 'thought', tool_call: 'tool call', tool_result: 'result', decision: 'decision' };
const ASSIGN_LABEL: Record<string, string> = { offered: 'Offered', accepted: 'Accepted', declined: 'Declined', timed_out: 'Timed out', done: 'Done' };
const ASSIGN_COLOR: Record<string, string> = { offered: STATUS_COLOR.unknown, accepted: STATUS_COLOR.enroute, declined: STATUS_COLOR.p2, timed_out: STATUS_COLOR.p1, done: STATUS_COLOR.safe };

/** Every agent step for one household, full text, live: thoughts, tool calls, results, decisions. */
function ReasoningModal({ r, status, onClose }: { r: Resident; status: Status; onClose: () => void }) {
  const end = useRef<HTMLLIElement>(null);
  const [filter, setFilter] = useState<'all' | 'decision'>('all');
  useEffect(() => {
    // Capture phase so Escape closes the pop-up, not the household card behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const steps = filter === 'all' ? r.reasoning : r.reasoning.filter((e) => e.kind === 'decision');
  // Block body on purpose: newer Chrome returns a Promise from scrollIntoView, and React would
  // treat any returned value as a cleanup function and crash calling it.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [steps.length]);
  const agents = [...new Set(r.reasoning.map((e) => agentName(e.agent)))];
  return createPortal(
    <div className="rmodal-back" onClick={onClose}>
      <section className="panel rmodal" role="dialog" aria-modal="true" aria-label={`Nemotron reasoning for ${r.name}`} onClick={(e) => e.stopPropagation()}>
        <header className="rmodal-head">
          <div style={{ minWidth: 0 }}>
            <div className="label">
              <span className="tag" style={{ background: STATUS_COLOR[status] }}>{CODE[status]}</span> Nemotron reasoning · live
            </div>
            <div className="name nc">{r.name}, {r.age} · {r.address}</div>
            <div className="sub nc">{agents.join(' → ')} · {r.reasoning.length} steps</div>
          </div>
          <button className="esc" onClick={onClose} aria-label="Close reasoning">ESC</button>
        </header>
        {r.triage && (
          <div className="rmodal-sum nc">
            <b style={{ color: r.triage.urgency >= 4 ? STATUS_COLOR.p1 : STATUS_COLOR.p2 }}>Urgency {r.triage.urgency}/5</b> · {r.triage.priority} · needs {r.triage.needs} · conf{' '}
            {r.triage.confidence.toFixed(2)}
            <div>{r.triage.reason}</div>
          </div>
        )}
        <div className="rmodal-tabs">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>Every step</button>
          <button className={filter === 'decision' ? 'on' : ''} onClick={() => setFilter('decision')}>Decisions only</button>
        </div>
        <ol className="rmodal-steps">
          {steps.length === 0 && <li className="nc">No steps yet.</li>}
          {steps.map((e, i) => (
            <li key={i} className={`nc k-${e.kind}`} ref={i === steps.length - 1 ? end : undefined}>
              <div className="meta">
                <time>{fmtTime(e.at)}</time>
                <span className="who">{agentName(e.agent)}</span>
                <span className={`kind k-${e.kind}`}>{STEP_LABEL[e.kind] ?? e.kind}</span>
                {e.conf !== null && <span className="conf">conf {e.conf.toFixed(2)}</span>}
              </div>
              <div className="body">{e.full ?? e.text}</div>
            </li>
          ))}
        </ol>
      </section>
    </div>,
    document.body,
  );
}

export function HouseholdCard() {
  const id = useMap((s) => s.selectedId);
  const residents = useMap((s) => s.residents);
  const statuses = useMap((s) => s.statuses);
  const select = useMap((s) => s.select);
  const now = useNow();
  const [note, setNote] = useState('');
  const [showReasoning, setShowReasoning] = useState(false);
  const viewer = useMap((s) => s.liveInfo.viewer);
  const p = id === null ? undefined : homes.find((h) => h.id === id);
  const r = p ? residents[p.idx] : null;
  // A P1 household opens its reasoning by itself, once per selection, as soon as there is any.
  const autoFor = useRef<number | null>(null);
  const isP1 = !!p && statuses[p.idx] === 'p1';
  const hasReasoning = !!r && r.reasoning.length > 0;
  useEffect(() => {
    setNote('');
    setShowReasoning(false);
    autoFor.current = null;
  }, [id]);
  useEffect(() => {
    if (id !== null && isP1 && hasReasoning && autoFor.current !== id) {
      autoFor.current = id;
      setShowReasoning(true);
    }
  }, [id, isP1, hasReasoning]);
  if (!p) return null;

  if (!r) {
    return (
      <section className="panel card" aria-live="polite" aria-label={`Home ${p.id}`}>
        <button className="esc" onClick={() => select(null)} aria-label="Close and zoom out">ESC</button>
        <div className="head">
          <div className="avatar"><div><HouseIcon dark={false} /></div></div>
          <div style={{ minWidth: 0 }}>
            <div className="name">#{p.id} · {COMMS[p.comm].name}</div>
            <div className="sub">No registered household here yet.</div>
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => select(null)}>← City</button>
        </div>
      </section>
    );
  }

  const s = statuses[p.idx];
  const gap = r.lastSeen ? Math.max(0, Math.round((now - r.lastSeen) / 60_000)) : null;
  const reason =
    s === 'p1' ? 'P1 · help now' :
    s === 'p2' ? 'silent risk' :
    s === 'unknown' ? (gap === null ? 'no contact yet' : `no contact ${gap} min`) :
    s === 'enroute' ? `${r.helper ?? 'a neighbor'} on the way` :
    s === 'safe' ? (r.lastContactVia ? `via ${r.lastContactVia}` : 'checked in') :
    'not exposed';
  const flags = [
    r.age >= 75 && 'Age 75+',
    r.alone && 'Lives alone',
    r.device && 'Powered device',
    r.mobility !== 'ok' && (r.mobility === 'cannot_walk' ? 'Cannot walk' : 'Limited mobility'),
    !r.smart && 'No smartphone',
    LANG[r.language],
    r.medical && r.medical,
  ].filter(Boolean) as string[];
  const netSafe = r.net.filter((n) => n.status === 'safe' || n.status === 'normal').length;
  // What Nemotron already chose for this household (it acts on its own; the buttons are overrides).
  const live = r.assignment && (r.assignment.state === 'offered' || r.assignment.state === 'accepted');
  const pick: ActionKind | null =
    r.escalated ? 'escalate' :
    live ? 'send_neighbor' :
    r.triage ? (r.triage.needs === 'professional' ? 'escalate' : 'send_neighbor') :
    s === 'unknown' || s === 'p2' ? 'call' :
    null;
  const pickText =
    r.escalated ? `Escalated to professional responders${live ? `, and ${r.assignment!.helper} is ${r.assignment!.state === 'accepted' ? 'on the way' : 'offered the visit'}` : ''}.` :
    live ? `Sent ${r.assignment!.helper} (ring ${r.assignment!.ring}) to check on them.` :
    r.triage ? `Triaged ${r.triage.priority}; next step: ${r.triage.needs === 'professional' ? 'escalate to responders' : 'send a neighbor'}.` :
    pick === 'call' ? 'No contact yet: the silent-signal agent will call or ask a neighbor to knock.' :
    null;
  const pending = r.actions.find((a) => a.state === 'pending');
  const latest = r.actions[0];
  const ACT_LABEL: Record<ActionKind, string> = {
    respond: 'Nemotron response',
    call: 'Check-in call',
    escalate: 'Escalation',
    send_neighbor: 'Neighbor dispatch',
    claim_timeline: 'Claim timeline',
  };
  const act = async (k: ActionKind) => {
    if (viewer) return setNote('Staff sign-in required to send the agents.');
    setNote(`${ACT_LABEL[k]}: sent to the agents…`);
    try {
      await requestAction(r, k);
    } catch (e) {
      setNote(`Could not send: ${(e as Error).message}`);
    }
  };
  const btn = (k: ActionKind, label: string, sub: string, cls = 'btn') => (
    <button
      className={`${cls}${pick === k ? ' picked' : ''}`}
      disabled={viewer || !!pending}
      title={viewer ? 'Staff sign-in required' : pick === k ? "Nemotron's pick" : undefined}
      onClick={() => act(k)}
    >
      {label}
      <small>{pick === k ? "Nemotron's pick" : sub}</small>
    </button>
  );

  return (
    <section className="panel card" aria-live="polite" aria-label={`Household ${r.householdId}`}>
      <button className="esc" onClick={() => select(null)} aria-label="Close and zoom out">ESC</button>
      <div className="head">
        <div className="avatar"><div><HouseIcon dark={r.powerOut} /></div></div>
        <div style={{ minWidth: 0 }}>
          <span className="chip"><i style={{ background: p.danger ? 'var(--brand)' : 'var(--safe)' }} />{p.danger ? 'Near the river' : 'Away from river'}</span>
          <div className="name" style={{ marginTop: 6 }}><span className="nc">{r.name}</span>, {r.age}{r.people > 1 ? ` · ${r.people} people` : ''}</div>
          <div className="sub nc">{r.address} · {r.neighborhood}</div>
        </div>
      </div>
      <div className="lvl">
        <div className="code" style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>{CODE[s]}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">{STATUS_LABEL[s]} <span className="tag" style={{ background: STATUS_COLOR[s] }}>{reason}</span></div>
          <div className="bar"><i style={{ width: `${Math.min(100, r.priorityScore)}%` }} /></div>
          <div className="barcap">Priority {r.priority} · score {r.priorityScore.toFixed(0)} (set by the agents)</div>
        </div>
      </div>
      {flags.length > 0 && (
        <div className="sect flags">
          {flags.map((f) => (
            <span className="flag" key={f}><i />{f}</span>
          ))}
        </div>
      )}
      {r.triage && (
        <div className="sect">
          <div className="label">Nemotron triage · {fmtTime(r.triage.at)}</div>
          <div className="triage nc">
            <b style={{ color: r.triage.urgency >= 4 ? STATUS_COLOR.p1 : r.triage.urgency >= 3 ? STATUS_COLOR.p2 : STATUS_COLOR.unknown }}>
              Urgency {r.triage.urgency}/5
            </b>
            {' · '}{r.triage.priority} · needs {r.triage.needs}
            <span className="conf"> conf {r.triage.confidence.toFixed(2)}</span>
            <div>{r.triage.reason}</div>
            <div className="muted">{r.triage.model}</div>
          </div>
        </div>
      )}
      {pickText && (
        <div className="sect">
          <div className="label">Nemotron's call</div>
          <div className="triage nc pick">{pickText}</div>
        </div>
      )}
      {(pending || latest) && (
        <div className="sect">
          <div className="label">Agents · {ACT_LABEL[(pending ?? latest)!.action]} · {fmtTime((pending ?? latest)!.at)}</div>
          <div className="triage nc">
            {pending ? (
              <span className="muted">Nemotron is working on it…</span>
            ) : (
              <span style={{ color: latest!.state === 'failed' ? STATUS_COLOR.p1 : undefined }}>
                {latest!.action === 'claim_timeline' ? 'Timeline ready below.' : latest!.result}
              </span>
            )}
          </div>
        </div>
      )}
      {r.claimTimeline && (
        <div className="sect">
          <div className="label">Claim timeline · Nemotron · {fmtTime(r.claimTimeline.at)}</div>
          <pre className="timeline nc">{r.claimTimeline.text.replace(/^Claim timeline:\s*/, '')}</pre>
        </div>
      )}
      {(r.assignment || r.keyPass) && (
        <div className="sect">
          <div className="label">Response</div>
          <div className="triage nc">
            {r.assignment && (
              <div>
                <b style={{ color: ASSIGN_COLOR[r.assignment.state] ?? 'var(--warm)' }}>{ASSIGN_LABEL[r.assignment.state] ?? r.assignment.state}</b>
                {' · '}{r.assignment.helper} (ring {r.assignment.ring}) · {fmtTime(r.assignment.at)}
              </div>
            )}
            {r.keyPass && (
              <div>
                Key pass to {r.keyPass.helper} ·{' '}
                {r.keyPass.revoked ? 'revoked' : r.keyPass.expiresAt < now ? 'expired' : `until ${fmtTime(r.keyPass.expiresAt)}`}
                {' · '}approved by {r.keyPass.approvedBy}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="sect grid3">
        <div className="cell"><b style={{ color: r.powerOut ? STATUS_COLOR.p1 : STATUS_COLOR.safe }}>{r.powerOut ? 'OUT' : 'ON'}</b><span>Power</span></div>
        <div className="cell"><b>{gap === null ? '—' : `${gap}m`}</b><span>Since contact</span></div>
        <div className="cell"><b>{p.riverKm}km</b><span>To river</span></div>
        <div className="cell"><b>{r.age}</b><span>Age</span></div>
        <div className="cell"><b>{netSafe}/{r.net.length || 0}</b><span>Net safe</span></div>
        <div className="cell"><b className="nc" style={{ fontSize: 11 }}>{r.lastContactVia ?? '—'}</b><span>Channel</span></div>
      </div>
      <div className="sect">
        <div className="label">Safety net · arcs on the map</div>
        <div className="net">
          {r.net.length === 0 && <div className="nc">No safety net registered.</div>}
          {r.net.map((n, i) => (
            <div key={i}>
              <span className="sq" style={{ background: STATUS_COLOR[n.status] }} />
              <span className="nc">{n.name}</span>
              <small>{STATUS_LABEL[n.status]}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="sect">
        <div className="label loghead">
          {`Agent log · ${r.log.length}`}
          {r.reasoning.length > 0 && (
            <button className="linkbtn" onClick={() => setShowReasoning(true)} aria-haspopup="dialog">
              Show reasoning · {r.reasoning.length}
            </button>
          )}
          {r.members[0] && (
            <a className="linkbtn" href={traceHref(r.members[0].id.toString())} title="This case hop by hop: which agent called which tool">
              Open trace
            </a>
          )}
        </div>
        <ol className="log">
          {r.log.length === 0 && <li className="nc">No events yet for this household.</li>}
          {r.log.map((e, i) => (
            <li key={i} className={`nc k-${e.kind}`}>
              <time>{fmtTime(e.at)}</time>
              {agentName(e.agent)}: {e.text}
              {e.conf !== null && <span className="conf"> conf {e.conf.toFixed(2)}</span>}
            </li>
          ))}
        </ol>
      </div>
      {showReasoning && <ReasoningModal r={r} status={s} onClose={() => setShowReasoning(false)} />}
      <div className="actions">
        {btn('respond', 'Let Nemotron decide', 'triage + dispatch', 'btn primary')}
        {btn('call', 'Call now', 'automated voice', 'btn warm')}
        {btn('escalate', 'Escalate', 'to responders', 'btn danger')}
        {btn('send_neighbor', 'Send neighbor', 'safety net, ring by ring')}
        {btn('claim_timeline', 'Claim timeline', 'Nemotron writes it')}
        <button className="btn" onClick={() => select(null)}>← City</button>
        <button
          className="btn"
          disabled={viewer || !r.members.some((m) => m.status !== 'safe' && m.status !== 'normal')}
          title={viewer ? 'Staff sign-in required' : undefined}
          onClick={async () => {
            setNote('Marking safe…');
            try {
              await markHouseholdSafe(r);
              setNote('Marked safe. The beam turns green when the database confirms it.');
            } catch (e) {
              setNote(`Could not mark safe: ${(e as Error).message}`);
            }
          }}
        >
          Mark safe<small>{viewer ? 'staff only' : 'writes to the database'}</small>
        </button>
      </div>
      <p className="actnote nc">
        {note ||
          (viewer
            ? 'Read-only view. Nemotron acts on its own; staff can send it from these buttons.'
            : 'Nemotron acts on its own. These buttons send the agents now; real texts and calls go out.')}
      </p>
    </section>
  );
}

export function BackButton() {
  const id = useMap((s) => s.selectedId);
  const select = useMap((s) => s.select);
  if (id === null) return null;
  return (
    <button className="panel back" onClick={() => select(null)}>
      <b>ESC</b>Back to city
    </button>
  );
}

export function Finale() {
  const show = useMap((s) => s.finale);
  const setFinale = useMap((s) => s.setFinale);
  if (!show) return null;
  return (
    <div className="finale" role="dialog" aria-label="Everyone reached">
      <div>
        <div className="zero">0</div>
        <div className="zl">People not yet reached</div>
        <div className="zs nc">Every exposed household was reached by {fmtTime(Date.now())}. Neighbors made most of the checks.</div>
        <Wordmark />
        <div className="tagline">Your neighbors are the first line</div>
        <button className="btn" onClick={() => setFinale(false)}>Back to map</button>
      </div>
    </div>
  );
}

// Small sign-in: access to the system is a staff identity. Paste a staff access key, or ask an admin
// to grant this browser's ID. Anyone already granted goes straight in.
export function SignIn() {
  const info = useMap((s) => s.liveInfo);
  const signedIn = useMap((s) => s.signedIn);
  const setSignedIn = useMap((s) => s.setSignedIn);
  const wantStaff = useMap((s) => s.wantStaff);
  const setWantStaff = useMap((s) => s.setWantStaff);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const hasAccess = info.state === 'subscribed' && info.people > 0;
  // Anyone who can read goes straight in, unless a viewer opened this screen to sign in as staff.
  useEffect(() => {
    if (hasAccess && !signedIn && !(info.viewer && wantStaff)) setSignedIn(true);
  }, [hasAccess, signedIn, info.viewer, wantStaff]);
  if (signedIn) return null;
  const id = info.identity ? `0x${info.identity}` : '';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('Signing in…');
    const ok = await signIn(key);
    setBusy(false);
    setKey('');
    if (ok) {
      setWantStaff(false);
      setSignedIn(true);
    }
    else setMsg(useMap.getState().liveInfo.people === 0 && useMap.getState().liveInfo.identity ? 'That key is not staff, or was not accepted. Check it, or ask an admin to grant it.' : 'That key was not accepted. Check it and try again.');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="signin" role="dialog" aria-label="Sign in">
      <form className="panel signbox" onSubmit={submit}>
        <Wordmark />
        <div className="label">Operator sign-in</div>
        <p className="signline nc">Household data is visible to staff only. Sign in with your staff access key.</p>
        <label className="label" htmlFor="signin-key">Access key</label>
        <input id="signin-key" className="signinput nc" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" />
        <button className="btn primary" type="submit" disabled={busy || !key.trim()}>Sign in</button>
        {msg && <p className="signmsg nc">{msg}</p>}
        <div className="signsep" />
        <div className="label">No key yet?</div>
        <p className="signline nc">Ask an admin to grant this browser. It is ready to use as soon as they do.</p>
        <div className="signid">
          <code className="nc">{id || (info.state === 'error' ? 'not connected' : 'connecting…')}</code>
          {id && <button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy ID'}</button>}
        </div>
        <p className="signline small nc">Admin runs: spacetime call firstline add_staff '"{id || '<this ID>'}"'</p>
        <button type="button" className="skip" onClick={() => { setWantStaff(false); setSignedIn(true); }}>
          {info.viewer ? 'Back to the map (read-only)' : 'Look around without data'}
        </button>
      </form>
    </div>
  );
}
