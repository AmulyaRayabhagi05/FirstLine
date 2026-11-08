import { useFrame } from '@react-three/fiber';
import { useMap, counts } from '../state/store';
import { live } from './live';

// Advances replay time, and runs the demo: street sweep → flatten to the 2D map → play until no one is unreached.
export function Clock() {
  useFrame((_, dt) => {
    const st = useMap.getState();
    const step = Math.min(dt, 0.1);
    if (st.demo === 'sweep') {
      st.setT(Math.min(st.T + step * 0.22, 1.4));
      if (st.T >= 1.4) {
        st.setDemo('flatten');
        st.setDim(0);
      }
    } else if (st.demo === 'flatten') {
      st.setT(st.T + step * 0.36);
      if (live.dim <= 0.001) st.setDemo('play');
    } else if (st.demo === 'play') {
      st.setT(st.T + step * 0.42);
      // The tour ends after one pass; the finale only shows when the live data says no one is unreached.
      const s = useMap.getState();
      if (s.T >= 8) {
        st.setDemo('off');
        const c = counts(s.statuses);
        if (c.unreached === 0 && c.safe > 0) st.setFinale(true);
      }
    } else if (st.playing) {
      st.setT(st.T + step * 0.33);
      if (useMap.getState().T >= 8) st.setPlaying(false);
    }
  });
  return null;
}
