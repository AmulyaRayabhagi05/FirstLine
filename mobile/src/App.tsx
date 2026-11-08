import { useEffect, useMemo, useState } from 'react';
import {
  DEMO, accessKey, answerOffer, checkIn, connect, locate, markSafe, register, sendSos, shareLocation, signOut, useAppState,
  type Me, type MyOffer, type MySos, type SignUp as SignUpData,
} from './conn';
import { initialLang, saveLang, STRINGS, type Lang } from './i18n';

type T = (typeof STRINGS)['en'];

export default function App() {
  const s = useAppState();
  const [lang, setLang] = useState<Lang>(initialLang);
  const [view, setView] = useState<'home' | 'signup' | 'settings' | 'help' | 'welcome' | 'key'>('home');
  const t = STRINGS[lang];
  const changeLang = (l: Lang) => {
    setLang(l);
    saveLang(l);
  };
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const newAccount = s.loaded && s.people.length === 0;
  const screen = view === 'home' && newAccount ? 'welcome' : view;

  return (
    <div className="app">
      <header className="bar">
        <span className="brand"><i aria-hidden="true" />{t.appName}</span>
        <div className="bar-right">
          <button className="lang" onClick={() => changeLang(lang === 'en' ? 'es' : 'en')} aria-label={lang === 'en' ? 'Cambiar a español' : 'Switch to English'}>
            {lang === 'en' ? 'Español' : 'English'}
          </button>
          {!newAccount && s.loaded && screen === 'home' && (
            <button className="icon" onClick={() => setView('settings')} aria-label={t.settings}>⚙</button>
          )}
        </div>
      </header>
      {DEMO && <div className="banner" role="status">Demo · sample data, nothing is sent</div>}
      {s.phase === 'offline' && <div className="banner warn" role="status">{t.offline}</div>}
      {s.outbox.length > 0 && <div className="banner" role="status">{t.queued(s.outbox.length)}</div>}

      <main>
        {!s.loaded ? (
          <Loading t={t} error={s.phase === 'error' ? s.error : undefined} />
        ) : screen === 'welcome' ? (
          <Welcome t={t} onStart={() => setView('signup')} onKey={() => setView('key')} />
        ) : screen === 'signup' ? (
          <SignUp t={t} lang={lang} forOther={!newAccount} onDone={() => setView('home')} onCancel={() => setView('home')} />
        ) : screen === 'key' ? (
          <KeySignIn t={t} onBack={() => setView('home')} />
        ) : screen === 'settings' ? (
          <Settings t={t} lang={lang} setLang={changeLang} onDone={() => setView('home')} />
        ) : screen === 'help' ? (
          <Help t={t} me={s.people[0]!} onDone={() => setView('home')} />
        ) : (
          <Home t={t} people={s.people} sos={s.sos} offers={s.offers} onHelp={() => setView('help')} onAdd={() => setView('signup')} />
        )}
      </main>
    </div>
  );
}

function Loading({ t, error }: { t: T; error?: string }) {
  return (
    <section className="center">
      {error ? <p className="err">{error}</p> : <p className="muted">{t.connecting}</p>}
      {error && <button className="btn" onClick={() => connect()}>↻</button>}
    </section>
  );
}

function Welcome({ t, onStart, onKey }: { t: T; onStart: () => void; onKey: () => void }) {
  return (
    <section className="welcome">
      <h1>{t.tagline}</h1>
      <ol className="points">
        {t.welcomePoints.map((p, i) => <li key={i}>{p}</li>)}
      </ol>
      <button className="btn primary big" onClick={onStart}>{t.getStarted}</button>
      <button className="btn ghost" onClick={onKey}>{t.haveKey}</button>
    </section>
  );
}

// ---------------------------------------------------------------- sign-up

interface Draft {
  forOther: boolean;
  name: string;
  age: string;
  phone: string;
  language: string;
  livesAlone: boolean;
  mobility: SignUpData['mobility'];
  poweredDevice: boolean;
  medicalNeeds: string;
  hasSmartphone: boolean;
  address: string;
  lat?: number;
  lng?: number;
}

/** Finds an address with OpenStreetMap, biased to the Dallas area. Used only if location is off. */
async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', address);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'us');
  u.searchParams.set('viewbox', '-97.3,33.2,-96.4,32.5');
  try {
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    const j = (await r.json()) as { lat: string; lon: string }[];
    return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
  } catch {
    return null;
  }
}

function SignUp({ t, lang, forOther, onDone, onCancel }: { t: T; lang: Lang; forOther: boolean; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>({
    forOther, name: '', age: '', phone: '', language: lang, livesAlone: false, mobility: 'ok', poweredDevice: false,
    medicalNeeds: '', hasSmartphone: !forOther, address: '',
  });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const STEPS = 4;
  const other = d.forOther;

  const valid = (): string | null => {
    if (step === 0) {
      if (!d.name.trim() || !d.phone.trim()) return t.required;
      const a = Number(d.age);
      if (!Number.isInteger(a) || a < 18 || a > 120) return t.ageRange;
    }
    if (step === 2 && (!d.address.trim() || d.lat === undefined)) return d.address.trim() ? t.addressNotFound : t.required;
    return null;
  };
  const next = () => {
    const v = valid();
    setErr(v);
    if (!v) setStep(step + 1);
  };

  const useHere = async () => {
    setBusy(t.locating);
    setErr(null);
    const p = await locate();
    setBusy(null);
    if (p) up(p);
    else setErr(t.locationFailed);
  };
  const find = async () => {
    setBusy(t.locating);
    setErr(null);
    const p = await geocode(d.address);
    setBusy(null);
    if (p) up(p);
    else setErr(t.addressNotFound);
  };

  const submit = async () => {
    setBusy(t.signingUp);
    setErr(null);
    try {
      await register({
        name: d.name.trim(), age: Number(d.age), livesAlone: d.livesAlone, mobility: d.mobility, medicalNeeds: d.medicalNeeds.trim(),
        poweredDevice: d.poweredDevice, hasSmartphone: d.hasSmartphone, language: d.language, phone: d.phone.trim(),
        address: d.address.trim(), lat: d.lat!, lng: d.lng!,
      });
      onDone();
    } catch (e) {
      setErr(t.errorPrefix + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="form">
      <p className="step">{t.step(step + 1, STEPS)}</p>
      {step === 0 && (
        <>
          {forOther && (
            <fieldset className="choice">
              <legend>{t.forWho}</legend>
              <label><input type="radio" checked={!d.forOther} onChange={() => up({ forOther: false, hasSmartphone: true })} /> {t.forMe}</label>
              <label><input type="radio" checked={d.forOther} onChange={() => up({ forOther: true, hasSmartphone: false })} /> {t.forOther}</label>
            </fieldset>
          )}
          <h2>{other ? t.aboutTitleOther : t.aboutTitle}</h2>
          <Field label={t.name}><input autoComplete={other ? 'off' : 'name'} value={d.name} onChange={(e) => up({ name: e.target.value })} /></Field>
          <Field label={t.age}><input inputMode="numeric" pattern="[0-9]*" value={d.age} onChange={(e) => up({ age: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></Field>
          <Field label={t.phone} hint={t.phoneHint}><input type="tel" autoComplete={other ? 'off' : 'tel'} value={d.phone} onChange={(e) => up({ phone: e.target.value })} /></Field>
          <Field label={t.language}>
            <select value={d.language} onChange={(e) => up({ language: e.target.value })}>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="vi">Tiếng Việt</option>
            </select>
          </Field>
        </>
      )}
      {step === 1 && (
        <>
          <h2>{t.healthTitle}</h2>
          <Toggle label={t.livesAlone} on={d.livesAlone} set={(v) => up({ livesAlone: v })} />
          <fieldset className="choice">
            <legend>{t.mobility}</legend>
            {([['ok', t.mobilityOk], ['limited', t.mobilityLimited], ['cannot_walk', t.mobilityCannot]] as const).map(([v, l]) => (
              <label key={v}><input type="radio" checked={d.mobility === v} onChange={() => up({ mobility: v })} /> {l}</label>
            ))}
          </fieldset>
          <Toggle label={t.powered} on={d.poweredDevice} set={(v) => up({ poweredDevice: v })} />
          <Toggle label={t.smartphone} on={d.hasSmartphone} set={(v) => up({ hasSmartphone: v })} />
          <Field label={t.medical} hint={t.medicalHint}><textarea rows={2} value={d.medicalNeeds} onChange={(e) => up({ medicalNeeds: e.target.value })} /></Field>
        </>
      )}
      {step === 2 && (
        <>
          <h2>{t.homeTitle}</h2>
          <Field label={t.address}><input autoComplete={other ? 'off' : 'street-address'} value={d.address} onChange={(e) => up({ address: e.target.value, lat: undefined, lng: undefined })} /></Field>
          <div className="row">
            {!other && <button className="btn" onClick={useHere} disabled={!!busy}>📍 {t.useLocation}</button>}
            <button className="btn" onClick={find} disabled={!!busy || d.address.trim().length < 6}>{t.findAddress}</button>
          </div>
          {d.lat !== undefined && <p className="ok">✓ {t.locationSet} ({d.lat.toFixed(4)}, {d.lng!.toFixed(4)})</p>}
        </>
      )}
      {step === 3 && (
        <>
          <h2>{t.consentTitle}</h2>
          <ul className="consent">{t.consent.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </>
      )}
      {busy && <p className="muted" role="status">{busy}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="nav">
        <button className="btn ghost" onClick={() => (step === 0 ? onCancel() : setStep(step - 1))} disabled={!!busy}>{t.back}</button>
        {step < STEPS - 1 ? (
          <button className="btn primary" onClick={next} disabled={!!busy}>{t.next}</button>
        ) : (
          <button className="btn primary" onClick={submit} disabled={!!busy}>{t.agree}</button>
        )}
      </div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------- home

function Home({ t, people, sos, offers, onHelp, onAdd }: { t: T; people: Me[]; sos: MySos[]; offers: MyOffer[]; onHelp: () => void; onAdd: () => void }) {
  const me = people[0]!;
  const mine = new Set(people.map((p) => p.id));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const myOpen = sos.filter((s) => mine.has(s.personId) && s.state !== 'resolved').sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const asks = offers.filter((o) => mine.has(o.helperId) && (o.state === 'offered' || o.state === 'accepted'));
  const sosById = useMemo(() => new Map(sos.map((s) => [s.id, s])), [sos]);
  const onMySos = (o: MyOffer) => myOpen.some((s) => s.id === o.sosId);
  const helperComing = offers.some((o) => onMySos(o) && o.state === 'accepted');

  const status = me.status === 'needs_help' || myOpen.length ? 'help' : me.status === 'safe' ? 'safe' : 'unknown';
  const safe = () => {
    checkIn(me.id, 'safe');
    setNote(t.sentSafe);
  };
  const updateLoc = async () => {
    setBusy(true);
    const p = await locate();
    try {
      if (p) {
        await shareLocation(me.id, p.lat, p.lng);
        setNote(t.locationShared);
      } else setNote(t.locationFailed);
    } catch (e) {
      setNote(t.errorPrefix + (e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  };

  return (
    <section className="home">
      <h1>{t.hello(me.name.split(' ')[0]!)}</h1>
      <div className={`status s-${status}`} role="status">
        <b>{status === 'safe' ? t.statusSafe : status === 'help' ? t.statusHelp : t.statusUnknown}</b>
        <span>{status === 'safe' ? t.statusSafeSub : status === 'help' ? (helperComing ? t.requestState.assigned : t.statusHelpSub) : t.statusUnknownSub}</span>
      </div>
      {note && <p className="ok" role="status">{note}</p>}

      <div className="actions">
        <button className="btn safe big" onClick={safe}>✓ {t.imSafe}</button>
        <button className="btn help big" onClick={onHelp}>! {t.needHelp}</button>
      </div>
      <a className="call" href="tel:911">{t.call911}</a>

      {myOpen.length > 0 && (
        <div className="card">
          <h2>{t.yourRequest}</h2>
          {myOpen.map((s) => (
            <p key={String(s.id)}>
              <b>{t.requestState[helperComing && s.state === 'open' ? 'assigned' : s.state] ?? s.state}</b>
              <br />
              <span className="muted">{s.message}</span>
            </p>
          ))}
        </div>
      )}

      {asks.map((o) => {
        const s = sosById.get(o.sosId);
        return (
          <div className="card ask" key={String(o.id)}>
            <h2>{t.neighborAsks}</h2>
            <p className="muted">{t.neighborAsksSub(o.ring)}</p>
            {s && <p>“{s.message}”</p>}
            {s && <a className="btn" href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`} target="_blank" rel="noreferrer">🧭 {t.directions}</a>}
            {o.state === 'offered' ? (
              <div className="row">
                <button className="btn primary" onClick={() => void answerOffer(o.id, true)}>{t.accept}</button>
                <button className="btn ghost" onClick={() => void answerOffer(o.id, false)}>{t.decline}</button>
              </div>
            ) : (
              <>
                <p className="ok">{t.accepted}</p>
                {s && <button className="btn safe" onClick={() => void markSafe(s.personId)}>✓ {t.markThemSafe}</button>}
              </>
            )}
          </div>
        );
      })}

      <div className="card">
        <h2>{t.family}</h2>
        <ul className="people">
          {people.map((p) => (
            <li key={String(p.id)}>
              <span>{p.name}, {p.age}</span>
              <small className={`dot s-${p.status}`}>{p.status === 'safe' ? '✓' : p.status === 'needs_help' ? '!' : '?'}</small>
            </li>
          ))}
        </ul>
        <div className="row">
          <button className="btn ghost" onClick={onAdd}>+ {t.addPerson}</button>
          <button className="btn ghost" onClick={updateLoc} disabled={busy}>📍 {t.shareLocation}</button>
        </div>
      </div>
    </section>
  );
}

function Help({ t, me, onDone }: { t: T; me: Me; onDone: () => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const here = await locate(3000); // an SOS should not wait long for GPS; the home location is the fallback
    const msg = [...picked.map((i) => STRINGS.en.helpChips[i]), text.trim()].filter(Boolean).join('. ') || 'Needs help';
    // The agents read English and Spanish; the chips go out in English so triage rules match too.
    sendSos(me.id, msg, here?.lat ?? me.lastLat, here?.lng ?? me.lastLng);
    setBusy(false);
    onDone();
  };
  return (
    <section className="form">
      <h2>{t.helpTitle}</h2>
      <div className="chips">
        {t.helpChips.map((c, i) => (
          <button key={i} className="chip" aria-pressed={picked.includes(i)} onClick={() => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}>
            {c}
          </button>
        ))}
      </div>
      <Field label={t.helpMessage}><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <a className="call" href="tel:911">{t.call911}</a>
      <div className="nav">
        <button className="btn ghost" onClick={onDone} disabled={busy}>{t.back}</button>
        <button className="btn help" onClick={send} disabled={busy}>{busy ? t.sending : t.sendHelp}</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- settings

function Settings({ t, lang, setLang, onDone }: { t: T; lang: Lang; setLang: (l: Lang) => void; onDone: () => void }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const key = accessKey() ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      setShow(true);
    }
  };
  return (
    <section className="form">
      <h2>{t.settings}</h2>
      <Field label={t.langLabel}>
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </Field>
      <div className="card">
        <h3>{t.keyTitle}</h3>
        <p className="muted">{t.keyHint}</p>
        <div className="row">
          <button className="btn" onClick={() => setShow(!show)}>{t.showKey}</button>
          <button className="btn" onClick={copy}>{copied ? t.copied : t.copy}</button>
        </div>
        {show && <textarea className="key" readOnly rows={4} value={key} onFocus={(e) => e.target.select()} />}
      </div>
      <div className="card">
        <h3>{t.privacy}</h3>
        <ul className="consent">{t.consent.map((c, i) => <li key={i}>{c}</li>)}</ul>
      </div>
      <div className="card">
        <h3>{t.account}</h3>
        <p className="muted">{t.signOutWarn}</p>
        <button className="btn ghost danger" onClick={() => { if (confirm(t.signOutWarn)) { signOut(); onDone(); } }}>{t.signOut}</button>
      </div>
      <button className="btn primary" onClick={onDone}>{t.done}</button>
    </section>
  );
}

function KeySignIn({ t, onBack }: { t: T; onBack: () => void }) {
  const [k, setK] = useState('');
  return (
    <section className="form">
      <h2>{t.keyTitle}</h2>
      <p className="muted">{t.keyHint}</p>
      <Field label={t.pasteKey}><textarea rows={4} value={k} onChange={(e) => setK(e.target.value.trim())} autoComplete="off" spellCheck={false} /></Field>
      <div className="nav">
        <button className="btn ghost" onClick={onBack}>{t.back}</button>
        <button className="btn primary" disabled={k.length < 20} onClick={() => { connect(k); onBack(); }}>{t.signIn}</button>
      </div>
    </section>
  );
}
