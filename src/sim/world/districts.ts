import type { Rng } from '../math/rng';
import { type Vec2, distance, vec2 } from '../math/vec2';
import type { Bounds, District, DistrictId, DistrictKind } from './types';

/**
 * District seeds in map-relative coordinates (0..1 across the bounds), in
 * order of importance: small cities only use the first few. Every location
 * belongs to the nearest seed, which gives irregular, natural-looking districts.
 * Industry sits on the east side, where the freight railway leaves the city.
 */
const PLAN: { name: string; kind: DistrictKind; u: number; v: number }[] = [
  { name: 'Old Town', kind: 'old_town', u: 0.47, v: 0.47 },
  { name: 'Eastworks', kind: 'industrial', u: 0.88, v: 0.42 },
  { name: 'Northfield', kind: 'residential', u: 0.2, v: 0.17 },
  { name: 'Market Quarter', kind: 'commercial', u: 0.5, v: 0.16 },
  { name: 'Southbrook', kind: 'residential', u: 0.24, v: 0.84 },
  { name: 'Dockside', kind: 'industrial', u: 0.84, v: 0.86 },
  { name: 'Westgate', kind: 'commercial', u: 0.14, v: 0.5 },
  { name: 'Linden Park', kind: 'residential', u: 0.76, v: 0.13 },
  { name: 'Hillside', kind: 'residential', u: 0.55, v: 0.85 },
];

export function districtCount(scale: number): number {
  return Math.min(PLAN.length, Math.max(3, Math.round(2 + scale * 0.7)));
}

export function planDistricts(rng: Rng, bounds: Bounds, scale: number): District[] {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxZ - bounds.minZ;
  return PLAN.slice(0, districtCount(scale)).map((d, id) => ({
    id,
    name: d.name,
    kind: d.kind,
    center: vec2(bounds.minX + (d.u + rng.range(-0.03, 0.03)) * w, bounds.minZ + (d.v + rng.range(-0.03, 0.03)) * h),
  }));
}

export function districtAt(districts: readonly District[], p: Vec2): DistrictId {
  let best = 0;
  let bestDistance = Infinity;
  for (const d of districts) {
    const dist = distance(p, d.center);
    if (dist < bestDistance) {
      bestDistance = dist;
      best = d.id;
    }
  }
  return best;
}
