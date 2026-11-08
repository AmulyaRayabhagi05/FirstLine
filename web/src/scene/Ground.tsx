import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { COMMS, DANGER_W, CITY_R, HALF, PARKS, W, homes, river, roads, streets, type Pt } from '../sim/world';
import { floodActive, useMap } from '../state/store';
import { GROUND } from './live';

const toPx = (v: number, S: number) => ((v + HALF) / W) * S;

function offsetPL(pl: Pt[], off: number): Pt[] {
  return pl.map((p, i) => {
    const a = pl[Math.max(i - 1, 0)];
    const b = pl[Math.min(i + 1, pl.length - 1)];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1;
    return [p[0] - (tz / L) * off, p[1] + (tx / L) * off];
  });
}
function segments(pls: Pt[][], y: number) {
  const pts: number[] = [];
  for (const pl of pls) for (let i = 0; i < pl.length - 1; i++) pts.push(pl[i][0], y, pl[i][1], pl[i + 1][0], y, pl[i + 1][1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
function ribbon(pl: Pt[], w: number, y: number) {
  const L = offsetPL(pl, w / 2);
  const R = offsetPL(pl, -w / 2);
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < pl.length; i++) {
    pos.push(L[i][0], y, L[i][1], R[i][0], y, R[i][1]);
    if (i < pl.length - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// Ground: soft community tints and parks on the city plane, thin road lines to the horizon, the river, and the dashed flood edge.
export function Ground() {
  const tex = useMemo(() => {
    const S = 2048;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    g.fillStyle = GROUND;
    g.fillRect(0, 0, S, S);
    for (const p of homes) {
      const px = toPx(p.x, S);
      const pz = toPx(p.z, S);
      const rr = (S / W) * 7;
      const gr = g.createRadialGradient(px, pz, 0, px, pz, rr);
      gr.addColorStop(0, COMMS[p.comm].c + '16');
      gr.addColorStop(1, COMMS[p.comm].c + '00');
      g.fillStyle = gr;
      g.fillRect(px - rr, pz - rr, rr * 2, rr * 2);
    }
    for (const pk of PARKS) {
      g.fillStyle = '#16362c';
      g.beginPath();
      g.arc(toPx(pk.x, S), toPx(pk.z, S), (pk.r / W) * S, 0, Math.PI * 2);
      g.fill();
    }
    const edge = g.createRadialGradient(S / 2, S / 2, S * 0.36, S / 2, S / 2, S * 0.5);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, GROUND);
    g.fillStyle = edge;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);

  const roadGeo = useMemo(() => segments(roads.flatMap((pl) => [offsetPL(pl, 1.1), offsetPL(pl, -1.1)]), 0.06), []);
  const streetGeo = useMemo(() => segments(streets, 0.05), []);
  const riverGeos = useMemo(() => [ribbon(river, 7, 0.03), ribbon(river, 3.2, 0.04), ribbon(river, 0.5, 0.05)], []);
  const zoneEdges = useMemo(
    () =>
      [1, -1].map((side) => {
        const pts = offsetPL(river, DANGER_W * side)
          .filter(([x, z]) => Math.hypot(x, z) < CITY_R + 4)
          .map(([x, z]) => new THREE.Vector3(x, 0.12, z));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#e8283d', dashSize: 1.4, gapSize: 1, transparent: true, opacity: 0.85 }));
        line.computeLineDistances();
        return line;
      }),
    [],
  );
  useFrame(() => {
    const { showZone } = useMap.getState();
    zoneEdges.forEach((l) => (l.visible = showZone && floodActive(useMap.getState().statuses)));
  });

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[900, 900]} />
        <meshLambertMaterial color={GROUND} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[W, W]} />
        <meshLambertMaterial map={tex} />
      </mesh>
      <lineSegments geometry={roadGeo}>
        <lineBasicMaterial color="#47605f" transparent opacity={0.7} />
      </lineSegments>
      <lineSegments geometry={streetGeo}>
        <lineBasicMaterial color="#2f4446" transparent opacity={0.55} />
      </lineSegments>
      <mesh geometry={riverGeos[0]}>
        <meshBasicMaterial color="#1d4a5e" transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={riverGeos[1]}>
        <meshBasicMaterial color="#2a7397" transparent opacity={0.85} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={riverGeos[2]}>
        <meshBasicMaterial color="#9fd3e6" transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {zoneEdges.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </group>
  );
}
