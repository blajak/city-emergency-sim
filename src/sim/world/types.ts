import type { OBB } from '../math/geometry';
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

export type BuildingKind = 'residential' | 'office' | 'fire_station' | 'police_station';
export type RoofKind = 'flat' | 'gable';

export interface Building {
  id: BuildingId;
  kind: BuildingKind;
  /** Local +z of the footprint faces the street. */
  footprint: OBB;
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

export interface City {
  seed: number;
  bounds: Bounds;
  roads: RoadNetwork;
  buildings: Building[];
  parks: Park[];
  trees: TreeSpot[];
  lamps: LampSpot[];
}
