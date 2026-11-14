import { type OBB, obbLocalToWorld, obbOverlap, pointInObb, pointInPolygon, projectOnPolyline, samplePolyline } from '../math/geometry';
import type { Rng } from '../math/rng';
import { SpatialGrid, obbBox, pointsBox } from '../math/spatialGrid';
import { type Vec2, add, distance, dot, lerp, normalize, rightOf, scale, sub, vec2 } from '../math/vec2';
import { CROSSWALK_LENGTH, FLOOR_HEIGHT, GROUND_FLOOR_HEIGHT, STREET_CLEARANCE } from './constants';
import { districtAt } from './districts';
import { RoadIndex } from './roadIndex';
import type { RailPlan } from './rail';
import type { Block, CityLayout, StationSite } from './roadNetwork';
import type {
  Building,
  BuildingKind,
  DeliveryBay,
  District,
  DistrictKind,
  EdgeId,
  RoadEdge,
  RoadNetwork,
  RoofKind,
  Side,
} from './types';

const BUILDING_CELL_SIZE = 32;
/** Gap between the sidewalk edge and the facade. */
const SETBACK = 0.4;
/** Spacing of the probe points used to check that a footprint stays off roads. */
const PROBE_SPACING = 4;

const TENEMENT_COLORS = [0xe8d5b7, 0xf2c6a0, 0xd9a5a0, 0xb8cfd9, 0xc9d9b8, 0xf0e1a8, 0xe6b8a2, 0xd4c4e0, 0xf5e6d3, 0xc2d6c8];
const APARTMENT_COLORS = [0xd8d4cc, 0xc9cfd3, 0xe3d9c6, 0xbfc9c2, 0xd6c3b5, 0xe8e2d6];
const HOUSE_COLORS = [0xf3ead8, 0xe9d3b8, 0xdfe6e9, 0xf0dcd0, 0xe6e8d0];
const OFFICE_COLORS = [0xb9c2cc, 0xa7b4c0, 0xcfd6dc, 0x9fb0bf];
const SHOP_COLORS = [0xf6efe4, 0xe9e4da, 0xf3e3d3, 0xe2e8ec];
const INDUSTRIAL_COLORS = [0xb7b2a8, 0xa9b4bd, 0xc4b9a3, 0x9fa8a3, 0xb88c72];

export interface BuildingSpec {
  kind: BuildingKind;
  width: number;
  depth: number;
  groundFloorHeight: number;
  upperFloors: number;
  roof: RoofKind;
  facadeColor: number;
  /** Extra free space left after this building in a terrace (gardens between houses). */
  gapAfter?: number;
}

const STATION_SPECS: Record<'fire' | 'police', BuildingSpec> = {
  fire: { kind: 'fire_station', width: 24, depth: 18, groundFloorHeight: 5.6, upperFloors: 1, roof: 'flat', facadeColor: 0xc0392b },
  police: { kind: 'police_station', width: 20, depth: 16, groundFloorHeight: GROUND_FLOOR_HEIGHT, upperFloors: 3, roof: 'flat', facadeColor: 0xeef1f4 },
};

// ---------------------------------------------------------------------------
// Sites that fill a whole block
// ---------------------------------------------------------------------------

type SiteKind =
  | 'power_plant'
  | 'town_hall'
  | 'hospital'
  | 'stadium'
  | 'mall'
  | 'school'
  | 'sports_hall'
  | 'pool'
  | 'supermarket'
  | 'factory'
  | 'container_yard'
  | 'waste_depot';

interface SiteRule {
  districts: DistrictKind[];
  /** How many for a given city scale. */
  count: (scale: number) => number;
  /** Which candidate block to take. */
  prefer: 'district_center' | 'map_center' | 'east_edge' | 'map_edge' | 'random';
  /** Main structure as fractions of the plot (width, depth), placed at the back of the plot. */
  main: [number, number];
  /** Height of the main structure. */
  height: number;
  color: number[];
}

const SITE_RULES: Record<SiteKind, SiteRule> = {
  power_plant: { districts: ['industrial'], count: () => 1, prefer: 'east_edge', main: [0.42, 0.42], height: 18, color: [0xc9c4ba] },
  town_hall: { districts: ['old_town'], count: () => 1, prefer: 'district_center', main: [0.56, 0.42], height: 15, color: [0xe7d8b8] },
  hospital: { districts: ['old_town', 'commercial', 'residential'], count: (s) => (s >= 3 ? 1 : 0), prefer: 'map_center', main: [0.82, 0.5], height: 22, color: [0xeef1f3] },
  stadium: { districts: ['residential', 'commercial'], count: (s) => (s >= 4 ? 1 : 0), prefer: 'map_edge', main: [0.96, 0.96], height: 13, color: [0xd8dde2] },
  mall: { districts: ['commercial'], count: (s) => (s >= 3 ? 1 : 0), prefer: 'district_center', main: [0.86, 0.5], height: 13, color: [0xe4e6e8] },
  school: { districts: ['residential'], count: (s) => (s >= 2 ? Math.max(1, Math.round(s / 4)) : 0), prefer: 'random', main: [0.7, 0.36], height: 10.5, color: [0xe8c9a0, 0xd9b48f] },
  sports_hall: { districts: ['residential', 'commercial'], count: (s) => (s >= 5 ? 1 : 0), prefer: 'random', main: [0.66, 0.5], height: 11, color: [0xd6dde4] },
  pool: { districts: ['residential'], count: (s) => (s >= 5 ? 1 : 0), prefer: 'random', main: [0.62, 0.4], height: 8, color: [0xe6f0f4] },
  supermarket: { districts: ['commercial', 'residential'], count: (s) => Math.round(s / 3), prefer: 'random', main: [0.55, 0.42], height: 7, color: [0xf0ece4, 0xe6e9ec] },
  factory: { districts: ['industrial'], count: (s) => Math.round(s * 0.7), prefer: 'random', main: [0.86, 0.58], height: 11, color: [0xb8b3a8, 0xa8b1b8, 0xb98a6e] },
  container_yard: { districts: ['industrial'], count: (s) => (s >= 3 ? Math.max(1, Math.round(s / 5)) : 0), prefer: 'east_edge', main: [0.16, 0.16], height: 4, color: [0xd9d4c6] },
  waste_depot: { districts: ['industrial'], count: (s) => (s >= 2 ? 1 : 0), prefer: 'map_edge', main: [0.5, 0.4], height: 9, color: [0x8f9a8a] },
};

/** Placement order: rarest and most important first. */
const SITE_ORDER: SiteKind[] = [
  'power_plant',
  'town_hall',
  'hospital',
  'stadium',
  'mall',
  'school',
  'sports_hall',
  'pool',
  'waste_depot',
  'container_yard',
  'supermarket',
  'factory',
];

/** Kinds that get a delivery lay-by, with its length. */
const BAY_LENGTH: Partial<Record<BuildingKind, number>> = {
  shop: 10,
  supermarket: 18,
  mall: 18,
  warehouse: 18,
  factory: 18,
  petrol_station: 14,
};

// ---------------------------------------------------------------------------

export function placeBuildings(
  rng: Rng,
  layout: CityLayout,
  districts: readonly District[],
  cityScale: number,
  railPlan: RailPlan,
): Building[] {
  const { network, parks, stationSites } = layout;
  const buildings: Building[] = [];
  const roads = new RoadIndex(network);
  /** Points along every railway corridor with the corridor's half width. */
  const rail = new SpatialGrid<{ p: Vec2; halfWidth: number }>(BUILDING_CELL_SIZE);
  for (const corridor of railPlan.corridors) {
    for (const p of samplePoints(corridor.points, 2)) rail.insert({ p, halfWidth: corridor.halfWidth }, pointsBox([p], corridor.halfWidth));
  }
  /** Footprints and plots already taken. */
  const taken = new SpatialGrid<OBB>(BUILDING_CELL_SIZE);
  const districtKind = (p: Vec2) => districts[districtAt(districts, p)].kind;

  const isFree = (box: OBB, ignoreRail = false): boolean => {
    for (const p of probePoints(box)) {
      if (roads.isNear(p, STREET_CLEARANCE + SETBACK * 0.5)) return false;
    }
    if (!ignoreRail && rail.query(obbBox(box)).some(({ p, halfWidth }) => pointInObb(p, box, halfWidth))) return false;
    if (parks.some((park) => pointInPolygon(box.center, park.polygon))) return false;
    // Shrink slightly so neighbours in a terrace may touch.
    const shrunk = { ...box, halfW: box.halfW - 0.05, halfD: box.halfD - 0.05 };
    return !taken.query(obbBox(shrunk)).some((other) => obbOverlap(shrunk, other));
  };

  const push = (spec: BuildingSpec, footprint: OBB, plot: OBB | null, edge: RoadEdge, s: number, side: Side, name: string | null = null) => {
    const building: Building = {
      id: buildings.length,
      kind: spec.kind,
      district: districtAt(districts, footprint.center),
      footprint,
      plot,
      variant: rng.next(),
      name,
      bay: null,
      groundFloorHeight: spec.groundFloorHeight,
      upperFloors: spec.upperFloors,
      height: spec.groundFloorHeight + spec.upperFloors * FLOOR_HEIGHT,
      roof: spec.roof,
      facadeColor: spec.facadeColor,
      address: { edgeId: edge.id, s, side },
    };
    buildings.push(building);
    taken.insert(plot ?? footprint, obbBox(plot ?? footprint));
    return building;
  };

  const addFrontage = (spec: BuildingSpec, edge: RoadEdge, s: number, side: Side): boolean => {
    const footprint = frontageFootprint(edge, s, side, spec.width, spec.depth);
    if (!isFree(footprint)) return false;
    push(spec, footprint, null, edge, s, side);
    return true;
  };

  // 1. Stations first so they always get their plot.
  const placeStation = (site: StationSite, spec: BuildingSpec) => {
    const edge = network.edges[site.edgeId];
    if (!addFrontage(spec, edge, edge.length / 2, site.side)) {
      throw new Error(`Could not place ${spec.kind} on edge ${site.edgeId}`);
    }
  };
  placeStation(stationSites.fire, STATION_SPECS.fire);
  placeStation(stationSites.police, STATION_SPECS.police);

  // 2. Railway sites: stations, freight hub and terminal around their tracks.
  const usedBlocks = new Set<Block>();
  for (const site of railPlan.sites) {
    const placed = blockSite(site.block, network, rng, site.front);
    if (!placed) continue;
    const { plot } = placed;
    // The tracks run through the middle of the plot; the building stands in its front part.
    const gap = site.kind === 'freight_terminal' ? 7 : 9;
    const depth = plot.halfD - gap;
    const width = Math.min(plot.halfW * (site.kind === 'train_station' ? 1.1 : 0.8), 44);
    const footprint: OBB = { center: obbLocalToWorld(plot, 0, gap + depth / 2), halfW: width / 2, halfD: depth / 2, rotation: plot.rotation };
    if (depth < 8 || !isFree(footprint) || !isFree(plot, true)) continue;
    const height = { train_station: 12, freight_hub: 9, freight_terminal: 8 }[site.kind];
    const spec: BuildingSpec = { kind: site.kind, width, depth, groundFloorHeight: height, upperFloors: 0, roof: 'flat', facadeColor: site.kind === 'train_station' ? 0xd9c7a6 : 0xb0b4b8 };
    push(spec, footprint, plot, network.edges[placed.edgeId], placed.s, placed.side, site.name);
    usedBlocks.add(site.block);
  }

  // 3. Large sites that fill a block.
  const mapCenter = vec2(
    (Math.min(...network.nodes.map((n) => n.pos.x)) + Math.max(...network.nodes.map((n) => n.pos.x))) / 2,
    (Math.min(...network.nodes.map((n) => n.pos.z)) + Math.max(...network.nodes.map((n) => n.pos.z))) / 2,
  );
  for (const kind of SITE_ORDER) {
    const rule = SITE_RULES[kind];
    for (let n = 0; n < rule.count(cityScale); n++) {
      const candidates = layout.blocks.filter(
        (b) => b.regular && !b.rail && !b.park && !usedBlocks.has(b) && rule.districts.includes(districtKind(blockCenter(b))),
      );
      orderCandidates(candidates, rule.prefer, rng, mapCenter, districts);
      for (const block of candidates) {
        const site = blockSite(block, network, rng);
        if (!site || !isFree(site.plot)) continue;
        const [fw, fd] = rule.main;
        const footprint = mainStructure(site.plot, fw, fd);
        const spec: BuildingSpec = {
          kind,
          width: footprint.halfW * 2,
          depth: footprint.halfD * 2,
          groundFloorHeight: rule.height,
          upperFloors: 0,
          roof: 'flat',
          facadeColor: rng.pick(rule.color),
        };
        push(spec, footprint, site.plot, network.edges[site.edgeId], site.s, site.side);
        usedBlocks.add(block);
        break;
      }
    }
  }

  // 4. Terraces along both sides of every street, styled by district.
  let petrolStations = 0;
  const maxPetrol = Math.max(1, Math.round(cityScale / 3));
  for (const edge of network.edges) {
    for (const side of [1, -1] as const) {
      const end = edge.length - STREET_CLEARANCE - 1;
      let s = STREET_CLEARANCE + 1;
      while (s < end) {
        const here = frontagePoint(edge, s, side);
        let spec = frontageSpec(rng, districtKind(here));
        if (spec.kind === 'petrol_station' && petrolStations >= maxPetrol) spec = frontageSpec(rng, 'old_town');
        if (s + spec.width > end) {
          s += 2;
          continue;
        }
        if (addFrontage(spec, edge, s + spec.width / 2, side)) {
          if (spec.kind === 'petrol_station') petrolStations++;
          s += spec.width + (spec.gapAfter ?? (rng.chance(0.15) ? rng.range(2, 5) : 0));
        } else {
          s += 2;
        }
      }
    }
  }

  // 5. Delivery lay-bys.
  assignBays(buildings, network);

  return buildings;
}

// ---------------------------------------------------------------------------
// Frontage buildings
// ---------------------------------------------------------------------------

function frontageSpec(rng: Rng, district: DistrictKind): BuildingSpec {
  const roll = rng.next();
  switch (district) {
    case 'old_town':
      if (roll < 0.15) return shopSpec(rng);
      if (roll < 0.25) return officeSpec(rng, 3, 6);
      return tenementSpec(rng);
    case 'commercial':
      if (roll < 0.4) return officeSpec(rng, 5, 12);
      if (roll < 0.75) return shopSpec(rng);
      if (roll < 0.83) return { kind: 'petrol_station', width: 28, depth: 20, groundFloorHeight: 5.5, upperFloors: 0, roof: 'flat', facadeColor: 0xf2f2f0, gapAfter: 4 };
      return apartmentSpec(rng);
    case 'residential':
      if (roll < 0.45) return apartmentSpec(rng);
      if (roll < 0.8) return houseSpec(rng);
      if (roll < 0.95) return tenementSpec(rng);
      return shopSpec(rng);
    case 'industrial':
      if (roll < 0.55) {
        return { kind: 'warehouse', width: rng.range(30, 46), depth: rng.range(18, 24), groundFloorHeight: rng.range(7, 9), upperFloors: 0, roof: 'flat', facadeColor: rng.pick(INDUSTRIAL_COLORS), gapAfter: rng.range(3, 8) };
      }
      if (roll < 0.85) {
        return { kind: 'factory', width: rng.range(24, 34), depth: rng.range(20, 26), groundFloorHeight: rng.range(9, 11), upperFloors: 0, roof: 'flat', facadeColor: rng.pick(INDUSTRIAL_COLORS), gapAfter: rng.range(3, 8) };
      }
      return officeSpec(rng, 1, 3);
  }
}

function tenementSpec(rng: Rng): BuildingSpec {
  return {
    kind: 'residential',
    width: rng.range(8, 14),
    depth: rng.range(10, 14),
    groundFloorHeight: GROUND_FLOOR_HEIGHT,
    upperFloors: rng.int(2, 5),
    roof: rng.chance(0.4) ? 'gable' : 'flat',
    facadeColor: rng.pick(TENEMENT_COLORS),
  };
}

function apartmentSpec(rng: Rng): BuildingSpec {
  return {
    kind: 'apartment',
    width: rng.range(22, 36),
    depth: rng.range(11, 13),
    groundFloorHeight: 3.2,
    upperFloors: rng.int(3, 7),
    roof: 'flat',
    facadeColor: rng.pick(APARTMENT_COLORS),
    gapAfter: rng.range(4, 9),
  };
}

function houseSpec(rng: Rng): BuildingSpec {
  return {
    kind: 'house',
    width: rng.range(9, 12),
    depth: rng.range(8, 10),
    groundFloorHeight: 3,
    upperFloors: rng.int(0, 1),
    roof: rng.chance(0.9) ? 'gable' : 'flat',
    facadeColor: rng.pick(HOUSE_COLORS),
    gapAfter: rng.range(4, 8),
  };
}

function officeSpec(rng: Rng, minFloors: number, maxFloors: number): BuildingSpec {
  return {
    kind: 'office',
    width: rng.range(14, 22),
    depth: rng.range(13, 17),
    groundFloorHeight: GROUND_FLOOR_HEIGHT,
    upperFloors: rng.int(minFloors, maxFloors),
    roof: 'flat',
    facadeColor: rng.pick(OFFICE_COLORS),
  };
}

function shopSpec(rng: Rng): BuildingSpec {
  return {
    kind: 'shop',
    width: rng.range(10, 18),
    depth: rng.range(12, 16),
    groundFloorHeight: 4.5,
    upperFloors: rng.int(0, 1),
    roof: 'flat',
    facadeColor: rng.pick(SHOP_COLORS),
  };
}

/** Footprint whose front (local +z) faces the road, centred at arc length `s`. */
function frontageFootprint(edge: RoadEdge, s: number, side: Side, width: number, depth: number): OBB {
  const { point, dir } = samplePolyline(edge.points, s);
  const outward = scale(rightOf(dir), side);
  const center = add(point, scale(outward, STREET_CLEARANCE + SETBACK + depth / 2));
  return { center, halfW: width / 2, halfD: depth / 2, rotation: Math.atan2(-outward.x, -outward.z) };
}

function frontagePoint(edge: RoadEdge, s: number, side: Side): Vec2 {
  const { point, dir } = samplePolyline(edge.points, s);
  return add(point, scale(rightOf(dir), side * (STREET_CLEARANCE + 8)));
}

// ---------------------------------------------------------------------------
// Block sites
// ---------------------------------------------------------------------------

function blockCenter(block: Block): Vec2 {
  const [a, b, c, d] = block.corners;
  return vec2((a.x + b.x + c.x + d.x) / 4, (a.z + b.z + c.z + d.z) / 4);
}

function orderCandidates(
  blocks: Block[],
  prefer: SiteRule['prefer'],
  rng: Rng,
  mapCenter: Vec2,
  districts: readonly District[],
): void {
  const keyed = blocks.map((b) => {
    const c = blockCenter(b);
    let key: number;
    switch (prefer) {
      case 'district_center':
        key = distance(c, districts[districtAt(districts, c)].center);
        break;
      case 'map_center':
        key = distance(c, mapCenter);
        break;
      case 'east_edge':
        key = -c.x;
        break;
      case 'map_edge':
        key = -distance(c, mapCenter);
        break;
      case 'random':
        key = rng.next();
        break;
    }
    return { b, key };
  });
  keyed.sort((x, y) => x.key - y.key);
  blocks.splice(0, blocks.length, ...keyed.map((k) => k.b));
}

interface BlockSite {
  plot: OBB;
  edgeId: EdgeId;
  s: number;
  side: Side;
}

/**
 * The largest rectangle (roughly) inside a block, set back from the streets,
 * facing a randomly chosen bordering street.
 */
function blockSite(block: Block, network: RoadNetwork, rng: Rng, preferredFront?: 'north' | 'south' | 'east' | 'west'): BlockSite | null {
  const [nw, ne, se, sw] = block.corners;
  const center = blockCenter(block);
  const east = normalize(lerp(sub(ne, nw), sub(se, sw), 0.5));
  const south = rightOf(east);
  const inset = STREET_CLEARANCE + SETBACK + 0.5;
  const along = (axis: Vec2) => Math.min(...block.corners.map((p) => Math.abs(dot(sub(p, center), axis)))) - inset;
  const extentEW = along(east);
  const extentNS = along(south);
  if (extentEW < 15 || extentNS < 15) return null;

  const fronts = (['south', 'north', 'east', 'west'] as const).filter((k) => block.sides[k] !== undefined);
  if (fronts.length === 0) return null;
  const front = preferredFront && block.sides[preferredFront] !== undefined ? preferredFront : rng.pick(fronts);
  const frontDir = { south, north: scale(south, -1), east, west: scale(east, -1) }[front];
  const sidewaysExtent = front === 'south' || front === 'north' ? extentEW : extentNS;
  const depthExtent = front === 'south' || front === 'north' ? extentNS : extentEW;
  const plot: OBB = { center, halfW: sidewaysExtent, halfD: depthExtent, rotation: Math.atan2(frontDir.x, frontDir.z) };

  const edge = network.edges[block.sides[front]!];
  const s = projectOnPolyline(edge.points, center);
  const { point, dir } = samplePolyline(edge.points, s);
  const side: Side = dot(rightOf(dir), sub(center, point)) > 0 ? 1 : -1;
  return { plot, edgeId: edge.id, s, side };
}

/** Main structure at the back of a plot, `fw` × `fd` of its size. */
function mainStructure(plot: OBB, fw: number, fd: number): OBB {
  const halfW = plot.halfW * fw;
  const halfD = plot.halfD * fd;
  return { center: obbLocalToWorld(plot, 0, -(plot.halfD - halfD)), halfW, halfD, rotation: plot.rotation };
}

// ---------------------------------------------------------------------------
// Delivery bays
// ---------------------------------------------------------------------------

function assignBays(buildings: Building[], network: RoadNetwork): void {
  const taken = new Map<string, { s: number; half: number }[]>();
  const keyOf = (edgeId: EdgeId, side: Side) => `${edgeId}:${side}`;
  // Keep the curb in front of stations free for their units.
  for (const b of buildings) {
    if (b.kind !== 'fire_station' && b.kind !== 'police_station') continue;
    const key = keyOf(b.address.edgeId, b.address.side);
    taken.set(key, [...(taken.get(key) ?? []), { s: b.address.s, half: b.footprint.halfW + 12 }]);
  }

  for (const b of buildings) {
    const bayLength = BAY_LENGTH[b.kind];
    if (!bayLength) continue;
    const edge = network.edges[b.address.edgeId];
    const from = network.nodes[edge.from];
    const to = network.nodes[edge.to];
    const margin = bayLength / 2 + CROSSWALK_LENGTH + 4;
    const min = from.clearance + margin;
    const max = edge.length - to.clearance - margin;
    if (min > max) continue;
    const s = Math.min(max, Math.max(min, b.address.s));
    const key = keyOf(edge.id, b.address.side);
    const others = taken.get(key) ?? [];
    if (others.some((o) => Math.abs(o.s - s) < o.half + bayLength / 2 + 2)) continue;
    const bay: DeliveryBay = { edgeId: edge.id, side: b.address.side, s, length: bayLength };
    b.bay = bay;
    taken.set(key, [...others, { s, half: bayLength / 2 }]);
  }
}

// ---------------------------------------------------------------------------

/** Points every `PROBE_SPACING` m over the footprint — enough to catch a road clipping it. */
function probePoints(box: OBB): Vec2[] {
  const nx = Math.max(2, Math.ceil((box.halfW * 2) / PROBE_SPACING));
  const nz = Math.max(2, Math.ceil((box.halfD * 2) / PROBE_SPACING));
  const points: Vec2[] = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      points.push(obbLocalToWorld(box, -box.halfW + (2 * box.halfW * i) / nx, -box.halfD + (2 * box.halfD * j) / nz));
    }
  }
  return points;
}

function samplePoints(polyline: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const n = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let k = 0; k < n; k++) out.push(lerp(a, b, k / n));
  }
  out.push(polyline[polyline.length - 1]);
  return out;
}

