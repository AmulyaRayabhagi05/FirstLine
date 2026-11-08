import { useEffect, useMemo, useState } from 'react';
import { COMMS, allEvents, fmtClock, gapMin, homes, lastSafeTime, powerOut, statusAt, type Home, type Resident } from '../sim/world';
import { useMap, counts, isKeyDecision, STATUS_COLOR, STATUS_LABEL } from '../state/store';
import { LIVE_DB, clearFlood, markHouseholdSafe, startFlood } from '../data/live';

export function Wordmark() {
  return (
    <div className="wordmark">
      <i />
      FIRSTLINE
    </div>
  );
}

// Compact top-left badge: the one number that matters, the clock, and a thin status breakdown.
export function CounterBadge() {
  const T = useMap((s) => s.T);
  const statuses = useMap((s) => s.statuses);
  const mode = useMap((s) => s.mode);
  const info = useMap((s) => s.liveInfo);
  const c = counts(statuses);
  if (mode === 'live') {
    const homesAtRisk = c.p1 + c.p2 + c.unknown;
    return (
      <section className="panel badge" aria-label="City overview">
        <Wordmark />
        <div className="counter">
          <div className={`big ${homesAtRisk === 0 ? 'zero' : ''}`}>{homesAtRisk}</div>
          <div className="cap">
            {homesAtRisk === 0 ? 'All households safe' : 'Households need help'}
            <span className="clock">{info.people.toLocaleString()} people</span>
          </div>
        </div>
        <div className="mix">
          <span style={{ color: STATUS_COLOR.safe }}>{(c.safe + c.normal).toLocaleString()} safe</span>
          <span style={{ color: STATUS_COLOR.enroute }}>{c.enroute} help on the way</span>
          <span style={{ color: STATUS_COLOR.p1 }}>{c.p1 + c.p2 + c.unknown} need help</span>
        </div>
      </section>
    );
  }
  return (
    <section className="panel badge" aria-label="Storm overview">
      <Wordmark />
      <div className="counter">
        <div className={`big ${c.unreached === 0 && T > 1 ? 'zero' : ''}`}>{c.unreached}</div>
        <div className="cap">
          Not yet reached
          <span className="clock">{fmtClock(T)}</span>
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

// One line at the top for decisions a person should know about. It fades after a few seconds.
export function DecisionTicker() {
  const mode = useMap((s) => s.mode);
  return mode === 'live' ? <LiveTicker /> : <SimTicker />;
}

function LiveTicker() {
  const decisions = useMap((s) => s.decisions);
  const latest = decisions[decisions.length - 1];
  const [visible, setVisible] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (!latest || latest.id === seen) return;
    const fresh = Date.now() - latest.when.getTime() < 60_000;
    setSeen(latest.id);
    if (!fresh) return;
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(id);
  }, [latest?.id]);
  if (!latest) return null;
  return (
    <div className={`panel ticker ${visible ? 'on' : ''}`} role="status">
      <span className="who">Nemotron · {latest.agent}</span>
      <span className="nc">
        {latest.text}
        {latest.conf !== null && <span className="conf"> ({latest.conf.toFixed(2)})</span>}
      </span>
    </div>
  );
}

function SimTicker() {
  const T = useMap((s) => s.T);
  const latest = useMemo(() => {
    const list = allEvents.filter((e) => e.t <= T && isKeyDecision(e));
    return list[list.length - 1];
  }, [T]);
  const [shown, setShown] = useState<(typeof allEvents)[number] | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!latest || latest === shown || T - latest.t > 0.25) return;
    setShown(latest);
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 4200);
    return () => clearTimeout(id);
  }, [latest]);
  if (!shown) return null;
  return (
    <div className={`panel ticker ${visible ? 'on' : ''}`} role="status">
      <span className="who">Nemotron · {shown.agent.split(' · ')[0]}</span>
      <span className="nc">
        #{shown.home.id} {COMMS[shown.home.comm].name}: {shown.text}
        {shown.conf && <span className="conf"> ({shown.conf})</span>}
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
      {s.mode === 'sim' && <button className="panel tbtn red" onClick={startDemo} aria-pressed={demoOn}>{demoOn ? '■ Stop' : '▶ Replay'}</button>}
      {s.layersOpen && (
        <section className="panel layers" aria-label="Layers and legend">
          <div className="slide">
            <div className="label">2D map ↔ 3D city</div>
            <input type="range" min={0} max={1} step={0.001} value={s.dimTarget} aria-label="Slide between the 2D map and the 3D city" onChange={(e) => s.setDim(+e.target.value)} />
          </div>
          <div className="toggles">
            <label className="toggle"><input type="checkbox" checked={s.showBeams} onChange={() => s.toggle('showBeams')} /> Porch beams</label>
            <label className="toggle"><input type="checkbox" checked={s.showZone} onChange={() => s.toggle('showZone')} /> Flood danger zone</label>
            <label className="toggle"><input type="checkbox" checked={s.showNames} onChange={() => s.toggle('showNames')} /> Community names</label>
          </div>
          <div className="legend" aria-label="Legend">
            {([
              ['safe', '✓', 'Safe', 'short green beam'],
              ['p1', '!', 'Needs help', 'tall red beam, pulsing'],
              ['enroute', '→', 'Help on the way', 'blue beam'],
            ] as const).map(([k, g, t, d]) => (
              <div key={k}><span className="sq" style={{ background: STATUS_COLOR[k] }}>{g}</span>{t}<small>{d}</small></div>
            ))}
          </div>
          <div className="source">Data: {s.mode === 'sim' ? 'simulated replay' : `live · SpacetimeDB ${LIVE_DB}`}</div>
        </section>
      )}
    </div>
  );
}

// Opening sequence: one idea per screen over the slowly turning city, then the map.
const STEPS = [
  { kicker: 'Winter Storm Uri · Texas · 2021', big: '246', line: 'people died. Most were 60 or older. Many were alone, with neighbors next door who never knew.' },
  { kicker: 'The first hours', big: '', line: 'When 911 is overwhelmed, the people who reach you first are your neighbors.' },
  { kicker: 'FirstLine', big: '', line: 'Every household gets a safety net of neighbors. AI finds who needs help most, including people who never ask.' },
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
  const mode = useMap.getState().mode;
  const enter = (demo: boolean) => {
    setIntro(false);
    const st = useMap.getState();
    if (st.mode === 'live') return;
    if (demo) {
      st.setT(0);
      st.setDim(1);
      st.setDemo('sweep');
    } else st.setT(2.2);
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
          {last && mode === 'live' && <button className="btn primary" onClick={() => enter(false)}>Open the live map</button>}
          {last && mode === 'sim' && <button className="btn primary" onClick={() => enter(false)}>Explore the map</button>}
          {last && mode === 'sim' && <button className="btn" onClick={() => enter(true)}>Replay a flood night</button>}
        </div>
        <button className="skip" onClick={() => enter(false)}>Skip intro</button>
      </div>
    </div>
  );
}

// Live mode: connection state, and the two demo controls for a flood (they write to the database).
export function LiveBar() {
  const conn = useMap((s) => s.conn);
  const err = useMap((s) => s.connError);
  const info = useMap((s) => s.liveInfo);
  const useSim = useMap((s) => s.useSim);
  const statuses = useMap((s) => s.statuses);
  const [busy, setBusy] = useState<string>('');
  const [confirm, setConfirm] = useState<'flood' | 'clear' | null>(null);
  const atRisk = statuses.filter((s) => s === 'p1' || s === 'p2' || s === 'unknown' || s === 'enroute').length;
  const run = async (kind: 'flood' | 'clear') => {
    setConfirm(null);
    try {
      const n = kind === 'flood'
        ? await startFlood((d, t) => setBusy(`Flooding… ${d}/${t}`))
        : await clearFlood((d, t) => setBusy(`Marking safe… ${d}/${t}`));
      setBusy(n ? '' : kind === 'flood' ? 'No safe households in the flood zone' : 'Nobody needs help');
    } catch (e) {
      setBusy(`Failed: ${(e as Error).message}`);
    }
  };
  return (
    <section className="panel timeline livebar" aria-label="Live status">
      <div className={`dot ${conn}`} aria-hidden="true" />
      <div className="lb-main">
        <div className="lb-title">
          {conn === 'live' ? 'Live' : conn === 'connecting' ? 'Connecting…' : 'Offline'} · SpacetimeDB {LIVE_DB}
        </div>
        <div className="lb-sub nc">
          {conn === 'error'
            ? err || 'Could not reach the database.'
            : busy || (info.updatedAt ? `${info.households.toLocaleString()} households · updated ${info.updatedAt.toLocaleTimeString()}` : 'Waiting for data…')}
        </div>
      </div>
      {conn === 'live' && confirm === null && (
        <div className="lb-actions">
          <button className="btn danger" onClick={() => setConfirm('flood')}>Start flood</button>
          <button className="btn" disabled={atRisk === 0} onClick={() => setConfirm('clear')}>Clear flood</button>
        </div>
      )}
      {confirm && (
        <div className="lb-actions">
          <span className="lb-q nc">{confirm === 'flood' ? 'Flood the zone? Residents there report needing help.' : 'Mark everyone who needs help as safe?'}</span>
          <button className="btn danger" onClick={() => run(confirm)}>Yes</button>
          <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {conn === 'error' && (
        <div className="lb-actions">
          <button className="btn" onClick={useSim}>Use simulated data</button>
        </div>
      )}
    </section>
  );
}

export function Timeline() {
  const T = useMap((s) => s.T);
  const playing = useMap((s) => s.playing);
  const setT = useMap((s) => s.setT);
  const setPlaying = useMap((s) => s.setPlaying);
  const setDemo = useMap((s) => s.setDemo);
  return (
    <section className="panel timeline" aria-label="Storm replay">
      <button className="play" aria-label={playing ? 'Pause replay' : 'Play replay'} onClick={() => { setDemo('off'); setPlaying(!playing); }}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div>
        <input type="range" min={0} max={8} step={0.01} value={T} aria-label="Replay time" onChange={(e) => { setDemo('off'); setT(+e.target.value); }} />
        <div className="ticks"><span>22:00</span><span><b>22:30 flood</b></span><span>00:00</span><span>02:00</span><span>04:00</span><span>06:00</span></div>
      </div>
    </section>
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

export function HouseholdCard() {
  const mode = useMap((s) => s.mode);
  return mode === 'live' ? <LiveCard /> : <SimCard />;
}

const LANG: Record<string, string> = { en: 'English', es: 'Spanish', vi: 'Vietnamese' };
// What a responder needs to know about one person, at a glance. "risk" tags drive the priority score.
function profileTags(r: Resident) {
  const tags: { text: string; kind: 'risk' | 'info' }[] = [];
  if (r.age >= 75) tags.push({ text: `Age ${r.age}`, kind: 'risk' });
  if (r.mobility === 'cannot_walk') tags.push({ text: 'Cannot walk', kind: 'risk' });
  else if (r.mobility === 'limited') tags.push({ text: 'Limited mobility', kind: 'risk' });
  for (const m of r.medical.split(',').map((s) => s.trim()).filter(Boolean)) tags.push({ text: m[0].toUpperCase() + m.slice(1), kind: 'risk' });
  if (r.poweredDevice) tags.push({ text: 'Powered device', kind: 'risk' });
  if (r.livesAlone) tags.push({ text: 'Lives alone', kind: 'risk' });
  if (!r.phone) tags.push({ text: 'No smartphone', kind: 'risk' });
  if (r.language && r.language !== 'en') tags.push({ text: LANG[r.language] ?? r.language, kind: 'info' });
  if (!tags.length) tags.push({ text: 'No risk factors', kind: 'info' });
  return tags;
}

function LiveCard() {
  const id = useMap((s) => s.selectedId);
  const statuses = useMap((s) => s.statuses);
  useMap((s) => s.version);
  const select = useMap((s) => s.select);
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [id]);
  const p: Home | undefined = id === null ? undefined : homes.find((h) => h.id === id);
  if (!p) return null;
  const s = statuses[p.idx] ?? 'normal';
  const rs = p.residents ?? [];
  const needs = rs.some((r) => r.status !== 'safe' && r.status !== 'normal');
  const lastSeen = rs.map((r) => r.lastSeen?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const mins = lastSeen ? Math.round((Date.now() - lastSeen) / 60000) : null;
  const flags = [p.age >= 75 && 'Age 75+', p.alone && 'Lives alone', p.device && 'Powered device', p.mobility && 'Limited mobility', !p.smart && 'No smartphone', p.spanish && 'Speaks Spanish'].filter(Boolean) as string[];
  const netSafe = p.net.filter((n) => ['safe', 'normal'].includes(statuses[n.idx] ?? 'normal')).length;
  const safe = async () => {
    setNote('Marking safe…');
    try {
      await markHouseholdSafe(p, 'confirmed safe from the map');
      setNote('Marked safe. The beam turns green when the database confirms it.');
    } catch (e) {
      setNote(`Could not mark safe: ${(e as Error).message}`);
    }
  };
  return (
    <section className="panel card" aria-live="polite" aria-label={`Household ${p.id}`}>
      <button className="esc" onClick={() => select(null)} aria-label="Close and zoom out">ESC</button>
      <div className="head">
        <div className="avatar"><div><HouseIcon dark={needs && p.danger} /></div></div>
        <div style={{ minWidth: 0 }}>
          <span className="chip"><i style={{ background: p.danger ? 'var(--brand)' : 'var(--safe)' }} />{p.danger ? 'Flood zone' : 'Outside flood zone'}</span>
          <div className="name" style={{ marginTop: 6 }}>Household #{p.id}</div>
          <div className="sub">{rs.length} {rs.length === 1 ? 'resident' : 'residents'}</div>
        </div>
      </div>
      <div className="lvl">
        <div className="code" style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>{CODE[s]}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">{STATUS_LABEL[s]}</div>
          <div className="bar"><i style={{ width: `${Math.min(100, p.vuln)}%` }} /></div>
          <div className="barcap">Priority score {p.vuln} · from the agent worker</div>
        </div>
      </div>
      {flags.length > 0 && (
        <div className="sect flags">{flags.map((f) => <span className="flag" key={f}><i />{f}</span>)}</div>
      )}
      <div className="sect grid3">
        <div className="cell"><b>{rs.length}</b><span>Residents</span></div>
        <div className="cell"><b>{mins === null ? '—' : mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`}</b><span>Last contact</span></div>
        <div className="cell"><b>{netSafe}/{p.net.length}</b><span>Net safe</span></div>
      </div>
      <div className="sect">
        <div className="label">Residents</div>
        <div className="people">
          {rs.map((r) => (
            <div className="person" key={r.id}>
              <div className="prow">
                <span className="sq" style={{ background: STATUS_COLOR[r.status] }} />
                <span className="nc pname">{r.name}, {r.age}</span>
                <small>{STATUS_LABEL[r.status]}</small>
              </div>
              <div className="ptags">{profileTags(r).map((t) => <span key={t.text} className={`ptag ${t.kind}`}>{t.text}</span>)}</div>
            </div>
          ))}
        </div>
      </div>
      {p.net.length > 0 && (
        <div className="sect">
          <div className="label">Safety net · arcs on the map</div>
          <div className="net">
            {p.net.map((n) => {
              const ns = statuses[n.idx] ?? 'normal';
              return (
                <div key={n.id}>
                  <span className="sq" style={{ background: STATUS_COLOR[ns] }} />
                  <span><span className="nc">{n.name}</span> · #{n.id}</span>
                  <small>{STATUS_LABEL[ns]}</small>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="sect">
        <div className="label">What happened · {p.events.length}</div>
        <ol className="log">
          {p.events.length === 0 && <li className="nc">Nothing yet for this household.</li>}
          {p.events.map((e, i) => (
            <li key={i} className="nc">
              <time>{e.when}</time>
              {e.agent}: {e.text}
              {e.conf && <span className="conf"> conf {e.conf}</span>}
            </li>
          ))}
        </ol>
      </div>
      <div className="actions">
        <button className="btn primary" style={{ gridColumn: '1 / -1' }} disabled={!needs} onClick={safe}>Mark household safe</button>
        <button className="btn" onClick={() => select(null)}>← City</button>
        <button className="btn" onClick={() => setNote('Nemotron dispatch assigns helpers and escalates to responders; those actions come from the agent worker.')}>Who sends help?</button>
      </div>
      <p className="actnote nc">{note || 'Mark safe writes to the live database.'}</p>
    </section>
  );
}

function SimCard() {
  const id = useMap((s) => s.selectedId);
  const T = useMap((s) => s.T);
  const select = useMap((s) => s.select);
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [id]);
  const p: Home | undefined = id === null ? undefined : homes.find((h) => h.id === id);
  if (!p) return null;
  const s = statusAt(p, T);
  const gap = gapMin(p, T);
  const out = powerOut(p, T);
  const vuln = p.vuln;
  const exposure = (p.danger && T >= 0.5 ? 20 : 0) + (out ? 10 : 0);
  const contact = Math.min(30, Math.round(gap / 4));
  const score = vuln + exposure + contact;
  const past = p.events.filter((e) => e.t <= T);
  const lastSafe = past.filter((e) => e.status === 'safe').pop();
  const reason =
    s === 'p1' ? 'SOS received' : s === 'p2' || s === 'unknown' ? `no contact ${gap} min` : s === 'enroute' ? 'helper on the way' : s === 'safe' ? (lastSafe ? lastSafe.text.replace(/^checked in by /, 'via ') : 'checked in') : 'outside alert area';
  const flags = [p.age >= 75 && 'Age 75+', p.alone && 'Lives alone', p.device && 'Powered device', p.mobility && 'Limited mobility', !p.smart && 'No smartphone', p.spanish && 'Speaks Spanish'].filter(Boolean) as string[];
  const netSafe = p.net.filter((n) => statusAt(n, T) === 'safe' || statusAt(n, T) === 'normal').length;
  const channel = lastSafe ? lastSafe.text.replace(/^.*by |:.*$/g, '').slice(0, 10) : '—';
  const act = (k: string) =>
    setNote(
      {
        call: `Would call #${p.id}: "Press 1 if you're okay, 2 if you need help."`,
        escalate: `Would escalate #${p.id} to responders as P1, after one-click human approval.`,
        neighbor: `Would ask ${p.net[0]?.name ?? 'a neighbor'} (#${p.net[0]?.id ?? '—'}) to check on #${p.id}. A responder approves first.`,
        claim: `Would build #${p.id}'s night timeline (power out ${p.tHit ? fmtClock(p.tHit) : '—'}, contacts, photos) for a faster claim.`,
      }[k] ?? '',
    );

  return (
    <section className="panel card" aria-live="polite" aria-label={`Household ${p.id}`}>
      <button className="esc" onClick={() => select(null)} aria-label="Close and zoom out">ESC</button>
      <div className="head">
        <div className="avatar"><div><HouseIcon dark={out} /></div></div>
        <div style={{ minWidth: 0 }}>
          <span className="chip"><i style={{ background: p.danger ? 'var(--brand)' : 'var(--safe)' }} />{p.danger ? 'In flood zone' : 'Outside zone'}</span>
          <div className="name" style={{ marginTop: 6 }}>#{p.id} · <span className="nc">{p.name}</span>, {p.age}</div>
          <div className="sub">{COMMS[p.comm].name}</div>
        </div>
      </div>
      <div className="lvl">
        <div className="code" style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>{CODE[s]}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">{STATUS_LABEL[s]} <span className="tag" style={{ background: STATUS_COLOR[s] }}>{reason}</span></div>
          <div className="bar"><i style={{ width: `${Math.min(100, (score / 140) * 100)}%` }} /></div>
          <div className="barcap">Priority score {score} / 140 · vulnerability {vuln} · exposure {exposure} · contact gap {contact}</div>
        </div>
      </div>
      {flags.length > 0 && (
        <div className="sect flags">
          {flags.map((f) => (
            <span className="flag" key={f}><i />{f}</span>
          ))}
        </div>
      )}
      <div className="sect grid3">
        <div className="cell"><b style={{ color: out ? STATUS_COLOR.p1 : STATUS_COLOR.safe }}>{out ? 'OUT' : 'ON'}</b><span>Power</span></div>
        <div className="cell"><b>{gap ? `${gap}m` : '—'}</b><span>Since contact</span></div>
        <div className="cell"><b>{p.riverKm}km</b><span>To river</span></div>
        <div className="cell"><b>{p.age}</b><span>Age</span></div>
        <div className="cell"><b>{netSafe}/3</b><span>Net safe</span></div>
        <div className="cell"><b className="nc" style={{ fontSize: 11 }}>{channel}</b><span>Channel</span></div>
      </div>
      <div className="sect">
        <div className="label">Safety net · arcs on the map</div>
        <div className="net">
          {p.net.map((n) => {
            const ns = statusAt(n, T);
            return (
              <div key={n.id}>
                <span className="sq" style={{ background: STATUS_COLOR[ns] }} />
                <span><span className="nc">{n.name}</span>, #{n.id}</span>
                <small>{STATUS_LABEL[ns]}</small>
              </div>
            );
          })}
        </div>
      </div>
      <div className="sect">
        <div className="label">Agent log · {past.length}</div>
        <ol className="log">
          {past.length === 0 && <li className="nc">No events yet for this home.</li>}
          {past.map((e, i) => (
            <li key={i} className="nc">
              <time>{fmtClock(e.t)}</time>
              {e.agent}: {e.text}
              {e.conf && <span className="conf"> conf {e.conf}</span>}
            </li>
          ))}
        </ol>
      </div>
      <div className="actions">
        <button className="btn warm" onClick={() => act('call')}>Call now<small>Automated · free</small></button>
        <button className="btn danger" onClick={() => act('escalate')}>Escalate<small>P1 · needs approval</small></button>
        <button className="btn" onClick={() => act('claim')}>Claim timeline</button>
        <button className="btn" onClick={() => select(null)}>← City</button>
        <button className="btn primary" style={{ gridColumn: '1 / -1' }} onClick={() => act('neighbor')}>Send neighbor</button>
      </div>
      <p className="actnote nc">{note || 'Prototype: actions show the flow only. No calls or messages are sent.'}</p>
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
        <div className="zs nc">Every household in the flood zone was reached by {fmtClock(lastSafeTime)}. Neighbors made most of the checks.</div>
        <Wordmark />
        <div className="tagline">Your neighbors are the first line</div>
        <button className="btn" onClick={() => setFinale(false)}>Back to map</button>
      </div>
    </div>
  );
}
