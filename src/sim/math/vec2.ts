/**
 * 2D vector on the ground plane. `x` points east, `z` points south
 * (matches Three.js world axes when looking down from +y).
 */
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

export const vec2 = (x: number, z: number): Vec2 => ({ x, z });

export const add = (a: Vec2, b: Vec2): Vec2 => vec2(a.x + b.x, a.z + b.z);
export const sub = (a: Vec2, b: Vec2): Vec2 => vec2(a.x - b.x, a.z - b.z);
export const scale = (a: Vec2, s: number): Vec2 => vec2(a.x * s, a.z * s);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const length = (a: Vec2): number => Math.hypot(a.x, a.z);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 =>
  vec2(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  return l > 1e-9 ? vec2(a.x / l, a.z / l) : vec2(0, 0);
}

/** Normal pointing to the right of travel direction `d` (right-hand traffic side). */
export const rightOf = (d: Vec2): Vec2 => vec2(-d.z, d.x);
