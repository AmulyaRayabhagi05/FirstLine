import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useMap } from '../state/store';
import { homes, clamp, lerp, world } from '../sim/world';
import { live, easeInOut } from './live';

type Pose = { theta: number; phi: number; radius: number; tx: number; tz: number };
const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const phiFor = (d: number) => lerp(0.02, 1.0, d);
const radiusFor = (d: number) => lerp(128, 96, d) * Math.max(1, world.radius / 60) * (d < 0.5 ? 1 : 0.9);

// Orbit camera with smooth fly-tos: rotate, pan, zoom, the 2D/3D slide, zoom to a home, and the demo sweep.
export function CameraRig() {
  const { camera, gl } = useThree();
  const rig = useRef({ target: new THREE.Vector3(), theta: 0.75, phi: 1.0, radius: 96 });
  const anim = useRef<{ f: Pose; t: Pose; t0: number; dur: number } | null>(null);
  const saved = useRef<Pose | null>(null);
  const lastCamPush = useRef(0);

  const pose = (): Pose => ({ theta: rig.current.theta, phi: rig.current.phi, radius: rig.current.radius, tx: rig.current.target.x, tz: rig.current.target.z });
  const flyTo = (to: Partial<Pose>, dur = 1100) => {
    const f = pose();
    const t = { ...f, ...to };
    if (reduce) {
      Object.assign(rig.current, { theta: t.theta, phi: t.phi, radius: t.radius });
      rig.current.target.set(t.tx, 0, t.tz);
      anim.current = null;
      return;
    }
    anim.current = { f, t, t0: performance.now(), dur };
  };

  // react to store changes: 2D/3D slide, selection, demo start, minimap pan
  useEffect(() => {
    let prev = useMap.getState();
    return useMap.subscribe((s) => {
      if (s.selectedId !== prev.selectedId) {
        if (s.selectedId !== null) {
          const h = homes.find((x) => x.id === s.selectedId)!;
          if (prev.selectedId === null) saved.current = pose();
          const flat = s.dimTarget < 0.5;
          flyTo({ tx: h.x, tz: h.z, phi: flat ? 0.05 : 0.95, radius: flat ? 36 : 26 });
        } else if (saved.current) {
          flyTo(saved.current, 1000);
          saved.current = null;
        }
      } else if (s.dimTarget !== prev.dimTarget && s.demo !== 'sweep') {
        if (s.selectedId === null) flyTo({ phi: phiFor(s.dimTarget), radius: radiusFor(s.dimTarget), tx: 0, tz: 0 });
        else flyTo({ phi: s.dimTarget < 0.5 ? 0.05 : 0.95, radius: s.dimTarget < 0.5 ? 36 : 26 }, 900);
      }
      if (s.demo === 'sweep' && prev.demo !== 'sweep') {
        anim.current = null;
        live.dim = 1;
        Object.assign(rig.current, { theta: 0.3, phi: 1.28, radius: 34 });
        rig.current.target.set(-6, 0, 4);
      }
      if (s.panTo && s.panTo !== prev.panTo) flyTo({ tx: s.panTo.x, tz: s.panTo.z }, 700);
      if (s.worldVersion !== prev.worldVersion && s.selectedId === null) flyTo({ phi: phiFor(s.dimTarget), radius: radiusFor(s.dimTarget), tx: 0, tz: 0 }, 1200);
      prev = s;
    });
  }, []);

  // pointer controls
  useEffect(() => {
    const el = gl.domElement;
    const pointers = new Map<number, { x: number; y: number; btn: number; shift: boolean }>();
    let pinch = 0;
    const stopDemo = () => {
      const st = useMap.getState();
      if (st.demo !== 'off') st.setDemo('off');
    };
    const pan = (dx: number, dy: number) => {
      const r = rig.current;
      const s = r.radius * 0.0016;
      const c = Math.cos(r.theta);
      const n = Math.sin(r.theta);
      const lim = world.radius + 20;
      r.target.x = clamp(r.target.x + (-c * dx - n * dy) * s, -lim, lim);
      r.target.z = clamp(r.target.z + (n * dx - c * dy) * s, -lim, lim);
    };
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey });
      anim.current = null;
      stopDemo();
      el.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      const r = rig.current;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) r.radius = clamp((r.radius * pinch) / d, 12, 360);
        pinch = d;
        return;
      }
      if (p.btn === 2 || p.shift || live.dim < 0.2) pan(dx, dy);
      else {
        r.theta -= dx * 0.006;
        r.phi = clamp(r.phi - dy * 0.005, 0.02, 1.42);
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      el.style.cursor = '';
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      rig.current.radius = clamp(rig.current.radius * Math.exp(e.deltaY * 0.0011), 12, 360);
      anim.current = null;
      stopDemo();
    };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', ctx);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
    };
  }, [gl]);

  useFrame((state, dt) => {
    const st = useMap.getState();
    // ease the 2D/3D morph
    if (Math.abs(live.dim - st.dimTarget) > 0.0005) {
      live.dim = reduce ? st.dimTarget : lerp(live.dim, st.dimTarget, Math.min(1, dt * 3.2));
      if (Math.abs(live.dim - st.dimTarget) < 0.002) live.dim = st.dimTarget;
    }
    const r = rig.current;
    if (st.intro && !anim.current) r.theta += dt * 0.035; // slow drift behind the intro
    if (st.demo === 'sweep') {
      // slow orbit that rises over the street while the flood arrives
      const k = clamp(st.T / 1.4, 0, 1);
      r.theta += dt * 0.12;
      r.radius = lerp(34, 70, k);
      r.phi = lerp(1.28, 1.05, k);
      r.target.set(lerp(-6, 0, k), 0, lerp(4, 0, k));
    }
    if (anim.current) {
      const a = anim.current;
      const k = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = easeInOut(k);
      const dTh = ((((a.t.theta - a.f.theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      r.theta = a.f.theta + dTh * e;
      r.phi = lerp(a.f.phi, a.t.phi, e);
      r.radius = lerp(a.f.radius, a.t.radius, e);
      r.target.set(lerp(a.f.tx, a.t.tx, e), 0, lerp(a.f.tz, a.t.tz, e));
      if (k >= 1) anim.current = null;
    }
    camera.position.set(r.target.x + r.radius * Math.sin(r.phi) * Math.sin(r.theta), r.radius * Math.cos(r.phi), r.target.z + r.radius * Math.sin(r.phi) * Math.cos(r.theta));
    camera.lookAt(r.target);
    const fog = state.scene.fog as THREE.FogExp2 | null;
    if (fog) fog.density = 0.0068 * (1 - (1 - live.dim) * 0.85);
    const now = performance.now();
    if (now - lastCamPush.current > 120) {
      lastCamPush.current = now;
      st.setCam({ x: r.target.x, z: r.target.z, theta: r.theta });
    }
  });
  return null;
}
