import { distance, rightOf, scale, add, vec2 } from '../math/vec2';
import { distanceToPolyline, pointInObb, pointInPolygon, samplePolyline } from '../math/geometry';
import type { Rng } from '../math/rng';
import { STREET_CLEARANCE } from './constants';
import type { Bounds, Building, LampSpot, Park, RoadNetwork, TreeSpot } from './types';

const TREE_GRID = 6;
const LAMP_SPACING = 28;

export function placeTrees(
  rng: Rng,
  bounds: Bounds,
  roads: RoadNetwork,
  buildings: Building[],
  parks: Park[],
): TreeSpot[] {
  const trees: TreeSpot[] = [];
  for (let x = bounds.minX + 4; x < bounds.maxX - 4; x += TREE_GRID) {
    for (let z = bounds.minZ + 4; z < bounds.maxZ - 4; z += TREE_GRID) {
      const pos = vec2(x + rng.range(-2, 2), z + rng.range(-2, 2));
      const inPark = parks.find((p) => pointInPolygon(pos, p.polygon));
      if (!rng.chance(inPark ? 0.6 : 0.1)) continue;
      if (inPark && distance(pos, inPark.pond.center) < inPark.pond.radius + 3) continue;
      if (roads.edges.some((e) => distanceToPolyline(pos, e.points) < STREET_CLEARANCE + 2)) continue;
      if (buildings.some((b) => pointInObb(pos, b.footprint, 2))) continue;
      trees.push({ pos, scale: rng.range(0.75, 1.3), tint: rng.next() });
    }
  }
  return trees;
}

export function placeLamps(roads: RoadNetwork, buildings: Building[]): LampSpot[] {
  const lamps: LampSpot[] = [];
  for (const edge of roads.edges) {
    for (const side of [1, -1] as const) {
      // Alternate sides so lamps are staggered.
      const start = side === 1 ? 14 : 14 + LAMP_SPACING / 2;
      for (let s = start; s < edge.length - 14; s += LAMP_SPACING) {
        const { point, dir } = samplePolyline(edge.points, s);
        const outward = scale(rightOf(dir), side);
        const pos = add(point, scale(outward, STREET_CLEARANCE - 0.6));
        if (buildings.some((b) => pointInObb(pos, b.footprint, 0.5))) continue;
        lamps.push({ pos, rotation: Math.atan2(-outward.x, -outward.z) });
      }
    }
  }
  return lamps;
}
