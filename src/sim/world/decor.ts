import { distance, rightOf, scale, add, vec2 } from '../math/vec2';
import { distanceToPolyline, pointInObb, pointInPolygon, samplePolyline } from '../math/geometry';
import type { Vec2 } from '../math/vec2';
import type { RailPlan } from './rail';
import type { Rng } from '../math/rng';
import { SpatialGrid, around, obbBox } from '../math/spatialGrid';
import { RoadIndex } from './roadIndex';
import { STREET_CLEARANCE } from './constants';
import type { Bounds, Building, BusStop, LampSpot, Park, RoadNetwork, TreeSpot } from './types';

const TREE_GRID = 6;
const LAMP_SPACING = 28;

/** Index over each building's whole site (plot when it has one). */
function buildingIndex(buildings: readonly Building[]): SpatialGrid<Building> {
  const grid = new SpatialGrid<Building>(32);
  for (const b of buildings) grid.insert(b, obbBox(b.plot ?? b.footprint));
  return grid;
}

function nearBuilding(grid: SpatialGrid<Building>, pos: { x: number; z: number }, margin: number): boolean {
  return grid.query(around(pos, margin)).some((b) => pointInObb(pos, b.plot ?? b.footprint, margin));
}

/** Extra clearance beyond the railway corridors for trees and lamps. */
const RAIL_CLEARANCE = 2;

function nearRail(rail: RailPlan, pos: Vec2): boolean {
  return rail.corridors.some((c) => distanceToPolyline(pos, c.points) < c.halfWidth + RAIL_CLEARANCE);
}

export function placeTrees(
  rng: Rng,
  bounds: Bounds,
  roads: RoadNetwork,
  buildings: Building[],
  parks: Park[],
  rail: RailPlan,
): TreeSpot[] {
  const trees: TreeSpot[] = [];
  const roadIndex = new RoadIndex(roads);
  const buildingGrid = buildingIndex(buildings);
  for (let x = bounds.minX + 4; x < bounds.maxX - 4; x += TREE_GRID) {
    for (let z = bounds.minZ + 4; z < bounds.maxZ - 4; z += TREE_GRID) {
      const pos = vec2(x + rng.range(-2, 2), z + rng.range(-2, 2));
      const inPark = parks.find((p) => pointInPolygon(pos, p.polygon));
      if (!rng.chance(inPark ? 0.6 : 0.1)) continue;
      if (inPark && distance(pos, inPark.pond.center) < inPark.pond.radius + 3) continue;
      if (roadIndex.isNear(pos, STREET_CLEARANCE + 2)) continue;
      if (nearBuilding(buildingGrid, pos, 2)) continue;
      if (nearRail(rail, pos)) continue;
      trees.push({ pos, scale: rng.range(0.75, 1.3), tint: rng.next() });
    }
  }
  return trees;
}

export function placeLamps(roads: RoadNetwork, buildings: Building[], rail: RailPlan, stops: readonly BusStop[] = []): LampSpot[] {
  // Keep lay-bys and bus stops (shelter, sign) free of lamp posts.
  const bays = [...buildings.flatMap((b) => (b.bay ? [b.bay] : [])), ...stops.map((stop) => ({ ...stop, length: stop.length + 14 }))];
  const lamps: LampSpot[] = [];
  const buildingGrid = buildingIndex(buildings);
  for (const edge of roads.edges.filter((e) => !e.yard)) {
    for (const side of [1, -1] as const) {
      // Alternate sides so lamps are staggered.
      const start = side === 1 ? 14 : 14 + LAMP_SPACING / 2;
      for (let s = start; s < edge.length - 14; s += LAMP_SPACING) {
        const { point, dir } = samplePolyline(edge.points, s);
        const outward = scale(rightOf(dir), side);
        const pos = add(point, scale(outward, STREET_CLEARANCE - 0.3));
        if (nearBuilding(buildingGrid, pos, 0.5)) continue;
        if (nearRail(rail, pos)) continue;
        if (bays.some((bay) => bay.edgeId === edge.id && bay.side === side && Math.abs(bay.s - s) < bay.length / 2 + 1)) continue;
        lamps.push({ pos, rotation: Math.atan2(-outward.x, -outward.z) });
      }
    }
  }
  return lamps;
}
