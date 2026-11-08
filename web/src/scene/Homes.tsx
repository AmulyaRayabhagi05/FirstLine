import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { homes, outerHomes, powerOut, world } from '../sim/world';
import { useMap } from '../state/store';
import { live, heightFor } from './live';

function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#26302f';
  g.fillRect(0, 0, 64, 64);
  // dithered wall, like a pixel-art facade
  for (let y = 0; y < 64; y += 2)
    for (let x = ((y / 2) % 2) * 2; x < 64; x += 4) {
      g.fillStyle = '#2c3836';
      g.fillRect(x, y, 2, 2);
    }
  const lit = ['#ffd27a', '#ffc35a', '#ffe3a3'];
  [[8, 12], [24, 12], [40, 12], [52, 12], [8, 30], [52, 30]].forEach(([x, y], k) => {
    g.fillStyle = k % 3 === 1 ? '#2a3b55' : lit[k % 3];
    g.fillRect(x, y, 6, 7);
  });
  g.fillStyle = '#0f1622';
  g.fillRect(26, 38, 12, 26);
  g.fillStyle = '#ffd27a';
  g.fillRect(28, 30, 8, 4);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const bodyGeo = new THREE.BoxGeometry(1.7, 1.25, 1.5).translate(0, 0.625, 0);
export const roofGeo = (() => {
  const g = new THREE.ConeGeometry(1.42, 0.95, 4, 1);
  g.rotateY(Math.PI / 4);
  g.scale(1, 1, 0.9);
  g.translate(0, 1.25 + 0.475, 0);
  return g;
})();

const dummy = new THREE.Object3D();
const tmp = new THREE.Color();
const darkTint = new THREE.Color('#1c2036');

// All households as instanced houses (walls with lit windows + low roofs), plus the outer city to the horizon.
// Re-mounts when the household list changes (live data arriving, or switching to the simulation).
export function Homes() {
  const worldVersion = useMap((s) => s.worldVersion);
  return <HomesInner key={worldVersion} />;
}

function HomesInner() {
  const bodies = useRef<THREE.InstancedMesh>(null!);
  const roofs = useRef<THREE.InstancedMesh>(null!);
  const oBodies = useRef<THREE.InstancedMesh>(null!);
  const oRoofs = useRef<THREE.InstancedMesh>(null!);
  const bodyMat = useMemo(() => new THREE.MeshLambertMaterial({ map: windowTexture() }), []);
  const roofMat = useMemo(() => new THREE.MeshLambertMaterial({ color: '#ffffff' }), []);
  const lastDim = useRef(-1);
  const lastT = useRef(-1);
  const select = useMap((s) => s.select);

  useEffect(() => {
    homes.forEach((p, i) => {
      bodies.current.setColorAt(i, tmp.set(p.wall));
      roofs.current.setColorAt(i, tmp.set(p.roof));
    });
    outerHomes.forEach((p, i) => {
      oBodies.current.setColorAt(i, tmp.set(p.wall));
      oRoofs.current.setColorAt(i, tmp.set(p.roof));
    });
    [bodies, roofs, oBodies, oRoofs].forEach((r) => r.current.instanceColor && (r.current.instanceColor.needsUpdate = true));
  }, []);

  useFrame(() => {
    const { T, mode, version } = useMap.getState();
    const key = mode === 'live' ? version : T;
    if (key !== lastT.current && homes.length) {
      lastT.current = key;
      const statuses = useMap.getState().statuses;
      homes.forEach((p, i) => {
        tmp.set(p.wall);
        // lights go out in homes that lost power (simulation) or that need help in the live flood
        const dark = mode === 'live' ? p.danger && (statuses[i] === 'p1' || statuses[i] === 'p2' || statuses[i] === 'unknown') : powerOut(p, T);
        if (dark) tmp.multiply(darkTint);
        bodies.current.setColorAt(i, tmp);
      });
      bodies.current.instanceColor!.needsUpdate = true;
    }
    if (live.dim === lastDim.current) return;
    lastDim.current = live.dim;
    const hs = heightFor(live.dim);
    live.homeScale = hs;
    const place = (list: { x: number; z: number; rot: number; sx: number; sy: number }[], a: THREE.InstancedMesh, b: THREE.InstancedMesh) => {
      list.forEach((p, i) => {
        dummy.position.set(p.x, 0, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, p.sy * hs, p.sx);
        dummy.updateMatrix();
        a.setMatrixAt(i, dummy.matrix);
        b.setMatrixAt(i, dummy.matrix);
      });
      a.instanceMatrix.needsUpdate = b.instanceMatrix.needsUpdate = true;
      a.computeBoundingSphere();
      b.computeBoundingSphere();
    };
    place(homes, bodies.current, roofs.current);
    // the outer city starts where the households end
    place(outerHomes.map((o) => (Math.hypot(o.x, o.z) < world.radius + 4 ? { ...o, sx: 0, sy: 0 } : o)), oBodies.current, oRoofs.current);
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 6 || e.instanceId === undefined) return;
    select(homes[e.instanceId].id);
  };
  const over = () => (document.body.style.cursor = 'pointer');
  const out = () => (document.body.style.cursor = '');

  return (
    <group>
      <instancedMesh ref={bodies} args={[bodyGeo, bodyMat, homes.length]} onClick={onClick} onPointerOver={over} onPointerOut={out} />
      <instancedMesh ref={roofs} args={[roofGeo, roofMat, homes.length]} onClick={onClick} onPointerOver={over} onPointerOut={out} />
      <instancedMesh ref={oBodies} args={[bodyGeo, bodyMat, outerHomes.length]} raycast={() => null} />
      <instancedMesh ref={oRoofs} args={[roofGeo, roofMat, outerHomes.length]} raycast={() => null} />
    </group>
  );
}
