import { useEffect, useState } from 'react';
import { TraceView } from './hud/TraceView';
import { CityCanvas } from './scene/CityCanvas';
import { ErrorBoundary } from './hud/ErrorBoundary';
import { BackButton, CounterBadge, DecisionTicker, Finale, HouseholdCard, IncidentReports, Intro, LiveBar, SignIn, Toolbar } from './hud/Hud';
import { Minimap } from './hud/Minimap';
import { PrintSheet } from './hud/PrintReport';
import { useMap } from './state/store';

export default function App() {
  const selected = useMap((s) => s.selectedId);
  const intro = useMap((s) => s.intro);
  const signedIn = useMap((s) => s.signedIn);
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    // A direct link to the Trace page skips the intro story.
    if (location.hash.startsWith('#/trace')) useMap.getState().setIntro(false);
    const on = () => setRoute(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const s = useMap.getState();
      if (s.intro || !s.signedIn) return;
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox' && e.key !== 'Escape') return;
      if (e.key === 't' || e.key === 'T') s.setDim(s.dimTarget < 0.5 ? 1 : 0);
      else if (e.key === ' ') {
        e.preventDefault();
        s.setDemo('off');
        s.setPlaying(!s.playing);
      } else if (e.key === 'Escape') {
        if (s.finale) s.setFinale(false);
        else if (s.layersOpen) s.setLayersOpen(false);
        else s.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The Trace page is its own screen (no 3D city), on the same live connection.
  // Opened directly, it waits for the intro and sign-in, then shows.
  if (route.startsWith('#/trace') && signedIn && !intro) return <TraceView />;

  return (
    <>
      <CityCanvas />
      {!intro && !signedIn && <SignIn />}
      {!intro && signedIn && (
        <div className="hud">
          {selected === null ? <CounterBadge /> : <BackButton />}
          <Toolbar />
          <DecisionTicker />
          <ErrorBoundary label="Household card" resetKey={selected} onReset={() => useMap.getState().select(null)}>
            <HouseholdCard />
          </ErrorBoundary>
          <LiveBar />
          {selected === null && <IncidentReports />}
          <Minimap />
        </div>
      )}
      <Intro />
      <Finale />
      <PrintSheet />
    </>
  );
}
