import { useEffect } from 'react';
import { CityCanvas } from './scene/CityCanvas';
import { BackButton, CounterBadge, DecisionTicker, Finale, HouseholdCard, Intro, LiveBar, Timeline, Toolbar } from './hud/Hud';
import { Minimap } from './hud/Minimap';
import { useMap } from './state/store';
import { startLive } from './data/live';

export default function App() {
  const selected = useMap((s) => s.selectedId);
  const intro = useMap((s) => s.intro);
  const mode = useMap((s) => s.mode);
  useEffect(() => startLive(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const s = useMap.getState();
      if (s.intro) return;
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox' && e.key !== 'Escape') return;
      if (e.key === 't' || e.key === 'T') s.setDim(s.dimTarget < 0.5 ? 1 : 0);
      else if (e.key === ' ' && s.mode === 'sim') {
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

  return (
    <>
      <CityCanvas />
      {!intro && (
        <div className="hud">
          {selected === null ? <CounterBadge /> : <BackButton />}
          <Toolbar />
          <DecisionTicker />
          <HouseholdCard />
          {mode === 'live' ? <LiveBar /> : <Timeline />}
          <Minimap />
        </div>
      )}
      <Intro />
      <Finale />
    </>
  );
}
