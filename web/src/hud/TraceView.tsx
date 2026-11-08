import { useEffect, useMemo, useState } from 'react';
import { buildCases, buildEvents, getTraceRows, LANES, MCP_TOOLS, type Lane, type TraceEvent } from '../data/trace';
import { useMap } from '../state/store';

const laneIdx = new Map(LANES.map((l, i) => [l.id, i]));
const KIND_LABEL: Record<string, string> = {
  sos: 'SOS', check_in: 'check-in', offer: 'offer', accepted: 'accepted', declined: 'declined', timed_out: 'timed out', done: 'done',
  thought: 'thought', tool_call: 'tool call', tool_result: 'result', decision: 'decision',
};
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const traceHref = (personId?: string) => (personId ? `#/trace/${personId}` : '#/trace');

/** The person id in "#/trace/<id>", or null for the case list. */
function hashPerson(): string | null {
  const m = location.hash.match(/^#\/trace\/(\d+)/);
  return m ? m[1]! : null;
}

// A separate page: every person's case as hops between lanes, so you can see which agent called
// which tool, what came back, what was saved and who was contacted, in order.
export function TraceView() {
  const version = useMap((s) => s.version);
  const live = useMap((s) => s.liveInfo);
  const [personId, setPersonId] = useState<string | null>(hashPerson);
  const [q, setQ] = useState('');
  const [onlyTools, setOnlyTools] = useState(true);
  const [hide, setHide] = useState<Set<string>>(new Set(['thought']));

  useEffect(() => {
    const on = () => setPersonId(hashPerson());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const rows = getTraceRows();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cases = useMemo(() => (rows ? buildCases(rows) : []), [rows, version]);
  const shown = cases.filter((c) => (!onlyTools || c.toolCalls > 0) && (!q || `${c.name} ${c.personId}`.toLowerCase().includes(q.toLowerCase())));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const events = useMemo(() => (rows && personId ? buildEvents(rows, personId) : []), [rows, version, personId]);
  const current = cases.find((c) => c.personId === personId);
  const visible = events.filter((e) => !hide.has(e.kind));
  const toggle = (k: string) => setHide((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="trace">
      <header className="tr-top">
        <a className="btn tr-back" href="#/">← Map</a>
        <h1>Trace</h1>
        <p className="nc">Pick a case to see every hop: who called what, what came back, what was saved and who was contacted. Tools marked MCP are also served by the FirstLine MCP server.</p>
        <span className="tr-live nc">{live.state === 'subscribed' ? `Live · ${rows?.steps.length ?? 0} agent steps` : live.message}</span>
      </header>

      <div className="tr-body">
        <aside className="tr-cases" aria-label="Cases">
          <input className="tr-search nc" placeholder="Search name or id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search cases" />
          <label className="tr-check nc"><input type="checkbox" checked={onlyTools} onChange={() => setOnlyTools(!onlyTools)} /> Only cases with tool calls</label>
          <ol>
            {shown.slice(0, 300).map((c) => (
              <li key={c.personId}>
                <a className={c.personId === personId ? 'on' : undefined} href={traceHref(c.personId)}>
                  <b className="nc">{c.name}</b>
                  <span className={`tr-pri p-${c.priority.toLowerCase()}`}>{c.priority}</span>
                  <small className="nc">
                    {c.age} · {[...c.agents].map((a) => a.replace('_', ' ')).join(', ') || 'no agents yet'} · {c.toolCalls} tool calls · {time(c.lastAt)}
                  </small>
                </a>
              </li>
            ))}
            {shown.length === 0 && <li className="tr-empty nc">{rows ? 'No cases match.' : 'Waiting for live data…'}</li>}
          </ol>
        </aside>

        <main className="tr-flow" aria-label="Case flow">
          {!personId || !current ? (
            <div className="tr-empty nc">Choose a case on the left. A good one to start with is any P1 with tool calls.</div>
          ) : (
            <>
              <div className="tr-case">
                <h2 className="nc">{current.name}, {current.age}</h2>
                <span className={`tr-pri p-${current.priority.toLowerCase()}`}>{current.priority}</span>
                <span className="nc tr-meta">{events.length} events · {events.filter((e) => e.kind === 'tool_call').length} tool calls · status {current.status.replace('_', ' ')}</span>
                <div className="tr-filters nc">
                  Show:
                  {['thought', 'tool_call', 'tool_result', 'decision', 'sos', 'check_in', 'offer'].map((k) => (
                    <button key={k} aria-pressed={!hide.has(k)} onClick={() => toggle(k)}>{KIND_LABEL[k]}</button>
                  ))}
                </div>
              </div>
              <div className="tr-grid" style={{ ['--lanes' as string]: LANES.length }}>
                <div className="tr-lanes">
                  {LANES.map((l) => <div key={l.id} title={l.hint}>{l.label}</div>)}
                </div>
                <ol className="tr-events">
                  {visible.map((e, i) => <Hop key={i} e={e} />)}
                </ol>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Hop({ e }: { e: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const a = laneIdx.get(e.from)!;
  const b = laneIdx.get(e.to)!;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const self = a === b;
  const mcp = e.tool && MCP_TOOLS.has(e.tool);
  return (
    <li className={`tr-hop k-${e.kind}`}>
      <div className="tr-rail" aria-hidden="true">
        {LANES.map((l) => <span key={l.id} />)}
        {self ? (
          <i className="tr-dot" style={{ gridColumn: `${a + 1}` }} />
        ) : (
          <i className={`tr-arrow ${b > a ? 'right' : 'left'}`} style={{ gridColumn: `${lo + 1} / ${hi + 2}`, ['--n' as string]: hi - lo + 1 }} />
        )}
      </div>
      <button className="tr-label" onClick={() => setOpen(!open)} aria-expanded={open} style={{ marginLeft: `calc(${lo} * 100% / var(--lanes))` }}>
        <time className="nc">{time(e.at)}</time>
        <span className="tr-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
        {mcp && <span className="tr-mcp" title="Also served by the FirstLine MCP server">MCP</span>}
        <span className="tr-route nc">{laneName(e.from)}{self ? '' : ` → ${laneName(e.to)}`}</span>
        {e.conf !== null && <span className="tr-conf nc">conf {e.conf.toFixed(2)}</span>}
        <span className={`tr-text nc${open ? ' open' : ''}`}>{e.label}</span>
      </button>
    </li>
  );
}

const laneName = (l: Lane) => LANES.find((x) => x.id === l)!.label;
