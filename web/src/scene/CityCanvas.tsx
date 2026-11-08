import { Canvas } from '@react-three/fiber';
import { CameraRig } from './CameraRig';
import { Ground } from './Ground';
import { Homes } from './Homes';
import { Beams } from './Beams';
import { Heat } from './Heat';
import { Places } from './Places';
import { Selection } from './Selection';
import { Clock } from './Clock';
import { HAZE } from './live';

export function CityCanvas() {
  return (
    <Canvas className="stage" flat dpr={[1, 2]} camera={{ fov: 42, near: 0.5, far: 1200 }} gl={{ antialias: true }}>
      <color attach="background" args={[HAZE]} />
      <fogExp2 attach="fog" args={[HAZE, 0.0068]} />
      <hemisphereLight args={['#a9b8ff', '#0b0f22', 0.9]} />
      <directionalLight position={[-40, 80, 30]} intensity={0.6} color="#c6d2ff" />
      <CameraRig />
      <Clock />
      <Ground />
      <Heat />
      <Homes />
      <Places />
      <Beams />
      <Selection />
    </Canvas>
  );
}
