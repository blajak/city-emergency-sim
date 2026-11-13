import type { RoutePoint } from '../routing/router';
import type { DriverParams } from './idm';
import type { SegmentId } from './laneGraph';

export type VehicleId = number;
export type VehicleModel = 'sedan' | 'hatchback' | 'van' | 'fire_engine' | 'police_car';
export type VehicleRole = 'civilian' | 'fire' | 'police';

/**
 * - driving: normal traffic participant
 * - arriving: stopped at its destination, pulling over to the curb
 * - parked: at the curb, invisible to other traffic
 * - waiting_to_merge: parked, waiting for a gap to rejoin traffic
 * - merging: moving from the curb back into the lane
 */
export type Maneuver = 'driving' | 'arriving' | 'parked' | 'waiting_to_merge' | 'merging';

export interface VehicleDimensions {
  length: number;
  width: number;
}

export const VEHICLE_DIMENSIONS: Record<VehicleModel, VehicleDimensions> = {
  sedan: { length: 4.5, width: 1.85 },
  hatchback: { length: 3.9, width: 1.75 },
  van: { length: 5.2, width: 2.0 },
  fire_engine: { length: 8.2, width: 2.5 },
  police_car: { length: 4.8, width: 1.9 },
};

/** Position of the vehicle body centre and heading (Three.js rotation.y). */
export interface Pose {
  x: number;
  z: number;
  yaw: number;
}

export interface Vehicle {
  id: VehicleId;
  role: VehicleRole;
  model: VehicleModel;
  color: number;
  length: number;
  width: number;
  driver: DriverParams;

  /** Segment the front bumper is on. */
  segment: SegmentId;
  /** Segment driven before `segment`; the tail may still be on it. */
  previousSegment: SegmentId | null;
  /** Distance of the front bumper along `segment`. */
  s: number;
  /** Speed, m/s. */
  v: number;
  /** Last applied acceleration, m/s². */
  a: number;
  /** Upcoming segments after `segment`, alternating connector / lane. */
  plan: SegmentId[];
  /** Picks random turns forever (civilians, patrol cars) instead of following a route. */
  wander: boolean;
  /** When set, the plan is a fixed route ending here, where the vehicle stops and parks. */
  destination: RoutePoint | null;
  /** Connector this vehicle is allowed to enter or is driving on. */
  reservation: SegmentId | null;
  /** Connector just left whose area the vehicle's tail still occupies (still reserved). */
  clearing: SegmentId | null;

  maneuver: Maneuver;
  /** Sideways offset from the lane centre towards the curb, m. */
  lateral: number;
  /** Emergency lights on. */
  sirens: boolean;
  /** Responding emergency vehicle this civilian is pulling over for (recomputed every step). */
  yieldingTo: VehicleId | null;
  /** stop: pull over and wait; hold: stay pulled over but drive on (the other vehicle has stopped). */
  yieldMode: 'stop' | 'hold';
  odometer: number;

  pose: Pose;
  /** Pose at the previous tick, for render interpolation. */
  prevPose: Pose;
}

/** Driving to an incident with sirens on: gets priority at junctions and on the road. */
export function isResponding(v: Vehicle): boolean {
  return v.sirens && v.destination !== null && v.maneuver === 'driving';
}

/** Curb offset that keeps a parked vehicle clear of traffic in the lane. */
export function parkingOffset(width: number): number {
  return 1.1 + width / 2;
}
