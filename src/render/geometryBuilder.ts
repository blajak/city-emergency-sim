import * as THREE from 'three';
import type { Vec2 } from '../sim/math/vec2';

export type V3 = [number, number, number];
export type UV = [number, number];

/** UV that lands on plain wall in the facade textures (used for roofs and solid parts). */
export const SOLID_UV: UV = [0.03, 0.03];

/**
 * Accumulates flat-shaded, vertex-coloured polygons and produces one merged
 * BufferGeometry, so the whole city renders in a handful of draw calls.
 */
export class GeometryBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];
  private vertexCount = 0;

  /** Convex polygon, counter-clockwise when seen from the side it faces. */
  addPolygon(verts: V3[], color: THREE.Color, uvs?: UV[]): void {
    const n = faceNormal(verts[0], verts[1], verts[2]);
    const base = this.vertexCount;
    verts.forEach((v, i) => {
      this.positions.push(...v);
      this.normals.push(...n);
      this.uvs.push(...(uvs ? uvs[i] : SOLID_UV));
      this.colors.push(color.r, color.g, color.b);
    });
    for (let i = 1; i < verts.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
    this.vertexCount += verts.length;
  }

  /** Horizontal polygon at height `y`, always facing up regardless of winding. */
  addGroundPolygon(points: readonly Vec2[], y: number, color: THREE.Color): void {
    const verts: V3[] = points.map((p) => [p.x, y, p.z]);
    if (faceNormal(verts[0], verts[1], verts[2])[1] < 0) verts.reverse();
    this.addPolygon(verts, color);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function faceNormal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/**
 * Local coordinate frame of a building: local +z is the front. Matches
 * Three.js `rotation.y`.
 */
export class Frame {
  private readonly cos: number;
  private readonly sin: number;

  constructor(
    private readonly cx: number,
    private readonly cz: number,
    rotation: number,
  ) {
    this.cos = Math.cos(rotation);
    this.sin = Math.sin(rotation);
  }

  toWorld(lx: number, y: number, lz: number): V3 {
    return [this.cx + lx * this.cos + lz * this.sin, y, this.cz - lx * this.sin + lz * this.cos];
  }
}

export interface FacadeUv {
  bayWidth: number;
  /** Height of one texture repeat (one floor). */
  rowHeight: number;
}

export interface BoxOptions {
  frame: Frame;
  /** Local offset of the box centre. */
  ox?: number;
  oz?: number;
  halfW: number;
  halfD: number;
  y0: number;
  y1: number;
  color: THREE.Color;
  topColor?: THREE.Color;
  /** When set, sides get UVs that tile the window texture per bay and floor. */
  facade?: FacadeUv;
}

/** Box without a bottom face, in a building's local frame. */
export function addBox(b: GeometryBuilder, o: BoxOptions): void {
  const { frame, halfW: w, halfD: d, y0, y1 } = o;
  const ox = o.ox ?? 0;
  const oz = o.oz ?? 0;
  const p = (x: number, y: number, z: number) => frame.toWorld(ox + x, y, oz + z);

  const sideUvs = (span: number): UV[] | undefined => {
    if (!o.facade) return undefined;
    const u = Math.max(1, Math.round(span / o.facade.bayWidth));
    const v = (y1 - y0) / o.facade.rowHeight;
    return [
      [0, 0],
      [u, 0],
      [u, v],
      [0, v],
    ];
  };

  b.addPolygon([p(-w, y0, d), p(w, y0, d), p(w, y1, d), p(-w, y1, d)], o.color, sideUvs(2 * w)); // front
  b.addPolygon([p(w, y0, -d), p(-w, y0, -d), p(-w, y1, -d), p(w, y1, -d)], o.color, sideUvs(2 * w)); // back
  b.addPolygon([p(w, y0, d), p(w, y0, -d), p(w, y1, -d), p(w, y1, d)], o.color, sideUvs(2 * d)); // right
  b.addPolygon([p(-w, y0, -d), p(-w, y0, d), p(-w, y1, d), p(-w, y1, -d)], o.color, sideUvs(2 * d)); // left
  b.addPolygon([p(-w, y1, d), p(w, y1, d), p(w, y1, -d), p(-w, y1, -d)], o.topColor ?? o.color); // top
}

/** Pitched roof with the ridge running along local x (parallel to the street). */
export function addGableRoof(
  b: GeometryBuilder,
  frame: Frame,
  halfW: number,
  halfD: number,
  y: number,
  rise: number,
  roofColor: THREE.Color,
  wallColor: THREE.Color,
  overhang = 0.4,
): void {
  const w = halfW + overhang * 0.5;
  const d = halfD + overhang;
  const top = y + rise;
  const p = (x: number, yy: number, z: number) => frame.toWorld(x, yy, z);
  b.addPolygon([p(-w, y, d), p(w, y, d), p(w, top, 0), p(-w, top, 0)], roofColor);
  b.addPolygon([p(w, y, -d), p(-w, y, -d), p(-w, top, 0), p(w, top, 0)], roofColor);
  b.addPolygon([p(halfW, y, halfD), p(halfW, y, -halfD), p(halfW, top, 0)], wallColor);
  b.addPolygon([p(-halfW, y, -halfD), p(-halfW, y, halfD), p(-halfW, top, 0)], wallColor);
}
