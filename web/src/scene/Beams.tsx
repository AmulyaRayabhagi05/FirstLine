import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { homes, type Status } from '../sim/world';
import { useMap, STATUS_COLOR } from '../state/store';
import { live } from './live';

// Every registered household shows a calm green porch beam; trouble makes it tall and red.
// Homes with no registered household stay dark.
const BEAM_H: Record<Status, number> = { p1: 28, p2: 24, unknown: 20, enroute: 14, safe: 5.5, normal: 5.5 };
const DOT_S: Record<Status, number> = { p1: 1.7, p2: 1.5, unknown: 1.35, enroute: 1.2, safe: 0.7, normal: 0.7 };
const COLORS = Object.fromEntries(Object.entries(STATUS_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<Status, THREE.Color>;
const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A light cone: per-home color, bright at the base and fading with height.
function beamMaterial(opacity: number, falloff: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: opacity } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vCol;
      void main(){
        vUv = uv; vCol = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #endif
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; varying vec2 vUv; varying vec3 vCol;
      void main(){ float a = pow(1.0 - vUv.y, ${falloff.toFixed(1)}); gl_FragColor = vec4(vCol, a * uOpacity); }`,
  });
}

const coreGeo = new THREE.CylinderGeometry(0.07, 0.13, 1, 8, 1, true).translate(0, 0.5, 0);
const haloGeo = new THREE.CylinderGeometry(0.12, 1.25, 1, 20, 1, true).translate(0, 0.5, 0);
const dotGeo = new THREE.CircleGeometry(0.9, 24).rotateX(-Math.PI / 2);
const dummy = new THREE.Object3D();

// Porch beams in 3D; glowing dots on the 2D map. Height and pulse follow urgency.
export function Beams() {
  const cores = useRef<THREE.InstancedMesh>(null!);
  const halos = useRef<THREE.InstancedMesh>(null!);
  const dots = useRef<THREE.InstancedMesh>(null!);
  const coreMat = useMemo(() => beamMaterial(0.95, 0.6), []);
  const haloMat = useMemo(() => beamMaterial(0.32, 1.8), []);
  const dotMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const version = useMap((s) => s.version);
  const statuses = useMap((s) => s.statuses);

  useEffect(() => {
    statuses.forEach((s, i) => {
      cores.current.setColorAt(i, COLORS[s]);
      halos.current.setColorAt(i, COLORS[s]);
      dots.current.setColorAt(i, COLORS[s]);
    });
    [cores, halos, dots].forEach((r) => (r.current.instanceColor!.needsUpdate = true));
  }, [version, statuses]);

  useFrame(({ clock }) => {
    const { statuses: st, showBeams, residents } = useMap.getState();
    const dim = live.dim;
    const hs = live.homeScale;
    // Beams stay at full strength across the slider; the flat 2D dots take over only at the very end,
    // so a half-tilted city still shows beams, not green discs on the roofs.
    const beamA = Math.min(1, Math.max(0, (dim - 0.04) / 0.16));
    coreMat.uniforms.uOpacity.value = 0.95 * beamA;
    haloMat.uniforms.uOpacity.value = 0.32 * beamA;
    dotMat.opacity = Math.min(1, Math.max(0, 1 - dim / 0.12)) * 0.95;
    cores.current.visible = halos.current.visible = showBeams && beamA > 0;
    dots.current.visible = showBeams && dotMat.opacity > 0;
    const pulse = reduce ? 1 : 0.8 + 0.2 * Math.sin(clock.elapsedTime * 3.8);
    homes.forEach((p, i) => {
      const s = st[i];
      const urgent = s === 'p1' || s === 'p2';
      const occupied = residents[i] != null;
      const h = occupied ? BEAM_H[s] * (urgent ? pulse : 1) : 0;
      const top = p.top * hs;
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(p.x, top - 0.2 * hs, p.z);
      dummy.scale.set(1, Math.max(0.0001, h), 1);
      dummy.updateMatrix();
      cores.current.setMatrixAt(i, dummy.matrix);
      const w = s === 'safe' || s === 'normal' ? 0.45 : 1;
      dummy.scale.set(w, Math.max(0.0001, h * 0.85), w);
      dummy.updateMatrix();
      halos.current.setMatrixAt(i, dummy.matrix);
      const ds = Math.max(0.0001, occupied ? DOT_S[s] * (urgent ? pulse : 1) : 0);
      dummy.position.set(p.x, top + 0.05, p.z);
      dummy.scale.set(ds, 1, ds);
      dummy.updateMatrix();
      dots.current.setMatrixAt(i, dummy.matrix);
    });
    cores.current.instanceMatrix.needsUpdate = halos.current.instanceMatrix.needsUpdate = dots.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={cores} args={[coreGeo, coreMat, homes.length]} raycast={() => null} frustumCulled={false} />
      <instancedMesh ref={halos} args={[haloGeo, haloMat, homes.length]} raycast={() => null} frustumCulled={false} />
      <instancedMesh ref={dots} args={[dotGeo, dotMat, homes.length]} raycast={() => null} frustumCulled={false} />
    </group>
  );
}
