import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { ANCHORS, COMMS } from '../sim/world';
import { useMap } from '../state/store';
import { live } from './live';

// Hospitals and shelters (they flatten in 2D like the homes), plus community and place labels.
export function Places() {
  const groups = useRef<(THREE.Group | null)[]>([]);
  const selected = useMap((s) => s.selectedId);
  const showNames = useMap((s) => s.showNames);
  const intro = useMap((s) => s.intro);
  useFrame(() => groups.current.forEach((g) => g && g.scale.set(1, Math.max(0.05, live.homeScale), 1)));

  return (
    <group>
      {ANCHORS.map((a, i) => (
        <group key={i} position={[a.x, 0, a.z]}>
          <group ref={(el) => (groups.current[i] = el)}>
            {a.type === 'hospital' ? (
              <>
                <mesh position-y={2.25}>
                  <boxGeometry args={[5, 4.5, 4]} />
                  <meshLambertMaterial color="#d9deea" />
                </mesh>
                <mesh position-y={4.56}>
                  <boxGeometry args={[2.4, 0.1, 0.7]} />
                  <meshBasicMaterial color="#e8283d" />
                </mesh>
                <mesh position-y={4.56}>
                  <boxGeometry args={[0.7, 0.1, 2.4]} />
                  <meshBasicMaterial color="#e8283d" />
                </mesh>
              </>
            ) : (
              <>
                <mesh position-y={1.1}>
                  <boxGeometry args={[5.5, 2.2, 4]} />
                  <meshLambertMaterial color="#b7d4c2" />
                </mesh>
                <mesh position-y={2.6} rotation-z={Math.PI / 2}>
                  <cylinderGeometry args={[2.1, 2.1, 5.6, 3, 1]} />
                  <meshLambertMaterial color="#2e7d5b" />
                </mesh>
              </>
            )}
          </group>
          <mesh rotation-x={-Math.PI / 2} position-y={0.1}>
            <ringGeometry args={[3.6, 3.9, 40]} />
            <meshBasicMaterial color={a.type === 'hospital' ? '#ffffff' : '#4fe08f'} transparent opacity={0.6} side={THREE.DoubleSide} />
          </mesh>
          {!intro && (
            <Html position={[0, 6.5, 0]} center zIndexRange={[4, 0]} className="tag-anchor">
              <span className={a.type === 'hospital' ? 'red' : 'green'}>{a.type === 'hospital' ? '+' : '⌂'}</span> {a.label}
            </Html>
          )}
        </group>
      ))}
      {showNames &&
        !intro &&
        selected === null &&
        COMMS.map((c) => (
          <Html key={c.name} position={[c.x, 3, c.z]} center zIndexRange={[3, 0]} className="tag-comm">
            {c.name}
          </Html>
        ))}
    </group>
  );
}
