import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { DANGER_W, HALF, W, homes, river } from '../sim/world';
import { floodActive, useMap } from '../state/store';
import { live } from './live';

const RGB: Record<string, string> = { p1: '255,59,78', p2: '255,154,60', unknown: '244,211,94', enroute: '90,169,255', safe: '79,224,143' };
const HS = 768;
const toPx = (v: number) => ((v + HALF) / W) * HS;

// Soft glow on the ground: the flood danger band plus a halo under every home with a status.
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
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  const drawn = useRef({ version: -1, zone: true, zoneOn: false, at: 0 });

  useFrame(() => {
    const { version, showZone, statuses } = useMap.getState();
    mat.current.opacity = 0.45 + (1 - live.dim) * 0.55;
    const zoneOn = showZone && floodActive(statuses);
    const d = drawn.current;
    const now = performance.now();
    if ((d.version === version && d.zoneOn === zoneOn) || now - d.at < 110) return;
    d.version = version;
    d.zoneOn = zoneOn;
    d.at = now;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, HS, HS);
    g.globalCompositeOperation = 'lighter';
    if (zoneOn) {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const [w, a] of [[DANGER_W * 2, 0.05], [DANGER_W * 1.6, 0.06], [DANGER_W * 1.2, 0.07]] as const) {
        g.strokeStyle = `rgba(232,40,61,${a})`;
        g.lineWidth = (HS / W) * w;
        g.beginPath();
        river.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
        g.stroke();
      }
    }
    homes.forEach((p, i) => {
      const s = statuses[i];
      if (s === 'normal') return;
      const r = (HS / W) * (s === 'p1' ? 5.5 : s === 'p2' ? 4.5 : s === 'safe' ? 1.8 : 3.5);
      const a = s === 'safe' ? 0.18 : 0.38;
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
    <mesh rotation-x={-Math.PI / 2} position-y={0.08} raycast={() => null}>
      <planeGeometry args={[W, W]} />
      <meshBasicMaterial ref={mat} map={tex} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </mesh>
  );
}
