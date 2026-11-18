import type { OBB } from '../math/geometry';
import type { RailPlan } from './rail';
import type { Vec2 } from '../math/vec2';

export type NodeId = number;
export type EdgeId = number;
export type BuildingId = number;

/** +1 = right-hand side of the edge (relative to from → to), -1 = left. */
export type Side = 1 | -1;

export interface RoadNode {
  id: NodeId;
  pos: Vec2;
  edges: EdgeId[];
  /** Intersections with 3+ roads get traffic lights. */
  signalized: boolean;
  /**
   * Distance from the node centre at which incident roads stop overlapping.
   * Crossings and stop lines sit just beyond it; larger for sharp angles.
   */
  clearance: number;
}

/** Two-way road segment with one lane per direction. */
export interface RoadEdge {
  id: EdgeId;
  /** Street name; segments of the same grid line share it. */
  name: string;
  from: NodeId;
  to: NodeId;
  /** Private road through the Dockside terminal (container lorries only, one way from → to). */
  yard?: boolean;
  /** Centre line from `from` to `to`. Straight roads have 2 points. */
  points: Vec2[];
  length: number;
}

export interface RoadNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

/** Where a building meets the street — used later as the incident / unit target. */
export interface StreetAddress {
  edgeId: EdgeId;
  /** Distance along the edge centre line. */
  s: number;
  side: Side;
}

export type BuildingKind =
  // homes
  | 'residential' // tenement house, mostly in the old town
  | 'apartment'
  | 'house'
  // work, shopping and services
  | 'office'
  | 'shop'
  | 'petrol_station'
  | 'supermarket'
  | 'mall'
  | 'town_hall'
  | 'school'
  | 'hospital'
  | 'sports_hall'
  | 'pool'
  | 'stadium'
  // industry and utilities
  | 'factory'
  | 'warehouse'
  | 'waste_depot'
  | 'power_plant'
  | 'substation'
  | 'utility_depot'
  | 'bus_depot'
  // railway
  | 'train_station'
  | 'freight_hub'
  | 'freight_terminal'
  // emergency services
  | 'fire_station'
  | 'police_station';

export type DistrictId = number;
export type DistrictKind = 'old_town' | 'commercial' | 'residential' | 'industrial';

export interface District {
  id: DistrictId;
  name: string;
  kind: DistrictKind;
  /** Seed point; every location belongs to the district with the nearest centre. */
  center: Vec2;
}

/** Lay-by cut into the sidewalk where delivery vehicles stop off the road. */
export interface DeliveryBay {
  edgeId: EdgeId;
  side: Side;
  /** Centre of the bay along the edge centre line. */
  s: number;
  length: number;
}
export type RoofKind = 'flat' | 'gable';

export interface Building {
  id: BuildingId;
  kind: BuildingKind;
  district: DistrictId;
  /** Main structure. Local +z faces the street. */
  footprint: OBB;
  /** Whole site for buildings that fill a block (car park, pitch, yard). Same orientation. */
  plot: OBB | null;
  /** 0..1, picks model variations. */
  variant: number;
  /** Display name for landmarks (stations), otherwise null. */
  name: string | null;
  /** Delivery lay-by in front of the building, if it has one. */
  bay: DeliveryBay | null;
  groundFloorHeight: number;
  upperFloors: number;
  /** Height of the wall top (roof excluded). */
  height: number;
  roof: RoofKind;
  facadeColor: number;
  address: StreetAddress;
}

export interface Park {
  polygon: Vec2[];
  pond: { center: Vec2; radius: number };
}

export interface TreeSpot {
  pos: Vec2;
  scale: number;
  /** 0..1, picks a shade of green. */
  tint: number;
}

export interface LampSpot {
  pos: Vec2;
  /** Rotation (Three.js `rotation.y`) so local +z points at the road. */
  rotation: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type BusStopId = number;

/** Where buses stop on one side of a street. */
export interface BusStop {
  id: BusStopId;
  name: string;
  edgeId: EdgeId;
  /** Kerb side; buses on the lane running along this side stop here. */
  side: Side;
  /** Centre of the stopping place along the edge centre line. */
  s: number;
  /** Length of the stopping place (bay or kerb marking). */
  length: number;
  /** Lay-by cut into the sidewalk; otherwise buses stop in the lane. */
  bay: boolean;
}

/** One step of a bus route: an edge driven in one direction. */
export interface RouteStep {
  edgeId: EdgeId;
  /** true when driving from edge.from to edge.to. */
  forward: boolean;
}

export interface BusStopCall {
  stop: BusStopId;
  /** Index into the line's `route` of the step the stop is on. */
  step: number;
}

export interface BusLine {
  id: number;
  /** Line number shown to people ("1"). */
  name: string;
  color: number;
  /**
   * Closed loop of edges: outbound to the far terminus, a turning loop around a
   * block, back to the home terminus and another turning loop. Starts at the
   * home terminus stop's street.
   */
  route: RouteStep[];
  /** Stops in the order served along `route`; the first is the home terminus. */
  calls: BusStopCall[];
  /** Index in `calls` of the far terminus. */
  turnCall: number;
}

export interface TransitPlan {
  /** Bus depot building, or null when the city has no room for one. */
  depot: BuildingId | null;
  stops: BusStop[];
  lines: BusLine[];
}

/** Power network: the plant feeds one substation per district. */
export interface PowerPlan {
  plant: BuildingId | null;
  /** Substation building per district (index = district id), null when none could be placed. */
  substations: (BuildingId | null)[];
  /** Power-company depot (next to the plant) with a driveway for the utility vans. */
  depot: BuildingId | null;
  /** Van parking spots on the depot driveway (= number of utility crews). */
  depotSpots: number;
}

export interface City {
  seed: number;
  /** Size factor the city was generated with (1 = original town). */
  scale: number;
  bounds: Bounds;
  roads: RoadNetwork;
  districts: District[];
  rail: RailPlan;
  buildings: Building[];
  transit: TransitPlan;
  power: PowerPlan;
  parks: Park[];
  trees: TreeSpot[];
  lamps: LampSpot[];
}
