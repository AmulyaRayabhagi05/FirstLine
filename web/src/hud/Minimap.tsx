import { useEffect, useRef } from 'react';
import { DANGER_W, homes, river, roads, type Pt } from '../sim/world';
import { useMap, STATUS_COLOR } from '../state/store';

const SIZE = 196;
const SPAN = 140; // world units shown
const toM = (v: number) => ((v + SPAN / 2) / SPAN) * SIZE;

function stroke(g: CanvasRenderingContext2D, pl: Pt[]) {
  g.beginPath();
  pl.forEach(([x, z], i) => (i ? g.lineTo(toM(x), toM(z)) : g.moveTo(toM(x), toM(z))));
  g.stroke();
}

// Corner minimap: roads, river, flood band, status dots and where the camera is looking. Click to fly there.
export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useMap((s) => s.version);
  const statuses = useMap((s) => s.statuses);
  const cam = useMap((s) => s.cam);
  const showZone = useMap((s) => s.showZone);
  const T = useMap((s) => s.T);
  const requestPan = useMap((s) => s.requestPan);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.fillStyle = '#121626';
    g.fillRect(0, 0, SIZE, SIZE);
    if (showZone && T >= 0.45) {
      g.strokeStyle = 'rgba(232,40,61,0.22)';
      g.lineWidth = (DANGER_W * 2 * SIZE) / SPAN;
      g.lineCap = 'round';
      stroke(g, river);
    }
    g.strokeStyle = '#2b3359';
    g.lineWidth = 1;
    roads.forEach((pl) => stroke(g, pl));
    g.strokeStyle = '#2a5cc0';
    g.lineWidth = 2;
    stroke(g, river);
    homes.forEach((p, i) => {
      const s = statuses[i];
      g.fillStyle = s === 'normal' ? '#3a3f58' : STATUS_COLOR[s];
      const r = s === 'p1' || s === 'p2' ? 2 : 1;
      g.fillRect(Math.round(toM(p.x)) - r / 2, Math.round(toM(p.z)) - r / 2, r + 1, r + 1);
    });
    // camera: position and view direction
    const cx = toM(cam.x);
    const cz = toM(cam.z);
    const dx = -Math.sin(cam.theta);
    const dz = -Math.cos(cam.theta);
    g.strokeStyle = '#e8dcc8';
    g.fillStyle = 'rgba(232,220,200,0.12)';
    g.beginPath();
    g.moveTo(cx - dx * 10, cz - dz * 10);
    g.lineTo(cx + (dx * 0.7 - dz * 0.6) * 34, cz + (dz * 0.7 + dx * 0.6) * 34);
    g.lineTo(cx + (dx * 0.7 + dz * 0.6) * 34, cz + (dz * 0.7 - dx * 0.6) * 34);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = '#e8283d';
    g.fillRect(cx - 2, cz - 2, 4, 4);
  }, [version, statuses, cam, showZone, T]);

  return (
    <section className="panel minimap" aria-label="Minimap. Click to move the camera there.">
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * SPAN - SPAN / 2;
          const z = ((e.clientY - r.top) / r.height) * SPAN - SPAN / 2;
          requestPan(x, z);
        }}
      />
      <div className="hints">
        <b>Drag</b> rotate<br />
        <b>Right-drag</b> pan<br />
        <b>Scroll</b> zoom<br />
        <b>T</b> 2D / 3D · <b>Esc</b> close
      </div>
    </section>
  );
}
