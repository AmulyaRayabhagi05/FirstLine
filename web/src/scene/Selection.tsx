import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { homes, statusAt } from '../sim/world';
import { useMap, STATUS_COLOR } from '../state/store';
import { live } from './live';

const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The picked home: a pulsing ring on the ground, and arcs to the three neighbors in its safety net.
export function Selection() {
  const id = useMap((s) => s.selectedId);
  const home = id === null ? null : homes.find((h) => h.id === id) ?? null;
  const ring = useRef<THREE.Mesh>(null!);
  const arcs = useMemo(() => {
    if (!home) return [];
    return home.net.map((n, k) => {
      const a = new THREE.Vector3(home.x, 0.3, home.z);
      const b = new THREE.Vector3(n.x, 0.3, n.z);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y = 3.4;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 }));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 10), new THREE.MeshBasicMaterial({ color: STATUS_COLOR.enroute }));
      return { n, curve, line, dot, off: k / 3 };
    });
  }, [home]);

  useFrame(({ clock }) => {
    if (!home) return;
    const { T, mode, statuses } = useMap.getState();
    const now = (h: typeof home) => (mode === 'live' ? statuses[h!.idx] ?? 'normal' : statusAt(h!, T));
    const hs = live.homeScale;
    void hs;
    ring.current.scale.setScalar(reduce ? 1 : 1 + 0.08 * Math.sin(clock.elapsedTime * 3.3));
    const mine = now(home);
    for (const a of arcs) {
      const s = now(a.n);
      (a.line.material as THREE.LineBasicMaterial).color.set(s === 'normal' ? '#ffffff' : STATUS_COLOR[s]);
      a.dot.visible = mine === 'enroute' || s === 'enroute';
      a.curve.getPoint(1 - ((clock.elapsedTime / 1.8 + a.off) % 1), a.dot.position);
    }
  });

  if (!home) return null;
  return (
    <group>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[home.x, 0.14, home.z]}>
        <ringGeometry args={[1.9, 2.25, 40]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      {arcs.map((a, i) => (
        <group key={i}>
          <primitive object={a.line} />
          <primitive object={a.dot} />
        </group>
      ))}
    </group>
  );
}
