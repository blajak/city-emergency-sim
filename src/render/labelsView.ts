import * as THREE from 'three';
import type { District } from '../sim/world/types';

/** Camera distances between which district names fade in. */
const FADE_START = 380;
const FADE_END = 560;
const LABEL_HEIGHT = 55;
const LABEL_SCREEN_SIZE = 0.032;

/** District names floating over the map, shown when zoomed out. */
export class DistrictLabelsView {
  readonly group = new THREE.Group();
  private readonly materials: THREE.SpriteMaterial[] = [];

  constructor(districts: readonly District[]) {
    this.group.name = 'district-labels';
    for (const d of districts) {
      const { texture, aspect } = labelTexture(d.name.toUpperCase());
      // Constant size on screen (fraction of the viewport height), whatever the zoom.
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0, sizeAttenuation: false });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(d.center.x, LABEL_HEIGHT, d.center.z);
      sprite.scale.set(LABEL_SCREEN_SIZE * aspect, LABEL_SCREEN_SIZE, 1);
      sprite.renderOrder = 20;
      this.materials.push(material);
      this.group.add(sprite);
    }
  }

  update(camera: THREE.Camera, target: THREE.Vector3): void {
    const distance = camera.position.distanceTo(target);
    const opacity = THREE.MathUtils.clamp((distance - FADE_START) / (FADE_END - FADE_START), 0, 1);
    for (const m of this.materials) m.opacity = opacity;
    this.group.visible = opacity > 0.01;
  }
}

function labelTexture(text: string): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = 'bold 64px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 64;
  canvas.width = width;
  canvas.height = 112;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(20, 30, 40, 0.75)';
  ctx.strokeText(text, width / 2, 58);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, width / 2, 58);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: width / canvas.height };
}
