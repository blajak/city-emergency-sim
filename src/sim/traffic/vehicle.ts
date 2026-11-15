import type { RoutePoint } from '../routing/router';
import type { DriverParams } from './idm';
import { BUS_LENGTH, BUS_WIDTH } from '../world/constants';
import type { SegmentId } from './laneGraph';

export type VehicleId = number;
export type VehicleModel =
  | 'sedan'
  | 'hatchback'
  | 'van'
  | 'fire_engine'
  | 'police_car'
  | 'bus'
  /** Articulated lorry: `truck` is the tractor, drawn with a `trailer`. */
  | 'truck'
  | 'trailer'
  | 'garbage_truck'
  | 'delivery_van';
export type VehicleRole = 'civilian' | 'fire' | 'police' | 'bus' | 'truck' | 'garbage' | 'delivery';

/** Roles that stop at kerb spots for a short while and then leave on their own. */
export const SERVICE_ROLES: readonly VehicleRole[] = ['bus', 'truck', 'garbage', 'delivery'];

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
  bus: { length: BUS_LENGTH, width: BUS_WIDTH },
  // Whole articulated lorry (tractor + trailer), as traffic sees it.
  truck: { length: 15.2, width: 2.55 },
  trailer: { length: 11.6, width: 2.55 },
  garbage_truck: { length: 9.5, width: 2.5 },
  delivery_van: { length: 5.4, width: 2.05 },
};

/** Geometry of the articulated lorry, measured back from the front bumper. */
export const TRUCK = {
  /** Length of the tractor unit. */
  tractorLength: 6,
  /** Fifth wheel (kingpin) behind the front bumper. */
  kingpin: 4.6,
  /** Trailer front overhang ahead of the kingpin. */
  trailerOverhang: 1,
  /** Trailer axles behind the kingpin (the trailer pivots there). */
  trailerAxle: 8.5,
} as const;

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

  /** The destination is a stop in the lane (bus stop without a bay): stay in traffic there. */
  stopInLane: boolean;
  /** Standing at an in-lane stop (still `driving`, so traffic queues behind it). */
  halted: boolean;
  /** Halted bus this vehicle is driving around through the opposite lane. */
  overtaking: VehicleId | null;
  /** Bus this vehicle waits behind in the lane until it leaves the kerb spot it is heading to. */
  waitingForKerb: VehicleId | null;

  pose: Pose;
  /** Pose at the previous tick, for render interpolation. */
  prevPose: Pose;
  /** Articulated lorries: the trailer's pose (`pose` is the tractor's), else null. */
  trailer: Pose | null;
  prevTrailer: Pose | null;
}

export interface Body {
  pose: Pose;
  length: number;
  width: number;
}

/** Rigid parts of a vehicle (two for an articulated lorry), for drawing and collision checks. */
export function vehicleBodies(v: Pick<Vehicle, 'model' | 'pose' | 'trailer' | 'length' | 'width'>): Body[] {
  if (v.model !== 'truck' || !v.trailer) return [{ pose: v.pose, length: v.length, width: v.width }];
  return [
    { pose: v.pose, length: TRUCK.tractorLength, width: v.width },
    { pose: v.trailer, length: VEHICLE_DIMENSIONS.trailer.length, width: v.width },
  ];
}

/** Driving to an incident with sirens on: gets priority at junctions and on the road. */
export function isResponding(v: Vehicle): boolean {
  return v.sirens && v.destination !== null && v.maneuver === 'driving';
}

/** Curb offset that keeps a parked vehicle clear of traffic in the lane. */
export function parkingOffset(width: number): number {
  // Far enough that the widest vehicle (fire engine, 2.5 m) can pass in the lane
  // with the passing clearance plus 5 cm of slack; partly on the sidewalk, as in
  // real streets.
  return 1.5 + width / 2;
}
