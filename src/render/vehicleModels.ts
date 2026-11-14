import * as THREE from 'three';
import type { VehicleModel } from '../sim/traffic/vehicle';
import { Frame, GeometryBuilder, addBox } from './geometryBuilder';

const GLASS = new THREE.Color(0x26323c);
const TYRE = new THREE.Color(0x1c1c1c);
const HEADLIGHT = new THREE.Color(0xfff3cf);
const TAILLIGHT = new THREE.Color(0xc62828);
const BUMPER = new THREE.Color(0x3a3d40);
const WHITE = new THREE.Color(0xf4f4f0);
const STEEL = new THREE.Color(0xaeb4ba);
const POLICE_BLUE = new THREE.Color(0x1f4fa3);

/** Where flashing beacons sit on a model (local coordinates, front = +z). */
export interface BeaconMount {
  x: number;
  y: number;
  z: number;
}

/**
 * A vehicle model split for instancing: `paint` parts are white and get the
 * per-vehicle colour as instance colour; `fixed` parts keep their own colours.
 */
export interface VehicleModelGeometry {
  paint: THREE.BufferGeometry;
  fixed: THREE.BufferGeometry;
  beacons: BeaconMount[];
}

const WHITE_PAINT = new THREE.Color(0xffffff);

/** Low-poly vehicle centred at the origin, front towards local +z. */
export function buildVehicleModel(model: VehicleModel, length: number, width: number): VehicleModelGeometry {
  const paintBuilder = new GeometryBuilder();
  const fixedBuilder = new GeometryBuilder();
  const frame = new Frame(0, 0, 0);
  const hl = length / 2;
  const hw = width / 2;
  /** Marker colour: parts drawn in `paint` take the vehicle's own colour. */
  const paint = WHITE_PAINT;
  const box = (ox: number, oz: number, halfW: number, halfD: number, y0: number, y1: number, color: THREE.Color, topColor?: THREE.Color) => {
    if (color === paint) {
      addBox(paintBuilder, { frame, ox, oz, halfW, halfD, y0, y1, color });
    } else if (topColor === paint) {
      // e.g. a glass cabin with a painted roof: thin painted slab on top.
      addBox(fixedBuilder, { frame, ox, oz, halfW, halfD, y0, y1, color });
      addBox(paintBuilder, { frame, ox, oz, halfW: halfW + 0.01, halfD: halfD + 0.01, y0: y1, y1: y1 + 0.04, color: paint });
    } else {
      addBox(fixedBuilder, { frame, ox, oz, halfW, halfD, y0, y1, color, topColor });
    }
  };

  const wheels = (radius: number, axles: number[]) => {
    for (const sx of [-1, 1]) for (const z of axles) box(sx * (hw - 0.22), z, 0.2, radius * 0.55, 0, radius * 1.05, TYRE);
  };
  const lights = (y0: number) => {
    for (const sx of [-1, 1]) {
      box(sx * (hw - 0.32), hl + 0.01, 0.2, 0.02, y0, y0 + 0.16, HEADLIGHT);
      box(sx * (hw - 0.3), -hl - 0.01, 0.2, 0.02, y0, y0 + 0.16, TAILLIGHT);
    }
    box(0, hl + 0.02, hw - 0.05, 0.06, 0.3, 0.48, BUMPER);
    box(0, -hl - 0.02, hw - 0.05, 0.06, 0.3, 0.48, BUMPER);
  };
  const beacons: BeaconMount[] = [];

  switch (model) {
    case 'fire_engine': {
      const cab = 2.3;
      wheels(0.95, [hl - 1.4, -hl + 1.7]);
      // Equipment body and cab.
      box(0, -cab / 2, hw, hl - cab / 2, 0.5, 2.9, paint);
      box(0, hl - cab / 2, hw - 0.05, cab / 2, 0.5, 2.55, paint);
      box(0, hl + 0.01, hw - 0.2, 0.02, 1.45, 2.35, GLASS);
      box(0, hl - 0.95, hw + 0.01, 0.6, 1.5, 2.3, GLASS);
      // Locker shutters and a white stripe along both sides.
      for (const z of [-hl + 1.4, -hl + 3.2, -hl + 5]) box(0, z, hw + 0.02, 0.75, 0.85, 2.6, STEEL);
      box(0, 0, hw + 0.04, hl - 0.05, 1.05, 1.25, WHITE);
      // Ladder on the roof.
      for (const sx of [-1, 1]) box(sx * 0.45, -cab / 2 + 0.2, 0.06, hl - cab / 2 - 0.3, 2.95, 3.1, STEEL);
      for (let z = -hl + 0.7; z < hl - cab - 0.2; z += 0.6) box(0, z, 0.45, 0.04, 2.98, 3.06, STEEL);
      lights(0.75);
      beacons.push({ x: -0.6, y: 2.7, z: hl - 0.5 }, { x: 0.6, y: 2.7, z: hl - 0.5 });
      break;
    }
    case 'police_car': {
      wheels(0.66, [hl - 0.9, -hl + 0.9]);
      box(0, 0, hw, hl, 0.32, 0.98, paint);
      box(0, 0, hw + 0.01, hl - 0.4, 0.55, 0.75, POLICE_BLUE);
      box(0, -0.25, hw - 0.14, 1.15, 0.98, 1.48, GLASS, paint);
      // Light bar base.
      box(0, -0.15, 0.62, 0.18, 1.48, 1.56, BUMPER);
      lights(0.62);
      beacons.push({ x: -0.35, y: 1.64, z: -0.15 }, { x: 0.35, y: 1.64, z: -0.15 });
      break;
    }
    case 'van': {
      const cabFront = hl - 0.9;
      wheels(0.66, [hl - 0.85, -hl + 0.85]);
      box(0, -0.45, hw, hl - 0.45, 0.32, 2.15, paint);
      box(0, cabFront + 0.45, hw - 0.04, 0.45, 0.32, 1.05, paint);
      box(0, cabFront - 0.02, hw - 0.12, 0.05, 1.15, 1.95, GLASS);
      box(0, cabFront - 0.6, hw + 0.01, 0.45, 1.2, 1.85, GLASS);
      lights(0.7);
      break;
    }
    case 'sedan':
    case 'hatchback': {
      wheels(0.66, [hl - 0.85, -hl + 0.85]);
      const cabinLength = model === 'sedan' ? 2.3 : 2.2;
      const cabinOffset = model === 'sedan' ? -0.25 : -(hl - cabinLength / 2 - 0.25);
      box(0, 0, hw, hl, 0.32, 0.98, paint);
      box(0, cabinOffset, hw - 0.14, cabinLength / 2, 0.98, 1.48, GLASS, paint);
      lights(0.62);
      break;
    }
  }

  return { paint: paintBuilder.build(), fixed: fixedBuilder.build(), beacons };
}
