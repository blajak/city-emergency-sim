import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bounds } from '../sim/world/types';

const SKY = 0xcfe6f3;
const SHADOW_MAP_SIZE = 4096;
/** Direction the sunlight travels (from the sun towards the ground), roughly normalised. */
const SUN_DIRECTION = new THREE.Vector3(0.45, 0.8, -0.32);

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
  const spanForFog = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  scene.fog = new THREE.Fog(SKY, Math.max(700, spanForFog * 1.6), Math.max(1500, spanForFog * 3.6));

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);

  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 2, Math.max(3000, span * 5));
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
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  /**
   * The shadow map only covers the area around the camera target and scales
   * with zoom, so shadows stay crisp in a big city. The target is snapped to
   * whole shadow texels to avoid shimmering while the camera moves.
   */
  let shadowHalf = 0;
  const updateSun = () => {
    const distance = camera.position.distanceTo(controls.target);
    const half = THREE.MathUtils.clamp(distance * 0.75, 70, span * 0.62);
    const texel = (2 * half) / SHADOW_MAP_SIZE;
    const tx = Math.round(controls.target.x / texel) * texel;
    const tz = Math.round(controls.target.z / texel) * texel;
    sun.target.position.set(tx, 0, tz);
    sun.position.set(tx - SUN_DIRECTION.x * half * 2, SUN_DIRECTION.y * half * 2, tz - SUN_DIRECTION.z * half * 2);
    if (Math.abs(half - shadowHalf) > half * 0.02) {
      shadowHalf = half;
      Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: half * 6 });
      sun.shadow.camera.updateProjectionMatrix();
    }
  };
  updateSun();

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
        updateSun();
        renderer.render(scene, camera);
      });
    },
  };
}
