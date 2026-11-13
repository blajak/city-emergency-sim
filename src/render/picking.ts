import * as THREE from 'three';
import type { Building } from '../sim/world/types';
import { roofTop } from './buildingsView';

const box = new THREE.Box3();
const localRay = new THREE.Ray();
const rotation = new THREE.Matrix4();
const hit = new THREE.Vector3();

/** Nearest building hit by the ray (tests each footprint as an oriented box). */
export function pickBuilding(ray: THREE.Ray, buildings: readonly Building[]): Building | null {
  let best: Building | null = null;
  let bestDistance = Infinity;
  for (const b of buildings) {
    const { center, halfW, halfD } = b.footprint;
    rotation.makeRotationY(-b.footprint.rotation);
    localRay.origin.set(ray.origin.x - center.x, ray.origin.y, ray.origin.z - center.z).applyMatrix4(rotation);
    localRay.direction.copy(ray.direction).applyMatrix4(rotation);
    box.min.set(-halfW, 0, -halfD);
    box.max.set(halfW, roofTop(b), halfD);
    if (!localRay.intersectBox(box, hit)) continue;
    const distance = hit.distanceTo(localRay.origin);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = b;
    }
  }
  return best;
}

/** Translucent box shown around the building under the cursor. */
export class BuildingHighlight {
  readonly object = new THREE.Group();
  private readonly fill: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private readonly edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;

  constructor() {
    const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.fill = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial());
    this.object.add(this.fill, this.edges);
    this.object.visible = false;
  }

  show(building: Building, color: number): void {
    const { center, halfW, halfD, rotation } = building.footprint;
    const pad = 0.4;
    this.object.position.set(center.x, 0, center.z);
    this.object.rotation.y = rotation;
    this.object.scale.set(halfW * 2 + pad, roofTop(building) + pad, halfD * 2 + pad);
    this.fill.material.color.setHex(color);
    this.edges.material.color.setHex(color);
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }
}
