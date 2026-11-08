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
      <fogExp2 attach="fog" args={[HAZE, 0.0045]} />
      <hemisphereLight args={['#c8dade', '#0b1214', 1.1]} />
      <directionalLight position={[-40, 80, 30]} intensity={0.7} color="#d8e6ea" />
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
