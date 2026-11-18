import * as THREE from 'three';
import type { CarModel } from '../sim/rail/railSystem';
import { Frame, GeometryBuilder, type V3, addBox, addFacing } from './geometryBuilder';

/** Rail car models, centred at the origin, front (towards higher track s) along local +z. */

const c = (hex: number) => new THREE.Color(hex);
const BOGIE = c(0x2a2d31);
const GLASS = c(0x2c3a46);
const ROOF = c(0x8d949b);

export function buildCarModel(model: CarModel, length: number): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  const f = new Frame(0, 0, 0);
  const hl = length / 2;
  const box = (ox: number, oz: number, hw: number, hd: number, y0: number, y1: number, color: THREE.Color, top?: THREE.Color) =>
    addBox(b, { frame: f, ox, oz, halfW: hw, halfD: hd, y0, y1, color, topColor: top });

  // Bogies.
  for (const z of [-hl + 2.6, hl - 2.6]) box(0, z, 1.1, 1.3, 0.25, 0.85, BOGIE);

  switch (model) {
    case 'emu_cab':
    case 'emu_middle': {
      const white = c(0xf2f3f1);
      const nose = model === 'emu_cab' ? 2.2 : 0;
      box(0, -nose / 2, 1.45, hl - nose / 2, 0.85, 3.7, white, ROOF);
      box(0, -nose / 2, 1.47, hl - nose / 2 - 0.2, 1.05, 1.45, c(0xc62828));
      box(0, -nose / 2, 1.47, hl - nose / 2 - 0.4, 2.2, 3.0, GLASS);
      // Doors (two per side).
      for (const z of [-hl * 0.45, hl * 0.35 - nose / 2]) box(0, z, 1.48, 0.7, 0.95, 3.1, c(0xd8dadc));
      if (model === 'emu_cab') {
        // Sloped nose with a windscreen.
        const z0 = hl - nose;
        const quad = (pts: V3[], toward: V3, color: THREE.Color) => addFacing(b, f, pts, toward, color);
        quad([[-1.45, 0.85, z0], [1.45, 0.85, z0], [1.45, 0.85, hl], [-1.45, 0.85, hl]], [0, -1, 0], white);
        quad([[-1.45, 0.85, hl], [1.45, 0.85, hl], [1.45, 2.0, hl], [-1.45, 2.0, hl]], [0, 0, 1], white);
        quad([[-1.45, 2.0, hl], [1.45, 2.0, hl], [1.45, 3.7, z0], [-1.45, 3.7, z0]], [0, 1, 1], GLASS);
        for (const sx of [-1, 1]) {
          quad([[sx * 1.45, 0.85, z0], [sx * 1.45, 0.85, hl], [sx * 1.45, 2.0, hl], [sx * 1.45, 3.7, z0]], [sx, 0, 0], white);
          box(sx * 0.95, hl + 0.02, 0.25, 0.02, 1.2, 1.45, c(0xfff3cf));
        }
        box(0, hl + 0.03, 1.2, 0.03, 1.05, 1.5, c(0xc62828));
      } else {
        // Pantograph.
        box(0, 0, 0.9, 0.08, 3.7, 4.4, c(0x55595e));
        box(0, 0, 0.9, 0.5, 4.4, 4.5, c(0x55595e));
      }
      break;
    }
    case 'freight_loco': {
      const paint = c(0xe2672a);
      box(0, 0, 1.45, hl - 0.2, 0.85, 1.25, c(0x3a3f45));
      box(0, -hl * 0.45, 1.25, hl * 0.42, 1.25, 3.4, paint, c(0x6f757b));
      box(0, hl * 0.45, 1.25, hl * 0.42, 1.25, 3.4, paint, c(0x6f757b));
      box(0, 0, 1.45, 1.3, 1.25, 4.1, paint, ROOF);
      box(0, 0, 1.47, 1.0, 2.9, 3.7, GLASS);
      box(0, 0, 1.47, 1.2, 1.6, 1.9, c(0xf3c623));
      for (const z of [-hl - 0.02, hl + 0.02]) box(0, z, 1.3, 0.05, 1.0, 1.3, c(0xf3c623));
      break;
    }
    case 'container_wagon': {
      // Flat with corner pins; containers are drawn separately (FreightView).
      box(0, 0, 1.4, hl - 0.2, 0.85, 1.25, c(0x3a3f45));
      for (const x of [-1.15, 1.15]) for (const z of [-hl + 0.4, hl - 0.4]) box(x, z, 0.12, 0.12, 1.25, 1.45, c(0xf3c623));
      break;
    }
  }
  return b.build();
}
