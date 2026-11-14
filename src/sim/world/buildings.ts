import {
  type OBB,
  obbLocalToWorld,
  obbOverlap,
  pointInPolygon,
  samplePolyline,
} from '../math/geometry';
import type { Rng } from '../math/rng';
import { SpatialGrid, obbBox } from '../math/spatialGrid';
import { type Vec2, add, length, rightOf, scale } from '../math/vec2';
import { FLOOR_HEIGHT, GROUND_FLOOR_HEIGHT, STREET_CLEARANCE } from './constants';
import { RoadIndex } from './roadIndex';
import type { CityLayout, StationSite } from './roadNetwork';
import type { Building, BuildingKind, RoadEdge, RoofKind, Side } from './types';

const BUILDING_CELL_SIZE = 32;

/** Gap between the sidewalk edge and the facade. */
const SETBACK = 0.4;

const TENEMENT_COLORS = [
  0xe8d5b7, 0xf2c6a0, 0xd9a5a0, 0xb8cfd9, 0xc9d9b8, 0xf0e1a8, 0xe6b8a2, 0xd4c4e0, 0xf5e6d3, 0xc2d6c8,
];
const OFFICE_COLORS = [0xb9c2cc, 0xa7b4c0, 0xcfd6dc, 0x9fb0bf];

interface BuildingSpec {
  kind: BuildingKind;
  width: number;
  depth: number;
  groundFloorHeight: number;
  upperFloors: number;
  roof: RoofKind;
  facadeColor: number;
}

const STATION_SPECS: Record<'fire' | 'police', BuildingSpec> = {
  fire: {
    kind: 'fire_station',
    width: 24,
    depth: 18,
    groundFloorHeight: 5.6,
    upperFloors: 1,
    roof: 'flat',
    facadeColor: 0xc0392b,
  },
  police: {
    kind: 'police_station',
    width: 20,
    depth: 16,
    groundFloorHeight: GROUND_FLOOR_HEIGHT,
    upperFloors: 3,
    roof: 'flat',
    facadeColor: 0xeef1f4,
  },
};

export function placeBuildings(rng: Rng, layout: CityLayout): Building[] {
  const { network, parks, stationSites } = layout;
  const buildings: Building[] = [];
  const maxRadius = Math.max(...network.nodes.map((n) => length(n.pos)));

  const roads = new RoadIndex(network);
  const placed = new SpatialGrid<Building>(BUILDING_CELL_SIZE);

  const isFree = (footprint: OBB): boolean => {
    for (const p of footprintProbePoints(footprint)) {
      if (roads.isNear(p, STREET_CLEARANCE + SETBACK * 0.5)) return false;
    }
    if (parks.some((park) => pointInPolygon(footprint.center, park.polygon))) return false;
    // Shrink slightly so neighbours in a terrace may touch.
    const shrunk = { ...footprint, halfW: footprint.halfW - 0.05, halfD: footprint.halfD - 0.05 };
    return !placed.query(obbBox(shrunk)).some((b) => obbOverlap(shrunk, b.footprint));
  };

  const add = (spec: BuildingSpec, edge: RoadEdge, s: number, side: Side): boolean => {
    const footprint = frontageFootprint(edge, s, side, spec.width, spec.depth);
    if (!isFree(footprint)) return false;
    const building: Building = {
      id: buildings.length,
      kind: spec.kind,
      footprint,
      groundFloorHeight: spec.groundFloorHeight,
      upperFloors: spec.upperFloors,
      height: spec.groundFloorHeight + spec.upperFloors * FLOOR_HEIGHT,
      roof: spec.roof,
      facadeColor: spec.facadeColor,
      address: { edgeId: edge.id, s, side },
    };
    buildings.push(building);
    placed.insert(building, obbBox(footprint));
    return true;
  };

  // Stations first so they always get their plot.
  const placeStation = (site: StationSite, spec: BuildingSpec) => {
    const edge = network.edges[site.edgeId];
    if (!add(spec, edge, edge.length / 2, site.side)) {
      throw new Error(`Could not place ${spec.kind} on edge ${site.edgeId}`);
    }
  };
  placeStation(stationSites.fire, STATION_SPECS.fire);
  placeStation(stationSites.police, STATION_SPECS.police);

  // Terraces along both sides of every street.
  for (const edge of network.edges) {
    for (const side of [1, -1] as const) {
      const end = edge.length - STREET_CLEARANCE - 1;
      let s = STREET_CLEARANCE + 1;
      while (s < end) {
        const mid = samplePolyline(edge.points, edge.length / 2).point;
        const centrality = 1 - Math.min(1, length(mid) / maxRadius);
        const spec = randomSpec(rng, centrality);
        if (s + spec.width > end) break;
        if (add(spec, edge, s + spec.width / 2, side)) {
          s += spec.width + (rng.chance(0.15) ? rng.range(2, 5) : 0);
        } else {
          s += 2;
        }
      }
    }
  }

  return buildings;
}

function randomSpec(rng: Rng, centrality: number): BuildingSpec {
  if (rng.chance(0.04 + 0.3 * centrality)) {
    return {
      kind: 'office',
      width: rng.range(14, 20),
      depth: rng.range(13, 17),
      groundFloorHeight: GROUND_FLOOR_HEIGHT,
      upperFloors: rng.int(5, 9 + Math.round(centrality * 4)),
      roof: 'flat',
      facadeColor: rng.pick(OFFICE_COLORS),
    };
  }
  return {
    kind: 'residential',
    width: rng.range(8, 14),
    depth: rng.range(10, 14),
    groundFloorHeight: GROUND_FLOOR_HEIGHT,
    upperFloors: rng.int(2, 4 + Math.round(centrality * 2)),
    roof: rng.chance(0.35) ? 'gable' : 'flat',
    facadeColor: rng.pick(TENEMENT_COLORS),
  };
}

/** Footprint whose front (local +z) faces the road, centred at arc length `s`. */
function frontageFootprint(edge: RoadEdge, s: number, side: Side, width: number, depth: number): OBB {
  const { point, dir } = samplePolyline(edge.points, s);
  const outward = scale(rightOf(dir), side);
  const center = add(point, scale(outward, STREET_CLEARANCE + SETBACK + depth / 2));
  return {
    center,
    halfW: width / 2,
    halfD: depth / 2,
    rotation: Math.atan2(-outward.x, -outward.z),
  };
}

/** Corners, edge midpoints and centre — enough to catch a road clipping the plot. */
function footprintProbePoints(box: OBB): Vec2[] {
  const points: Vec2[] = [];
  for (const fx of [-1, 0, 1]) {
    for (const fz of [-1, 0, 1]) points.push(obbLocalToWorld(box, fx * box.halfW, fz * box.halfD));
  }
  return points;
}
