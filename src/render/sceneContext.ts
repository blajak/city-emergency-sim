import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bounds } from '../sim/world/types';

const SKY = 0xcfe6f3;
const NIGHT_SKY = 0x0d1729;
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
  /** Night: dark sky, dim blue moonlight instead of the sun. */
  setNight(night: boolean): void;
  /**
   * Keeps the camera on a moving target (same zoom and angle; rotating still
   * works). Returning null from `target`, panning (right drag, WASD / arrows)
   * or `follow(null)` stops it; `onStop` is then called.
   */
  follow(target: (() => { x: number; z: number } | null) | null, onStop?: () => void): void;
}

/** How quickly the follow camera catches up with its target, 1/s. */
const FOLLOW_RATE = 6;

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
  // Bird's-eye navigation: left-drag rotates, right-drag (or two fingers) moves
  // over the map, keeping the camera height; scroll zooms towards the cursor.
  controls.enablePan = true;
  controls.screenSpacePanning = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
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

  const hemisphere = new THREE.HemisphereLight(0xeaf4ff, 0x7d8a63, 1.6);
  scene.add(hemisphere);
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

  const keyboardPan = createKeyboardPan(camera, controls, bounds);

  // --- Follow camera ---------------------------------------------------------
  let followTarget: (() => { x: number; z: number } | null) | null = null;
  let onFollowStop: (() => void) | undefined;
  const stopFollow = () => {
    if (!followTarget) return;
    followTarget = null;
    controls.zoomToCursor = true;
    const done = onFollowStop;
    onFollowStop = undefined;
    done?.();
  };
  // Panning takes the camera back (rotating with the left button and zooming don't).
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button === 2) stopFollow();
  });
  keyboardPan.onPan(stopFollow);
  const followStep = (dt: number) => {
    if (!followTarget) return;
    const p = followTarget();
    if (!p) return stopFollow();
    const k = Math.min(1, dt * FOLLOW_RATE);
    const dx = (p.x - controls.target.x) * k;
    const dz = (p.z - controls.target.z) * k;
    controls.target.x += dx;
    controls.target.z += dz;
    camera.position.x += dx;
    camera.position.z += dz;
  };

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
    setNight(night) {
      const sky = night ? NIGHT_SKY : SKY;
      (scene.background as THREE.Color).setHex(sky);
      scene.fog?.color.setHex(sky);
      hemisphere.color.setHex(night ? 0x5a6f9e : 0xeaf4ff);
      hemisphere.groundColor.setHex(night ? 0x1a2030 : 0x7d8a63);
      hemisphere.intensity = night ? 0.55 : 1.6;
      sun.color.setHex(night ? 0x9fb4ff : 0xfff3df);
      sun.intensity = night ? 0.35 : 2.6;
    },
    follow(target, onStop) {
      stopFollow();
      if (!target) return;
      followTarget = target;
      onFollowStop = onStop;
      // Zooming towards the cursor would move the target off the vehicle.
      controls.zoomToCursor = false;
    },
    start(onFrame) {
      const clock = new THREE.Clock();
      renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), 0.1);
        keyboardPan.update(dt);
        onFrame?.(dt);
        followStep(dt);
        controls.update();
        updateSun();
        renderer.render(scene, camera);
      });
    },
  };
}

const PAN_KEYS: Record<string, [number, number]> = {
  arrowup: [0, 1],
  w: [0, 1],
  arrowdown: [0, -1],
  s: [0, -1],
  arrowleft: [-1, 0],
  a: [-1, 0],
  arrowright: [1, 0],
  d: [1, 0],
};

/**
 * Arrow keys / WASD move the view over the map relative to where the camera
 * looks; speed grows with zoom-out, Shift doubles it.
 */
function createKeyboardPan(camera: THREE.PerspectiveCamera, controls: OrbitControls, bounds: Bounds) {
  const held = new Set<string>();
  const panListeners: (() => void)[] = [];
  let fast = false;
  const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  window.addEventListener('keydown', (e) => {
    fast = e.shiftKey;
    const key = e.key.toLowerCase();
    if (!(key in PAN_KEYS) || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    held.add(key);
    e.preventDefault();
    for (const listener of panListeners) listener();
  });
  window.addEventListener('keyup', (e) => {
    fast = e.shiftKey;
    held.delete(e.key.toLowerCase());
  });
  window.addEventListener('blur', () => held.clear());

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();
  return {
    /** Called whenever a pan key goes down. */
    onPan(listener: () => void): void {
      panListeners.push(listener);
    },
    update(dt: number): void {
      if (held.size === 0) return;
      let x = 0;
      let y = 0;
      for (const key of held) {
        x += PAN_KEYS[key][0];
        y += PAN_KEYS[key][1];
      }
      if (x === 0 && y === 0) return;
      // Ground-plane directions from the camera's heading.
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      right.crossVectors(forward, camera.up).normalize();
      const speed = camera.position.distanceTo(controls.target) * 0.9 * (fast ? 2 : 1);
      move.copy(forward).multiplyScalar(y).addScaledVector(right, x).normalize().multiplyScalar(speed * dt);
      // Stay over the map.
      const t = controls.target;
      move.x = THREE.MathUtils.clamp(t.x + move.x, bounds.minX, bounds.maxX) - t.x;
      move.z = THREE.MathUtils.clamp(t.z + move.z, bounds.minZ, bounds.maxZ) - t.z;
      t.add(move);
      camera.position.add(move);
    },
  };
}
