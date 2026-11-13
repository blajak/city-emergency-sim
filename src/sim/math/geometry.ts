import { type Vec2, add, distance, dot, lerp, normalize, scale, sub, vec2 } from './vec2';

// ---------------------------------------------------------------------------
// Polylines
// ---------------------------------------------------------------------------

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += distance(points[i], points[i + 1]);
  return total;
}

export interface PolylineSample {
  point: Vec2;
  /** Unit tangent in the direction of increasing distance. */
  dir: Vec2;
}

/** Point and tangent at arc length `s` (clamped to the polyline). */
export function samplePolyline(points: readonly Vec2[], s: number): PolylineSample {
  let remaining = Math.max(0, s);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLength = distance(a, b);
    if (remaining <= segLength || i === points.length - 2) {
      const t = segLength > 0 ? Math.min(1, remaining / segLength) : 0;
      return { point: lerp(a, b, t), dir: normalize(sub(b, a)) };
    }
    remaining -= segLength;
  }
  return { point: points[0], dir: vec2(1, 0) };
}

/** Sub-polyline between arc lengths s0 and s1, sampled at least every `step` metres. */
export function subPolyline(points: readonly Vec2[], s0: number, s1: number, step = 2): Vec2[] {
  const count = Math.max(1, Math.ceil((s1 - s0) / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i++) out.push(samplePolyline(points, s0 + ((s1 - s0) * i) / count).point);
  return out;
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  const t = lenSq > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / lenSq)) : 0;
  return distance(p, add(a, scale(ab, t)));
}

export function distanceToPolyline(p: Vec2, points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, distanceToSegment(p, points[i], points[i + 1]));
  }
  return best;
}

export function quadraticBezier(a: Vec2, control: Vec2, b: Vec2, segments: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    out.push(lerp(lerp(a, control, t), lerp(control, b, t), t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonCentroid(polygon: readonly Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of polygon) {
    x += p.x;
    z += p.z;
  }
  return vec2(x / polygon.length, z / polygon.length);
}

// ---------------------------------------------------------------------------
// Oriented boxes (building footprints)
// ---------------------------------------------------------------------------

/**
 * Oriented rectangle. `rotation` follows Three.js `rotation.y`, so the local
 * +z axis (the building front) maps to (sin r, cos r).
 */
export interface OBB {
  center: Vec2;
  halfW: number;
  halfD: number;
  rotation: number;
}

export function obbAxes(rotation: number): [localX: Vec2, localZ: Vec2] {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return [vec2(c, -s), vec2(s, c)];
}

export function obbLocalToWorld(box: OBB, lx: number, lz: number): Vec2 {
  const [ax, az] = obbAxes(box.rotation);
  return add(box.center, add(scale(ax, lx), scale(az, lz)));
}

export function obbCorners(box: OBB): Vec2[] {
  return [
    obbLocalToWorld(box, -box.halfW, -box.halfD),
    obbLocalToWorld(box, box.halfW, -box.halfD),
    obbLocalToWorld(box, box.halfW, box.halfD),
    obbLocalToWorld(box, -box.halfW, box.halfD),
  ];
}

export function pointInObb(p: Vec2, box: OBB, margin = 0): boolean {
  const [ax, az] = obbAxes(box.rotation);
  const d = sub(p, box.center);
  return Math.abs(dot(d, ax)) <= box.halfW + margin && Math.abs(dot(d, az)) <= box.halfD + margin;
}

/** Separating axis test. Touching boxes do not count as overlapping. */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const cornersA = obbCorners(a);
  const cornersB = obbCorners(b);
  for (const axis of [...obbAxes(a.rotation), ...obbAxes(b.rotation)]) {
    const [minA, maxA] = project(cornersA, axis);
    const [minB, maxB] = project(cornersB, axis);
    if (maxA <= minB + 1e-6 || maxB <= minA + 1e-6) return false;
  }
  return true;
}

function project(points: readonly Vec2[], axis: Vec2): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const v = dot(p, axis);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return [min, max];
}

export function cubicBezier(a: Vec2, b: Vec2, c: Vec2, d: Vec2, segments: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push(
      vec2(
        u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        u * u * u * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t * t * t * d.z,
      ),
    );
  }
  return out;
}

/** Approximate minimum distance between two polylines (vertex-to-polyline both ways). */
export function polylineDistance(a: readonly Vec2[], b: readonly Vec2[]): number {
  let best = Infinity;
  for (const p of a) best = Math.min(best, distanceToPolyline(p, b));
  for (const p of b) best = Math.min(best, distanceToPolyline(p, a));
  return best;
}

/** Arc length of the point on the polyline closest to `p`. */
export function projectOnPolyline(points: readonly Vec2[], p: Vec2): number {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const ab = sub(points[i + 1], a);
    const lenSq = dot(ab, ab);
    const t = lenSq > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / lenSq)) : 0;
    const d = distance(p, add(a, scale(ab, t)));
    if (d < best) {
      best = d;
      bestS = acc + t * Math.sqrt(lenSq);
    }
    acc += Math.sqrt(lenSq);
  }
  return bestS;
}
