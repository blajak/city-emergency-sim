import * as THREE from 'three';
import type { Rng } from '../sim/math/rng';
import type { Building } from '../sim/world/types';
import { Frame, type GeometryBuilder, addBox } from './geometryBuilder';
import type { SignAtlas } from './textures';

/** Shared pieces for building models. */

export const ROOF_GREY = 0x8a8f96;
export const ROOF_TILES = [0xa4553f, 0x8e4a3a, 0x6d6f73, 0xb2654a];

/** One geometry builder per material; everything is merged into a few meshes. */
export interface Builders {
  /** Window texture, tinted by vertex colour. */
  facade: GeometryBuilder;
  /** Shopfront texture. */
  shop: GeometryBuilder;
  /** Plain vertex colours. */
  solid: GeometryBuilder;
  /** Sign atlas texture, unlit. */
  signs: GeometryBuilder;
  atlas: SignAtlas;
}

export const color = (hex: number) => new THREE.Color(hex);
export const shade = (hex: number, factor: number) => new THREE.Color(hex).multiplyScalar(factor);

export function frameOf(b: Building): Frame {
  return new Frame(b.footprint.center.x, b.footprint.center.z, b.footprint.rotation);
}

export function addCornice(solid: GeometryBuilder, frame: Frame, b: Building, trim: THREE.Color): void {
  addBox(solid, {
    frame,
    halfW: b.footprint.halfW + 0.25,
    halfD: b.footprint.halfD + 0.25,
    y0: b.height - 0.1,
    y1: b.height + 0.45,
    color: trim,
    topColor: color(ROOF_GREY),
  });
}

/** AC units and roof-access huts on flat roofs. */
export function addRoofClutter(solid: GeometryBuilder, frame: Frame, b: Building, rng: Rng): void {
  const { halfW, halfD } = b.footprint;
  const y0 = b.height + 0.45;
  const units = rng.int(0, 2);
  for (let i = 0; i < units; i++) {
    addBox(solid, {
      frame,
      ox: rng.range(-halfW + 1.5, halfW - 1.5),
      oz: rng.range(-halfD + 1.5, halfD - 1.5),
      halfW: 0.8,
      halfD: 0.55,
      y0,
      y1: y0 + 1,
      color: color(0xd5d8db),
    });
  }
  if (rng.chance(0.5)) {
    addBox(solid, {
      frame,
      ox: rng.range(-halfW + 2, halfW - 2),
      oz: -halfD + 2,
      halfW: 1.3,
      halfD: 1.3,
      y0,
      y1: y0 + 2.3,
      color: color(0xa9a39a),
    });
  }
}
