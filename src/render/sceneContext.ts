import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bounds } from '../sim/world/types';

const SKY = 0xcfe6f3;

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Starts the render loop; `onFrame` receives elapsed seconds since the last frame. */
  start(onFrame?: (dt: number) => void): void;
  /**
   * Screen space covered by UI on the right / bottom, in px. The view is
   * shifted so the city stays centred in the visible area.
   */
  setViewInsets(right: number, bottom: number): void;
}

export function createSceneContext(container: HTMLElement, bounds: Bounds): SceneContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 700, 1500);

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);

  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 2, 3000);
  // Portrait screens need more distance to fit the city's width.
  const fit = Math.max(1, Math.pow(1.25 / camera.aspect, 0.75));
  camera.position.set(centerX + span * 0.55 * fit, span * 0.75 * fit, centerZ + span * 0.95 * fit);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(centerX, 0, centerZ);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.zoomToCursor = true;
  controls.minDistance = 25;
  controls.maxDistance = span * 2.2;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
  // Zooming to the cursor moves the target; keep it over the map.
  controls.addEventListener('change', () => {
    const t = controls.target;
    t.x = THREE.MathUtils.clamp(t.x, bounds.minX, bounds.maxX);
    t.z = THREE.MathUtils.clamp(t.z, bounds.minZ, bounds.maxZ);
    t.y = 0;
  });
  controls.update();

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x7d8a63, 1.6));
  const sun = new THREE.DirectionalLight(0xfff3df, 2.6);
  sun.position.set(centerX - span * 0.35, span * 0.7, centerZ + span * 0.25);
  sun.target.position.set(centerX, 0, centerZ);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const half = span * 0.62;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 10, far: span * 2.5 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  let insets = { right: 0, bottom: 0 };
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.setViewOffset(w, h, insets.right / 2, insets.bottom / 2, w, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  return {
    scene,
    camera,
    renderer,
    controls,
    setViewInsets(right, bottom) {
      insets = { right, bottom };
      onResize();
    },
    start(onFrame) {
      const clock = new THREE.Clock();
      renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), 0.1);
        onFrame?.(dt);
        controls.update();
        renderer.render(scene, camera);
      });
    },
  };
}
