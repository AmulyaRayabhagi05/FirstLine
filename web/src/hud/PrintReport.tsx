// Printable incident reports: one per household (person) and one per neighborhood area (H3 res-8
// cell). The sheet renders straight into <body>, is hidden on screen, and is the only thing the
// browser prints (see the @media print rules in styles.css). Built from the same live rows the map shows.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { homes, type Status } from '../sim/world';
import { useMap, STATUS_LABEL, type IncidentReport, type Resident } from '../state/store';
import { cellToParent, REPORT_RES } from '../data/h3';
import { directTo, mapsLink, SAFE_PLACES_SOURCE, type Directed, type Direction } from '../data/direct';

export type PrintJob = { kind: 'person'; homeIdx: number } | { kind: 'area'; reportId: string } | { kind: 'areas' };

const usePrint = create<{ job: PrintJob | null; set: (j: PrintJob | null) => void }>((set) => ({ job: null, set: (job) => set({ job }) }));

/** Open the browser's print dialog for one report (or every area report). */
export const printReport = (job: PrintJob) => usePrint.getState().set(job);

/** Incident reports are for Priority 1 cases only: the home shows P1, or someone in it is P1 and not yet safe. */
export const isP1Household = (r: Resident, status: Status) =>
  status === 'p1' || r.members.some((m) => m.priority === 'P1' && m.status !== 'safe' && m.status !== 'normal');

const RANK: Status[] = ['p1', 'p2', 'unknown', 'enroute', 'safe', 'normal'];
const rank = (s: Status) => RANK.indexOf(s);
const when = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const AGENT: Record<string, string> = { triage: 'Triage', dispatch: 'Dispatch', silent_signal: 'Silent signal', reports: 'Reports' };
const MOBILITY: Record<string, string> = { ok: 'Walks unaided', limited: 'Limited mobility', cannot_walk: 'Cannot walk' };
const LANG: Record<string, string> = { en: 'English', es: 'Spanish', vi: 'Vietnamese' };
const ASSIGN: Record<string, string> = { offered: 'Offered', accepted: 'Accepted, on the way', declined: 'Declined', timed_out: 'Timed out', done: 'Done' };

/** Every registered household with its H3 res-8 area. */
function householdsByArea(residents: (Resident | null)[]) {
  const m = new Map<string, { r: Resident; idx: number; status: Status }[]>();
  const statuses = useMap.getState().statuses;
  residents.forEach((r, idx) => {
    if (!r) return;
    const area = cellToParent(r.cell, REPORT_RES);
    if (!area) return;
    const arr = m.get(area) ?? [];
    arr.push({ r, idx, status: statuses[idx] });
    m.set(area, arr);
  });
  return m;
}

const areaName = (rows: { r: Resident }[]) => {
  const c = new Map<string, number>();
  for (const { r } of rows) c.set(r.neighborhood, (c.get(r.neighborhood) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unnamed area';
};

function Header({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="pr-head">
      <div className="pr-brand">FirstLine · Incident report</div>
      <h1>{title}</h1>
      <div className="pr-sub">{sub}</div>
      <div className="pr-printed">Printed {when(Date.now())} · live data from SpacetimeDB · confidential: contains health details</div>
    </header>
  );
}

/** The safe place this household is directed to, by the same rule the reports agent uses. */
export function residentDirection(r: Resident): Direction | null {
  return directTo({
    lat: r.lat,
    lng: r.lng,
    poweredDevice: r.device,
    medicalNeeds: r.medical,
    professional: r.triage?.needs === 'professional' || r.escalated,
    text: [r.triage?.reason ?? '', ...r.log.filter((l) => l.kind === 'sos').map((l) => l.text)].join(' '),
  });
}

function PlaceLine({ label, d }: { label: string; d: Directed }) {
  return (
    <div className="pr-place">
      <span className="pr-k">{label}</span>
      <b>{d.place.name}</b> · {d.km} km
      <div>{d.place.address ?? 'Address not listed'} · <span className="pr-muted">{d.place.note}</span></div>
      <div className="pr-muted">Map: {mapsLink(d.place)}</div>
    </div>
  );
}

function WhereToGo({ r }: { r: Resident }) {
  const d = residentDirection(r);
  return (
    <section className="pr-box pr-go">
      <h2>Where to take them</h2>
      {!d ? (
        <p className="pr-muted">No location on file, so no place can be chosen. Call the household.</p>
      ) : (
        <>
          <p>
            <b>{d.reason === 'medical' ? 'Emergency room' : 'Warming site / shelter'}</b>, because the person {d.why}.
          </p>
          <PlaceLine label="Take them to" d={d.goTo} />
          {d.backup && <PlaceLine label="If that is closed or unreachable" d={d.backup} />}
          {d.er && <PlaceLine label="If it becomes a medical emergency" d={d.er} />}
          <p className="pr-muted">Straight-line distances. Check blocked roads first. Places from {SAFE_PLACES_SOURCE}.</p>
        </>
      )}
    </section>
  );
}

function PersonReport({ idx }: { idx: number }) {
  const r = useMap((s) => s.residents[idx]);
  const status = useMap((s) => s.statuses[idx]);
  const home = homes[idx];
  if (!r || !home) return <p>No registered household here.</p>;
  const area = cellToParent(r.cell, REPORT_RES);
  const areaReport = useMap.getState().reports.find((x) => x.cell === area);
  const flags = [
    r.alone && 'Lives alone',
    r.device && 'Uses a powered medical device',
    r.mobility !== 'ok' && (MOBILITY[r.mobility] ?? r.mobility),
    !r.smart && 'No smartphone',
    r.language !== 'en' && `Speaks ${LANG[r.language] ?? r.language}`,
  ].filter(Boolean) as string[];
  const steps = r.reasoning.filter((l) => l.kind === 'decision' || l.kind === 'thought');
  return (
    <article className="pr-page">
      <Header title={`${r.name}, ${r.age}`} sub={`${r.address} · ${r.neighborhood} · household ${r.householdId}`} />

      <section className="pr-box pr-status">
        <div><span className="pr-k">Status</span><b>{STATUS_LABEL[status]}</b></div>
        <div><span className="pr-k">Priority</span><b>{r.priority || '—'}</b> (score {r.priorityScore.toFixed(1)})</div>
        <div><span className="pr-k">Power</span><b>{r.powerOut ? 'Out' : 'On'}</b></div>
        <div><span className="pr-k">Last contact</span><b>{when(r.lastSeen)}</b>{r.lastContactVia ? ` via ${r.lastContactVia}` : ''}</div>
        <div><span className="pr-k">Escalated</span><b>{r.escalated ? 'Yes, to professional responders' : 'No'}</b></div>
        <div><span className="pr-k">Near the river</span><b>{home.danger ? 'Yes' : 'No'}</b> ({home.riverKm} km)</div>
      </section>

      <WhereToGo r={r} />

      <h2>Household · {r.people} {r.people === 1 ? 'person' : 'people'}</h2>
      <table className="pr-table">
        <thead><tr><th>Name</th><th>Age</th><th>Status</th><th>Priority</th><th>Medical needs</th><th>Last seen</th></tr></thead>
        <tbody>
          {[...r.members].sort((a, b) => rank(a.status) - rank(b.status)).map((m) => (
            <tr key={m.id.toString()}>
              <td>{m.name}</td><td>{m.age}</td><td>{STATUS_LABEL[m.status]}</td><td>{m.priority || '—'}</td><td>{m.medical || '—'}</td><td>{when(m.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {flags.length > 0 && <p><b>Needs to know:</b> {flags.join(' · ')}</p>}

      <h2>Nemotron triage</h2>
      {r.triage ? (
        <div className="pr-box">
          <p><b>Urgency {r.triage.urgency}/5</b> · {r.triage.priority} · needs {r.triage.needs === 'professional' ? 'professional responders' : 'a neighbor'} · confidence {r.triage.confidence.toFixed(2)} · {when(r.triage.at)}</p>
          <p>{r.triage.reason}</p>
          <p className="pr-muted">Model: {r.triage.model}</p>
        </div>
      ) : <p className="pr-muted">Not triaged yet.</p>}

      <h2>Response</h2>
      <ul>
        <li>Helper: {r.assignment ? `${r.assignment.helper} (ring ${r.assignment.ring}) · ${ASSIGN[r.assignment.state] ?? r.assignment.state} · ${when(r.assignment.at)}` : 'none assigned'}</li>
        {r.keyPass && <li>Key pass: {r.keyPass.helper}, approved by {r.keyPass.approvedBy}, {r.keyPass.revoked ? 'revoked' : `valid until ${when(r.keyPass.expiresAt)}`}</li>}
        <li>Safety net: {r.net.length ? r.net.map((n) => `${n.name} (${STATUS_LABEL[n.status]})`).join(', ') : 'none registered'}</li>
      </ul>

      <h2>Timeline</h2>
      {r.log.length === 0 ? <p className="pr-muted">No events yet.</p> : (
        <table className="pr-table pr-log">
          <tbody>
            {r.log.map((e, i) => (
              <tr key={i}><td className="pr-t">{when(e.at)}</td><td className="pr-a">{AGENT[e.agent] ?? e.agent}</td><td>{e.full ?? e.text}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      {steps.length > 0 && (
        <>
          <h2>Agent reasoning</h2>
          <table className="pr-table pr-log">
            <tbody>
              {steps.map((e, i) => (
                <tr key={i}><td className="pr-t">{when(e.at)}</td><td className="pr-a">{AGENT[e.agent] ?? e.agent}</td><td>{e.full ?? e.text}{e.conf !== null ? ` (conf ${e.conf.toFixed(2)})` : ''}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {r.claimTimeline && (
        <>
          <h2>Claim timeline</h2>
          <pre className="pr-pre">{r.claimTimeline.text.replace(/^Claim timeline:\s*/, '')}</pre>
        </>
      )}

      {areaReport && (
        <>
          <h2>Area briefing · {r.neighborhood}</h2>
          <p>{areaReport.summary}</p>
        </>
      )}
    </article>
  );
}

function AreaReport({ report, rows, history }: { report: IncidentReport; rows: { r: Resident; status: Status }[]; history: IncidentReport[] }) {
  const sorted = rows.filter((x) => isP1Household(x.r, x.status)).sort((a, b) => b.r.priorityScore - a.r.priorityScore);
  const blocked = report.blockedRoads && !/^(none|no blocked roads?)\.?$/i.test(report.blockedRoads.trim());
  const count = (s: Status[]) => rows.filter((x) => s.includes(x.status)).length;
  return (
    <article className="pr-page">
      <Header title={areaName(rows)} sub={`Area ${report.cell} · briefing written ${when(report.at)} by the Nemotron reports agent`} />
      <section className="pr-box pr-status">
        <div><span className="pr-k">P1 · help now</span><b>{report.p1}</b></div>
        <div><span className="pr-k">P2 · silent risk</span><b>{report.p2}</b></div>
        <div><span className="pr-k">Unknown</span><b>{report.unknown}</b></div>
        <div><span className="pr-k">Households in area</span><b>{rows.length}</b></div>
        <div><span className="pr-k">Help on the way</span><b>{count(['enroute'])}</b></div>
        <div><span className="pr-k">Safe</span><b>{count(['safe', 'normal'])}</b></div>
      </section>
      <h2>Briefing</h2>
      <p>{report.summary}</p>
      <p><b>Blocked roads:</b> {blocked ? report.blockedRoads : 'none reported'}</p>

      <h2>Priority 1 households · most urgent first</h2>
      {sorted.length === 0 ? <p className="pr-muted">No Priority 1 household is open in this area right now.</p> : (
        <table className="pr-table">
          <thead><tr><th>Name</th><th>Age</th><th>Address</th><th>Status</th><th>Needs</th><th>Helper</th><th>Take them to</th></tr></thead>
          <tbody>
            {sorted.map(({ r, status }) => {
              const d = residentDirection(r);
              return (
                <tr key={r.householdId}>
                  <td>{r.name}{r.people > 1 ? ` +${r.people - 1}` : ''}</td>
                  <td>{r.age}</td>
                  <td>{r.address}</td>
                  <td>{STATUS_LABEL[status]}</td>
                  <td>{[r.medical, r.device && 'powered device', r.alone && 'alone', r.mobility !== 'ok' && (MOBILITY[r.mobility] ?? r.mobility)].filter(Boolean).join(', ') || '—'}</td>
                  <td>{r.helper ?? (r.escalated ? 'Responders' : '—')}</td>
                  <td>
                    {d ? (
                      <>
                        <b>{d.goTo.place.name}</b> ({d.reason === 'medical' ? 'ER' : 'warming'}, {d.goTo.km} km)
                        {d.goTo.place.address ? <div>{d.goTo.place.address}</div> : null}
                        {d.backup && <div className="pr-muted">Backup: {d.backup.place.name} ({d.backup.km} km)</div>}
                      </>
                    ) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {history.length > 0 && (
        <>
          <h2>Earlier briefings · latest {Math.min(6, history.length)} of {history.length}</h2>
          <table className="pr-table pr-log">
            <tbody>
              {history.slice(0, 6).map((h) => (
                <tr key={h.id}><td className="pr-t">{when(h.at)}</td><td className="pr-a">{h.p1} P1 · {h.p2} P2 · {h.unknown} ?</td><td>{h.summary}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </article>
  );
}

function Areas({ only }: { only?: string }) {
  const reports = useMap((s) => s.reports);
  const residents = useMap((s) => s.residents);
  const byArea = householdsByArea(residents);
  // Newest report per area; older ones become that area's history.
  const latest = new Map<string, IncidentReport>();
  const older = new Map<string, IncidentReport[]>();
  for (const r of reports) {
    if (!latest.has(r.cell)) latest.set(r.cell, r);
    else older.set(r.cell, [...(older.get(r.cell) ?? []), r]);
  }
  let list = [...latest.values()].sort((a, b) => b.p1 - a.p1 || b.p2 - a.p2 || b.unknown - a.unknown);
  if (only) {
    const pick = reports.find((r) => r.id === only);
    list = pick ? [pick] : [];
  }
  if (list.length === 0) return <article className="pr-page"><Header title="No incident reports yet" sub="The reports agent writes one per area once someone there is Priority 1." /></article>;
  return (
    <>
      {list.map((r) => (
        <AreaReport key={r.id} report={r} rows={byArea.get(r.cell) ?? []} history={(older.get(r.cell) ?? []).filter((h) => h.id !== r.id)} />
      ))}
    </>
  );
}

/** Mount once; renders the sheet for the current print job and opens the print dialog. */
export function PrintSheet() {
  const job = usePrint((s) => s.job);
  useEffect(() => {
    if (!job) return;
    const done = () => usePrint.getState().set(null);
    window.addEventListener('afterprint', done, { once: true });
    // Let React paint the sheet before the dialog snapshots the page.
    const t = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [job]);
  if (!job) return null;
  return createPortal(
    <div className="print-sheet">
      {job.kind === 'person' ? <PersonReport idx={job.homeIdx} /> : <Areas only={job.kind === 'area' ? job.reportId : undefined} />}
    </div>,
    document.body,
  );
}
