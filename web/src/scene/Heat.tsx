import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { DANGER_W, homes, river, world } from '../sim/world';
import { useMap } from '../state/store';
import { live } from './live';

const RGB: Record<string, string> = { p1: '255,51,71', p2: '255,90,74', unknown: '255,138,122', enroute: '78,168,255', safe: '62,224,138', normal: '62,224,138' };
const HS = 1024;

export const floodActive = () => {
  const { mode, T, statuses } = useMap.getState();
  if (mode === 'sim') return T >= 0.45;
  return homes.some((h, i) => h.danger && (statuses[i] === 'p1' || statuses[i] === 'p2' || statuses[i] === 'unknown'));
};

// Soft glow on the ground: the flood band when there is a flood, plus a halo under every home.
export function Heat() {
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = HS;
    return c;
  }, []);
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [canvas]);
  const mesh = useRef<THREE.Mesh>(null!);
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  const drawn = useRef({ version: -1, zoneOn: false, at: 0, span: 0 });

  useFrame(() => {
    const { version, showZone, statuses } = useMap.getState();
    mat.current.opacity = 0.45 + (1 - live.dim) * 0.55;
    const span = Math.max(140, 2 * (world.radius + 12));
    mesh.current.scale.setScalar(span);
    const zoneOn = showZone && floodActive();
    const d = drawn.current;
    const now = performance.now();
    if ((d.version === version && d.zoneOn === zoneOn && d.span === span) || now - d.at < 110) return;
    Object.assign(d, { version, zoneOn, at: now, span });
    const toPx = (v: number) => ((v + span / 2) / span) * HS;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, HS, HS);
    g.globalCompositeOperation = 'lighter';
    if (zoneOn) {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const [w, a] of [[DANGER_W * 2, 0.05], [DANGER_W * 1.6, 0.06], [DANGER_W * 1.2, 0.07]] as const) {
        g.strokeStyle = `rgba(255,51,71,${a})`;
        g.lineWidth = (HS / span) * w;
        g.beginPath();
        river.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
        g.stroke();
      }
    }
    homes.forEach((p, i) => {
      const s = statuses[i] ?? 'normal';
      const calm = s === 'safe' || s === 'normal';
      const r = (HS / span) * (s === 'p1' ? 5.5 : s === 'p2' ? 4.8 : calm ? 1.6 : 4);
      const a = calm ? 0.12 : 0.4;
      const px = toPx(p.x);
      const pz = toPx(p.z);
      const gr = g.createRadialGradient(px, pz, 0, px, pz, r);
      gr.addColorStop(0, `rgba(${RGB[s]},${a})`);
      gr.addColorStop(1, `rgba(${RGB[s]},0)`);
      g.fillStyle = gr;
      g.fillRect(px - r, pz - r, r * 2, r * 2);
    });
    g.globalCompositeOperation = 'source-over';
    tex.needsUpdate = true;
  });

  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} position-y={0.08} raycast={() => null}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial ref={mat} map={tex} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </mesh>
  );
}
