import * as THREE from 'three';
import type { Bounds, LampSpot, TreeSpot } from '../sim/world/types';
import { STREET_CLEARANCE } from '../sim/world/constants';

const TREE_GREENS = [0x5f9a48, 0x6fae52, 0x4e8a43, 0x7bb35c, 0x5a8f3e];

export function createTreesView(trees: readonly TreeSpot[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';

  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.32, 2.4, 6).translate(0, 1.2, 0),
    new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 1 }),
    trees.length,
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(2.2, 0).translate(0, 3.8, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
    trees.length,
  );

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const tint = new THREE.Color();
  trees.forEach((tree, i) => {
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.tint * Math.PI * 2);
    matrix.compose(
      new THREE.Vector3(tree.pos.x, 0, tree.pos.z),
      quat,
      new THREE.Vector3(tree.scale, tree.scale * (0.9 + tree.tint * 0.3), tree.scale),
    );
    trunks.setMatrixAt(i, matrix);
    crowns.setMatrixAt(i, matrix);
    crowns.setColorAt(i, tint.setHex(TREE_GREENS[Math.floor(tree.tint * TREE_GREENS.length)]));
  });

  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export function createLampsView(lamps: readonly LampSpot[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lamps';
  const material = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.6, metalness: 0.3 });

  const pole = new THREE.CylinderGeometry(0.07, 0.1, 5.5, 6).translate(0, 2.75, 0);
  // Arm and head reach towards the road (local +z).
  const arm = new THREE.BoxGeometry(0.08, 0.08, 1.2).translate(0, 5.45, 0.6);
  const head = new THREE.BoxGeometry(0.35, 0.18, 0.7).translate(0, 5.35, 1.25);

  const meshes = [pole, arm, head].map((geometry) => {
    const mesh = new THREE.InstancedMesh(geometry, material, lamps.length);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  });

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  lamps.forEach((lamp, i) => {
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), lamp.rotation);
    matrix.compose(new THREE.Vector3(lamp.pos.x, 0.12, lamp.pos.z), quat, one);
    for (const mesh of meshes) mesh.setMatrixAt(i, matrix);
  });
  return group;
}

/** Diorama base: grass top with earthy sides. */
export function createGroundView(bounds: Bounds): THREE.Mesh {
  const width = bounds.maxX - bounds.minX + STREET_CLEARANCE * 2;
  const depth = bounds.maxZ - bounds.minZ + STREET_CLEARANCE * 2;
  const thickness = 6;
  const side = new THREE.MeshStandardMaterial({ color: 0x7a5c43, roughness: 1 });
  const grass = new THREE.MeshStandardMaterial({ color: 0x9cc075, roughness: 1 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, thickness, depth), [
    side,
    side,
    grass,
    side,
    side,
    side,
  ]);
  mesh.position.set((bounds.minX + bounds.maxX) / 2, -thickness / 2, (bounds.minZ + bounds.maxZ) / 2);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}
