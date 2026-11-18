import { samplePolyline } from '../math/geometry';
import type { Rng } from '../math/rng';
import { type Vec2, normalize, rightOf, sub } from '../math/vec2';
import { type RoutePoint, Router } from '../routing/router';
import type { LaneCrossing } from '../rail/crossings';
import { NO_SIGNALS, type SignalLookup } from '../signals/signalSystem';
import { DEFAULT_DRIVER, idmFreeTerm, idmInteractionTerm } from './idm';
import type { Connector, Lane, LaneGraph, Segment, SegmentId, Turn } from './laneGraph';
import {
  type Pose,
  SERVICE_ROLES,
  TRUCK,
  VEHICLE_DIMENSIONS,
  type Vehicle,
  type VehicleModel,
  type VehicleRole,
  isResponding,
  parkingOffset,
  vehicleBodies,
} from './vehicle';

/** How far ahead drivers look for leaders, stop lines and slower segments. */
const LOOKAHEAD = 80;
/** Hard physical braking limit. */
const MAX_BRAKING = 9;
/** Free space needed on the target lane before entering an intersection. */
const EXIT_SPACE_MARGIN = 3;
/** Stop this far before the stop line. */
const STOP_LINE_MARGIN = 0.5;
const MIN_SPAWN_SPACING = 14;
/** Oncoming vehicles closer than this to the stop line make left-turners wait. */
const YIELD_DISTANCE = 30;
/** Sideways speed when pulling over or rejoining traffic, m/s. */
const LATERAL_SPEED = 1.4;
/** Clear lane needed behind a parked vehicle before it pulls out, m. */
const MERGE_GAP_BEHIND = 35;
/** A vehicle counts as arrived when stopped this close to its destination. */
const ARRIVAL_TOLERANCE = 1.5;

// --- Emergency driving -------------------------------------------------------
/** Civilians this far ahead of a responding vehicle pull over and stop. */
const YIELD_AHEAD = 60;
/** How far right a yielding civilian moves from the lane centre, m. */
const PULL_OVER_LATERAL = 1.4;
/**
 * Pulling over needs a free kerb beside the vehicle and this far ahead, m: one that
 * pulls over and then stops behind a parked vehicle blocks the responder behind it
 * (with a lorry's tail still in the junction, neither can move).
 */
const PULL_OVER_ROOM_AHEAD = 12;
/** A responder driving past a pulled-over vehicle counts as beside it this far before its body is level, m. */
const PASSING_LEAD = 1.5;
/** Units overtaking in opposite directions keep at least this far apart, m. */
const ONCOMING_RANGE = 30;
/** Last part of a lane where vehicles queue for the junction and are never passed. */
const STOP_ZONE = 10;
/** Speed of a vehicle pulled over for a responding unit, m/s. */
const YIELD_CRAWL_SPEED = 1.5;
/** Widest civilian vehicle, used to size the overtaking offset. */
const MAX_CIVILIAN_WIDTH = 2.0;
/** Responding vehicles reserve junctions from this far away (pre-emption). */
const EMERGENCY_REQUEST_DISTANCE = 60;
/** Speed at which a responding vehicle crosses against a red light, m/s. */
const RED_LIGHT_CROSSING_SPEED = 4;
/** Deceleration a civilian is asked for when its junction reservation is revoked. */
const REVOKE_DECEL = 5;
/** Extra side clearance required to pass a vehicle in the same lane, m. */
const PASSING_CLEARANCE = 0.2;
/** Near the stop line, cars don't pull over if the responding vehicle turns right there. */
const STOP_LINE_PULL_OVER_LIMIT = 14;
/** Responding vehicles drive this much faster than the limit. */
const EMERGENCY_SPEED_FACTOR = 1.2;

// --- Buses -------------------------------------------------------------------
/** Sideways position of a bus standing at an in-lane stop (close to the kerb). */
const IN_LANE_STOP_LATERAL = 0.6;
/** Arrival tolerance for in-lane stops (the bus may be held up just short of the stop). */
const IN_LANE_ARRIVAL_TOLERANCE = 5;
/** A bus heading for an in-lane stop moves towards the kerb from this distance. */
const IN_LANE_APPROACH = 25;
/** Vehicles longer than this (buses, lorries) need more room between junction movements, m. */
const LONG_VEHICLE = 10;
/** Speed while driving around a halted bus, m/s. */
const OVERTAKING_SPEED = 6;
/** Room needed in front of the bus to pull back in, beyond the overtaking car's length. */
const OVERTAKE_MERGE_ROOM = 6;
/** No overtaking while a responding vehicle is this close. */
const OVERTAKE_EMERGENCY_RANGE = 120;
/** Junction entries onto a lane are refused while an overtaker is this close to its start (plus own length). */
const OVERTAKER_ENTRY_ROOM = 15;

const TURN_WEIGHTS: Record<Turn, number> = { straight: 0.5, right: 0.25, left: 0.25 };
const CAR_COLORS = [0xd94b3d, 0x2f6fb3, 0xf2f2f2, 0x2b2b2b, 0x9aa3ab, 0xe0b23a, 0x3f8f5a, 0x7b4fa0, 0x5bb5d6, 0xb5543a];
const MODELS: VehicleModel[] = ['sedan', 'sedan', 'hatchback', 'hatchback', 'van'];

export type TrafficEvent =
  | { kind: 'parked'; vehicle: Vehicle }
  | { kind: 'departed'; vehicle: Vehicle }
  /** Came to a stop at an in-lane destination (bus stop without a bay). */
  | { kind: 'halted'; vehicle: Vehicle };

/** Level crossings on lanes, as the traffic sees them. */
export interface CrossingLookup {
  crossingsOn(laneId: SegmentId): readonly LaneCrossing[];
  /** Expected wait at the barrier when arriving `eta` seconds from now (forecast of train movements). */
  expectedWait?(lc: LaneCrossing, eta: number): number;
}

// --- Crossing-aware routing of responding units --------------------------------
/** Responding units check their route against the crossing forecast this often, steps. */
const REPLAN_INTERVAL = 20;
/** Only look for a detour when the route ahead is expected to wait at least this long, s. */
const REPLAN_MIN_WAIT = 3;
/** A detour must save at least this much time, s. */
const REPLAN_MIN_GAIN = 3;

export const NO_CROSSINGS: CrossingLookup = { crossingsOn: () => [] };

/** A stretch of kerb used by a vehicle that is off the road network (e.g. turning onto a driveway). */
export interface KerbUse {
  segment: SegmentId;
  from: number;
  to: number;
}

export interface ParkedVehicleSpec {
  role: VehicleRole;
  model: VehicleModel;
  color: number;
  at: RoutePoint;
}

/**
 * All vehicles on the road: IDM car-following along lanes, a reservation
 * system at intersections so conflicting movements never overlap, and curb
 * parking / merging for service vehicles.
 */
export class TrafficSystem {
  readonly vehicles: Vehicle[] = [];
  /** Connector id → vehicles holding a reservation for it. */
  private readonly reservations = new Map<SegmentId, Set<Vehicle>>();
  private readonly incomingConnectors = new Map<SegmentId, SegmentId[]>();
  /** Lane in the other direction of the same street. */
  private readonly oppositeLane = new Map<SegmentId, SegmentId>();
  /** Vehicles taking part in traffic, per segment (rebuilt every step). */
  private bySegment = new Map<SegmentId, Vehicle[]>();
  /** Every vehicle including parked ones, per segment (rebuilt every step). */
  private allBySegment = new Map<SegmentId, Vehicle[]>();
  /** Vehicles overtaking a halted bus, per lane they are on (rebuilt every step). */
  private overtakersBySegment = new Map<SegmentId, Vehicle[]>();
  /** Vehicles whose tail is still on the segment they just left, keyed by that segment (rebuilt every step). */
  private tailsBySegment = new Map<SegmentId, Vehicle[]>();
  private byId = new Map<number, Vehicle>();
  private nextId = 0;
  private stepCount = 0;
  private readonly kerbProviders: (() => readonly KerbUse[])[] = [];
  private kerbUsers(): KerbUse[] {
    return this.kerbProviders.flatMap((p) => p());
  }
  readonly router: Router;
  private events: TrafficEvent[] = [];

  constructor(
    readonly graph: LaneGraph,
    private readonly rng: Rng,
    private readonly signals: SignalLookup = NO_SIGNALS,
    private readonly crossings: CrossingLookup = NO_CROSSINGS,
  ) {
    this.router = new Router(graph);
    const byEdge = new Map<number, Lane[]>();
    for (const lane of graph.lanes) byEdge.set(lane.edgeId, [...(byEdge.get(lane.edgeId) ?? []), lane]);
    for (const [, pair] of byEdge) {
      if (pair.length === 2) {
        this.oppositeLane.set(pair[0].id, pair[1].id);
        this.oppositeLane.set(pair[1].id, pair[0].id);
      }
    }
    for (const c of graph.connectors) {
      const list = this.incomingConnectors.get(c.toLane) ?? [];
      list.push(c.id);
      this.incomingConnectors.set(c.toLane, list);
    }
  }

  segment(id: SegmentId): Segment {
    return this.graph.segments[id];
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  spawnCivilians(count: number): void {
    const lanes = this.graph.lanes.filter((l) => l.length > 25 && !l.yard);
    let spawned = 0;
    let attempts = 0;
    while (spawned < count && attempts++ < count * 50) {
      const lane = this.rng.pick(lanes);
      const model = this.rng.pick(MODELS);
      const { length } = VEHICLE_DIMENSIONS[model];
      const s = this.rng.range(length + 1, lane.length - 6);
      const crowded = this.vehicles.some(
        (v) => v.segment === lane.id && Math.abs(v.s - s) < MIN_SPAWN_SPACING,
      );
      if (crowded || this.blocksCrossing(lane.id, s, length)) continue;
      const vehicle = this.createVehicle('civilian', model, this.rng.pick(CAR_COLORS), lane.id, s);
      vehicle.v = this.rng.range(2, 7);
      vehicle.wander = true;
      vehicle.driver.speedFactor = this.rng.range(0.85, 1.1);
      this.ensurePlan(vehicle);
      this.vehicles.push(vehicle);
      spawned++;
    }
  }

  /** Adds a vehicle parked at the curb (e.g. a unit in front of its station). */
  spawnParked(spec: ParkedVehicleSpec): Vehicle {
    const vehicle = this.createVehicle(spec.role, spec.model, spec.color, spec.at.segment, spec.at.s);
    vehicle.maneuver = 'parked';
    vehicle.lateral = parkingOffset(vehicle.width);
    this.updatePose(vehicle);
    vehicle.prevPose = { ...vehicle.pose };
    vehicle.prevTrailer = vehicle.trailer && { ...vehicle.trailer };
    this.vehicles.push(vehicle);
    return vehicle;
  }

  /** Adds a stationary vehicle in the lane (e.g. a bus starting at a stop). */
  spawnDriving(spec: ParkedVehicleSpec): Vehicle {
    const vehicle = this.createVehicle(spec.role, spec.model, spec.color, spec.at.segment, spec.at.s);
    this.vehicles.push(vehicle);
    return vehicle;
  }

  removeVehicle(vehicle: Vehicle): void {
    this.cancelReservation(vehicle);
    this.releaseClearing(vehicle);
    const index = this.vehicles.indexOf(vehicle);
    if (index >= 0) this.vehicles.splice(index, 1);
  }

  /**
   * Sends a vehicle along the fastest route to `destination`, where it will
   * stop and park. Parked vehicles first wait for a gap and pull out.
   */
  sendTo(vehicle: Vehicle, destination: RoutePoint, sirens: boolean, inLane = false): boolean {
    // Responders plan around level crossings that are expected to be closed.
    const route = this.routeFrom(vehicle, destination, sirens);
    if (!route) return false;
    this.setRoute(vehicle, route.segments.slice(1), destination, inLane);
    vehicle.sirens = sirens;
    vehicle.driver.speedFactor = sirens ? EMERGENCY_SPEED_FACTOR : 1;
    return true;
  }

  /**
   * Sends a vehicle along a given sequence of segments (after its current one)
   * to `destination`. With `inLane`, it stops there in the lane instead of
   * pulling over to the kerb (bus stops without a bay).
   */
  sendAlong(vehicle: Vehicle, plan: SegmentId[], destination: RoutePoint, inLane: boolean): void {
    this.setRoute(vehicle, plan, destination, inLane);
    vehicle.sirens = false;
  }

  /** True while a car is driving around this (halted) vehicle. */
  isBeingOvertaken(vehicle: Vehicle): boolean {
    return this.vehicles.some((v) => v.overtaking === vehicle.id);
  }

  private setRoute(vehicle: Vehicle, plan: SegmentId[], destination: RoutePoint, inLane: boolean): void {
    vehicle.plan = plan;
    vehicle.wander = false;
    vehicle.destination = destination;
    vehicle.stopInLane = inLane;
    vehicle.halted = false;
    // A reservation for the junction ahead is void if the new route turns elsewhere
    // (on a connector, the reservation is the junction being crossed: keep it).
    const onLane = this.segment(vehicle.segment).kind === 'lane';
    if (onLane && vehicle.reservation !== null && vehicle.reservation !== vehicle.plan[0]) {
      this.cancelReservation(vehicle);
    }
    if (vehicle.maneuver === 'parked' || vehicle.maneuver === 'arriving') vehicle.maneuver = 'waiting_to_merge';
  }

  /** Lets a vehicle cruise the city with random turns (police patrol). */
  patrol(vehicle: Vehicle): void {
    vehicle.destination = null;
    vehicle.wander = true;
    vehicle.sirens = false;
    vehicle.stopInLane = false;
    vehicle.halted = false;
    vehicle.driver.speedFactor = 0.9;
    // On a lane, keep an already reserved intersection so the car doesn't brake hard
    // mid-approach. On a connector the reservation is the one being driven on.
    const onLane = this.segment(vehicle.segment).kind === 'lane';
    vehicle.plan = onLane && vehicle.reservation !== null ? [vehicle.reservation] : [];
    this.ensurePlan(vehicle);
    if (vehicle.maneuver === 'parked' || vehicle.maneuver === 'arriving') vehicle.maneuver = 'waiting_to_merge';
  }

  /** Kerb space used off the network (driveway manoeuvres, buses leaving the depot yard): vehicles don't pull over there. */
  addKerbUsers(users: () => readonly KerbUse[]): void {
    this.kerbProviders.push(users);
  }

  /** A driveway manoeuvre uses the kerb of `segment` somewhere between `from` and `to`. */
  kerbInUse(segment: SegmentId, from: number, to: number): boolean {
    return this.kerbUsers().some((k) => k.segment === segment && k.to > from && k.from < to);
  }

  /**
   * Travel time estimate from the vehicle's position, or Infinity when unreachable.
   * With `crossingAware`, includes expected waits at level crossings (as responders route).
   */
  travelTime(vehicle: Vehicle, destination: RoutePoint, crossingAware = false): number {
    return this.routeFrom(vehicle, destination, crossingAware)?.time ?? Infinity;
  }

  private routeFrom(vehicle: Vehicle, destination: RoutePoint, crossingAware = false) {
    const from = { segment: vehicle.segment, s: vehicle.s };
    if (crossingAware && this.crossings.expectedWait) return this.router.findTimed(from, destination, this.crossingDelay);
    return this.router.find(from, destination, vehicle.yardAccess);
  }

  /** Expected seconds waiting at level crossings while driving a lane from `fromS` to `toS`. */
  private readonly crossingDelay = (segmentId: SegmentId, entryTime: number, fromS: number, toS: number): number => {
    const forecast = this.crossings;
    if (!forecast.expectedWait) return 0;
    const seg = this.segment(segmentId);
    let wait = 0;
    for (const lc of forecast.crossingsOn(segmentId)) {
      if (lc.stopS < fromS || lc.stopS >= toS) continue;
      wait += forecast.expectedWait(lc, entryTime + (lc.stopS - fromS) / seg.speedLimit + wait);
    }
    return wait;
  };

  /**
   * A responder whose route crosses the railway where a train is expected
   * switches to a detour when that is clearly faster. The lane it is on and a
   * junction it has already reserved are kept.
   */
  private replanAroundCrossings(vehicle: Vehicle): void {
    const dest = vehicle.destination;
    const lane = this.segment(vehicle.segment);
    if (!dest || vehicle.wander || vehicle.maneuver !== 'driving' || lane.kind !== 'lane' || vehicle.plan.length === 0) return;
    const anchored = vehicle.reservation !== null && vehicle.reservation === vehicle.plan[0];
    const from: RoutePoint = anchored ? { segment: vehicle.plan[0], s: 0 } : { segment: vehicle.segment, s: vehicle.s };
    const rest = anchored ? vehicle.plan.slice(1) : vehicle.plan;
    const startTime = anchored ? Math.max(0, lane.length - vehicle.s) / lane.speedLimit : 0;
    const current = this.router.timeAlong(from, rest, dest, this.crossingDelay, startTime);
    if (current.wait < REPLAN_MIN_WAIT) return;
    const detour = this.router.findTimed(from, dest, this.crossingDelay, startTime);
    if (!detour || detour.time > current.time - REPLAN_MIN_GAIN) return;
    this.setRoute(vehicle, anchored ? detour.segments : detour.segments.slice(1), dest, vehicle.stopInLane);
  }

  private createVehicle(role: VehicleRole, model: VehicleModel, color: number, segment: SegmentId, s: number): Vehicle {
    const { length, width } = VEHICLE_DIMENSIONS[model];
    const vehicle: Vehicle = {
      id: this.nextId++,
      role,
      model,
      color,
      length,
      width,
      driver: { ...DEFAULT_DRIVER },
      segment,
      previousSegment: null,
      s,
      v: 0,
      a: 0,
      plan: [],
      wander: false,
      destination: null,
      reservation: null,
      clearing: null,
      maneuver: 'driving',
      lateral: 0,
      sirens: false,
      yieldingTo: null,
      yieldMode: 'stop',
      odometer: 0,
      yardAccess: false,
      stopInLane: false,
      halted: false,
      overtaking: null,
      waitingForKerb: null,
      pose: { x: 0, z: 0, yaw: 0 },
      prevPose: { x: 0, z: 0, yaw: 0 },
      trailer: null,
      prevTrailer: null,
    };
    this.updatePose(vehicle);
    vehicle.prevPose = { ...vehicle.pose };
    vehicle.prevTrailer = vehicle.trailer && { ...vehicle.trailer };
    return vehicle;
  }

  // -------------------------------------------------------------------------
  // Simulation step
  // -------------------------------------------------------------------------

  /** Advances all vehicles; returns parking / departure events from this step. */
  step(dt: number): TrafficEvent[] {
    this.events = [];
    this.stepCount++;
    for (const v of this.vehicles) {
      if (v.sirens && (this.stepCount + v.id) % REPLAN_INTERVAL === 0) this.replanAroundCrossings(v);
    }
    this.indexBySegment();
    this.assignYielding();
    this.updateOvertaking();
    const driving = this.vehicles.filter((v) => v.maneuver === 'driving');
    // Decide all accelerations first so every driver reacts to the same snapshot.
    const accelerations = driving.map((v) => this.decideAcceleration(v));
    driving.forEach((vehicle, i) => this.integrate(vehicle, accelerations[i], dt));
    for (const vehicle of this.vehicles) {
      if (vehicle.maneuver !== 'driving') this.updateManeuver(vehicle, dt);
    }
    return this.events;
  }

  private updateManeuver(vehicle: Vehicle, dt: number): void {
    vehicle.prevPose = vehicle.pose;
    vehicle.prevTrailer = vehicle.trailer;
    vehicle.v = 0;
    const curb = parkingOffset(vehicle.width);
    switch (vehicle.maneuver) {
      case 'arriving':
        // Only pull over once nobody is beside us on the curb side.
        if (this.blockedOnRight(vehicle)) break;
        vehicle.lateral = Math.min(curb, vehicle.lateral + LATERAL_SPEED * dt);
        if (vehicle.lateral >= curb) {
          vehicle.maneuver = 'parked';
          this.events.push({ kind: 'parked', vehicle });
        }
        break;
      case 'waiting_to_merge':
        if (this.canMerge(vehicle)) vehicle.maneuver = 'merging';
        break;
      case 'merging':
        vehicle.lateral = Math.max(0, vehicle.lateral - LATERAL_SPEED * dt);
        if (vehicle.lateral === 0) {
          vehicle.maneuver = 'driving';
          this.events.push({ kind: 'departed', vehicle });
        }
        break;
      case 'parked':
      case 'driving':
        break;
    }
    this.updatePose(vehicle);
  }

  private blockedOnRight(vehicle: Vehicle): boolean {
    // The tail of a long vehicle that has just turned off this lane may still be beside us.
    const lane = this.segment(vehicle.segment);
    for (const o of this.vehicles) {
      if (o.previousSegment !== vehicle.segment || o.segment === vehicle.segment || o.s >= o.length) continue;
      if (lane.length - (o.length - o.s) < vehicle.s + 1) return true;
    }
    return (this.allBySegment.get(vehicle.segment) ?? []).some(
      (o) =>
        o !== vehicle &&
        o.segment === vehicle.segment &&
        // A bus or lorry standing in a bay counts too: nobody pulls over onto it (it leaves soon).
        (o.maneuver === 'driving' || (SERVICE_ROLES.includes(o.role) && o.maneuver !== 'arriving')) &&
        o.lateral > vehicle.lateral &&
        o.s > vehicle.s - vehicle.length - 1 &&
        o.s - o.length < vehicle.s + 1,
    );
  }

  private canMerge(vehicle: Vehicle): boolean {
    // Never pull out into a car overtaking a bus from the other direction.
    const lane = this.segment(vehicle.segment);
    for (const o of this.oncomingOvertakers(vehicle.segment)) {
      const front = lane.length - o.s;
      if (front < vehicle.s + 10 && front + o.length > vehicle.s - MERGE_GAP_BEHIND) return false;
    }
    // A bus queuing behind for this kerb spot waits for us to leave; so does everyone behind it.
    const waiting = (this.bySegment.get(vehicle.segment) ?? []).find(
      (o) => o.waitingForKerb === vehicle.id && o.v < 0.5 && o.s < vehicle.s - vehicle.length,
    );
    // A long vehicle that has just left the lane may still have its tail beside us.
    for (const other of this.vehicles) {
      if (other.previousSegment !== vehicle.segment || other.segment === vehicle.segment || other.s >= other.length) continue;
      if (lane.length - (other.length - other.s) < vehicle.s + 3) return false;
    }
    for (const other of this.bySegment.get(vehicle.segment) ?? []) {
      if (other === vehicle) continue;
      if (waiting && other.s <= waiting.s) continue;
      if (other.s > vehicle.s - MERGE_GAP_BEHIND && other.s - other.length < vehicle.s + 3) return false;
    }
    // (Anyone entering the lane would queue behind the waiting vehicle.)
    if (vehicle.s < MERGE_GAP_BEHIND && !waiting) {
      for (const id of this.incomingConnectors.get(vehicle.segment) ?? []) {
        if ((this.bySegment.get(id) ?? []).length > 0) return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Driving decisions
  // -------------------------------------------------------------------------

  private decideAcceleration(vehicle: Vehicle): number {
    const p = vehicle.driver;
    const current = this.segment(vehicle.segment);
    let desiredSpeed = current.speedLimit * p.speedFactor;
    if (vehicle.overtaking !== null) desiredSpeed = Math.min(desiredSpeed, OVERTAKING_SPEED);
    vehicle.waitingForKerb = null;
    let interaction = 0;
    const obstacle = (gap: number, speed: number) => {
      interaction = Math.max(interaction, idmInteractionTerm(vehicle.v, speed, gap, p));
    };

    const responding = isResponding(vehicle);
    if (vehicle.yieldingTo !== null && vehicle.yieldMode === 'stop' && current.kind === 'lane') {
      // Pulling over for a responding vehicle: slow to a crawl. Not a full stop, so a
      // queue of yielding and non-yielding vehicles can never lock each other.
      obstacle(4 + vehicle.v * p.timeHeadway, YIELD_CRAWL_SPEED);
    }

    const path = [vehicle.segment, ...vehicle.plan];
    // Distance from our front bumper to the start of the segment being inspected.
    let offset = -vehicle.s;
    for (let i = 0; i < path.length; i++) {
      const seg = this.segment(path[i]);

      if (seg.kind === 'lane') {
        this.levelCrossingObstacles(vehicle, seg, i === 0, offset, obstacle);
        this.oncomingOvertakerObstacles(vehicle, seg, i === 0, offset, obstacle);
      }

      const isFinal = vehicle.destination !== null && i === path.length - 1;
      if (isFinal) {
        // Final segment of a route: come to a stop at the destination.
        obstacle(offset + vehicle.destination!.s + p.minGap, 0);
        if (!vehicle.stopInLane) {
          // A bus or lorry still at the kerb spot (it leaves soon): wait behind it in the lane.
          const blocker = this.serviceAtKerb(vehicle, vehicle.destination!);
          if (blocker) {
            const gap = offset + blocker.s - blocker.length;
            const ahead = blocker.s + vehicle.length + 1.5;
            if (gap <= 0 && ahead <= seg.length - 6) {
              // Already beside it (e.g. after overtaking pulled-over cars): park just in front instead.
              vehicle.destination = { segment: vehicle.destination!.segment, s: ahead };
            } else {
              obstacle(gap, 0);
              // Only someone fully behind it counts as waiting (the blocker may then pull out).
              if (gap > 0) vehicle.waitingForKerb = blocker.id;
            }
          }
        }
      }

      const leader = this.nearestAhead(seg.id, i === 0 ? vehicle : null);
      if (leader) {
        obstacle(offset + leader.s - leader.length, leader.v);
        break;
      }
      if (isFinal) break;

      offset += seg.length; // now: distance to the end of `seg`
      const next = i + 1 < path.length ? this.segment(path[i + 1]) : null;
      if (!next || offset > LOOKAHEAD) break;

      if (next.kind === 'connector') {
        // Only the first car in line, approaching its own stop line, decides.
        // Yielding civilians wait for the responding vehicle before entering a junction.
        const decides = i === 0 && seg.kind === 'lane';
        const lightAllows = decides && (responding || this.lightAllowsEntry(vehicle, seg, offset));
        if (decides && !lightAllows) this.cancelReservation(vehicle);
        const reserved =
          lightAllows &&
          (vehicle.reservation === next.id ||
            (offset < this.requestDistance(vehicle) &&
              (responding ? this.tryReserveForEmergency(vehicle, next) : this.tryReserve(vehicle, next))));
        if (responding && reserved && this.signals.lightFor(seg.id) !== 'green' && this.signals.lightFor(seg.id) !== null) {
          // Crossing against the light: slow down and go through carefully.
          obstacle(offset + p.minGap + RED_LIGHT_CROSSING_SPEED * p.timeHeadway, RED_LIGHT_CROSSING_SPEED);
        }
        if (!reserved) {
          // Treat the stop line as a stationary obstacle.
          obstacle(offset - STOP_LINE_MARGIN + p.minGap, 0);
          break;
        }
      }

      const nextSpeed = next.speedLimit * p.speedFactor;
      if (nextSpeed < vehicle.v) {
        // Virtual leader at the segment boundary moving at the lower limit.
        obstacle(offset + p.minGap + nextSpeed * p.timeHeadway, nextSpeed);
      }
    }

    const accel = p.maxAccel * (idmFreeTerm(vehicle.v, desiredSpeed) - interaction);
    return Math.max(-MAX_BRAKING, accel);
  }

  /**
   * Level crossings ahead on a lane: stop at the barrier while it is closing
   * or closed (unless too close to stop when the lights start), and never
   * drive onto the tracks without room to get all the way across.
   */
  private levelCrossingObstacles(
    vehicle: Vehicle,
    lane: Lane,
    isCurrent: boolean,
    offset: number,
    obstacle: (gap: number, speed: number) => void,
  ): void {
    for (const lc of this.crossings.crossingsOn(lane.id)) {
      // Clearly past the barrier: keep going and clear the tracks. (A car waiting at
      // the barrier sits just before it; anyone between the barrier and the tracks
      // can still stop in the 2.5 m before the danger zone.)
      if (isCurrent && vehicle.s > lc.stopS + 0.5) continue;
      const distance = offset + lc.stopS;
      const stop = () => obstacle(distance - 0.3 + vehicle.driver.minGap, 0);
      const { state } = lc.crossing;
      if (state === 'closed') {
        stop();
      } else if (state === 'warning') {
        const canStop = vehicle.v < 2 || (vehicle.v * vehicle.v) / (2 * vehicle.driver.comfortDecel) < distance - 1;
        if (canStop) stop();
      } else if (isCurrent) {
        // Open: only cross if the queue beyond leaves room for the whole vehicle.
        for (const other of this.bySegment.get(lane.id) ?? []) {
          // Only vehicles ahead of us and past the barrier take up room beyond the tracks.
          if (other === vehicle || other.s <= lc.stopS || other.s <= vehicle.s) continue;
          if (other.s - other.length < lc.endS + vehicle.length + 1.5) {
            stop();
            break;
          }
        }
      }
    }
  }

  /** True when a curb stop [s - length, s] on the lane would block a level crossing. */
  blocksCrossing(laneId: SegmentId, s: number, length: number): boolean {
    return this.crossings.crossingsOn(laneId).some((lc) => s > lc.stopS - 3 && s - length < lc.endS + 3);
  }

  /**
   * Closest vehicle on `segmentId` ahead of `self` (or the last one in line if
   * `self` is null). On a connector, vehicles on sibling connectors (same
   * incoming lane) count too: their paths overlap right after the stop line.
   */
  private nearestAhead(segmentId: SegmentId, self: Vehicle | null): Vehicle | null {
    const seg = this.segment(segmentId);
    const candidates =
      seg.kind === 'connector' ? (this.segment(seg.fromLane) as Lane).outConnectors : [segmentId];
    let best: Vehicle | null = null;
    for (const id of candidates) {
      // Parked vehicles count too: anyone not far enough to the side must not drive into them.
      for (const other of this.allBySegment.get(id) ?? []) {
        if (other === self) continue;
        if (!self && other.maneuver !== 'driving' && other.maneuver !== 'arriving' && other.maneuver !== 'merging') continue;
        if (self && (other.s < self.s || (other.s === self.s && other.id < self.id))) continue;
        // Passing side by side only works within a lane, and not next to someone at
        // the stop line: both would enter the junction together, where paths cross.
        const queuingAtLine = other.maneuver === 'driving' && seg.length - other.s < STOP_ZONE;
        if (self && seg.kind === 'lane' && !queuingAtLine && this.sideBySide(self, other)) continue;
        // The one whose rear is closest: a long bus can start behind a shorter car yet end further on.
        if (!best || other.s - other.length < best.s - best.length) best = other;
      }
    }
    if (seg.kind === 'lane') {
      // A long vehicle that has just left this lane still has its tail at the end of it:
      // seen as a vehicle whose front is beyond the lane end. Never passed side by side.
      for (const other of this.tailsBySegment.get(segmentId) ?? []) {
        if (other === self) continue;
        const front = seg.length + other.s;
        if (!best || front - other.length < best.s - best.length) best = { ...other, s: front };
      }
    }
    return best;
  }

  /** Two vehicles in the same lane far enough apart sideways to pass each other. */
  private sideBySide(a: Vehicle, b: Vehicle): boolean {
    return Math.abs(a.lateral - b.lateral) >= (a.width + b.width) / 2 + PASSING_CLEARANCE;
  }

  private requestDistance(vehicle: Vehicle): number {
    const normal = (vehicle.v * vehicle.v) / (2 * vehicle.driver.comfortDecel) + 10;
    return isResponding(vehicle) ? Math.max(normal, EMERGENCY_REQUEST_DISTANCE) : normal;
  }

  /**
   * Green: go. Yellow: stop if it can be done comfortably, otherwise go.
   * Red: stop — unless already committed and physically unable to.
   */
  private lightAllowsEntry(vehicle: Vehicle, lane: Lane, distanceToLine: number): boolean {
    const light = this.signals.lightFor(lane.id);
    if (light === null || light === 'green') return true;
    // A stopped or creeping car can always wait for the next green.
    if (vehicle.v < 2) return false;
    const v2 = vehicle.v * vehicle.v;
    if (light === 'yellow') return v2 / (2 * vehicle.driver.comfortDecel) > distanceToLine - 1;
    return vehicle.reservation !== null && v2 / (2 * MAX_BRAKING) > distanceToLine - STOP_LINE_MARGIN;
  }

  private tryReserve(vehicle: Vehicle, connector: Connector): boolean {
    for (const conflictId of connector.conflicts) {
      const holders = this.reservations.get(conflictId);
      if (holders && holders.size > 0) return false;
    }
    if (this.longConflict(vehicle, connector)) return false;
    if (connector.turn === 'left' && this.oncomingHasPriority(connector)) return false;
    if (this.overtakerNearStart(connector, vehicle)) return false;
    if (!this.roomBehindKerbBlocker(vehicle, connector.toLane)) return false;
    if (this.crossingStopsInJunction(vehicle, connector)) return false;
    // Do not block the junction if the exit lane is backed up.
    const tail = this.lastInLine(connector.toLane);
    if (tail && tail.s - tail.length < vehicle.length + vehicle.driver.minGap + EXIT_SPACE_MARGIN) return false;

    let holders = this.reservations.get(connector.id);
    if (!holders) this.reservations.set(connector.id, (holders = new Set()));
    holders.add(vehicle);
    vehicle.reservation = connector.id;
    return true;
  }

  /**
   * A level crossing just past the junction is closed, or will be by the time the
   * vehicle gets there, and the barrier is too close for the whole vehicle to wait
   * clear of the junction: entering would leave its tail across other movements.
   */
  private crossingStopsInJunction(vehicle: Vehicle, connector: Connector): boolean {
    const current = this.segment(vehicle.segment);
    const toLine = current.kind === 'lane' ? Math.max(0, current.length - vehicle.s) : 0;
    const { maxAccel } = vehicle.driver;
    const vmax = Math.max(vehicle.v, connector.speedLimit);
    for (const lc of this.crossings.crossingsOn(connector.toLane)) {
      if (lc.stopS > vehicle.length + vehicle.driver.minGap + 2) continue; // room to wait off the junction
      if (lc.crossing.state !== 'open') return true;
      // Time to reach the barrier, accelerating from the current speed (not a crawl estimate:
      // with trains every minute or so, a pessimistic guess would never find a gap).
      const d = toLine + connector.length + lc.stopS;
      const tAccel = (vmax - vehicle.v) / maxAccel;
      const dAccel = vehicle.v * tAccel + 0.5 * maxAccel * tAccel * tAccel;
      const eta = d <= dAccel ? (-vehicle.v + Math.sqrt(vehicle.v * vehicle.v + 2 * maxAccel * d)) / maxAccel : tAccel + (d - dAccel) / vmax;
      if ((this.crossings.expectedWait?.(lc, eta + 2) ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * Junction pre-emption for a responding vehicle: conflicting reservations of
   * vehicles that have not entered yet are revoked when they can still stop.
   * Anyone already inside (or unable to stop) is waited for.
   */
  private tryReserveForEmergency(vehicle: Vehicle, connector: Connector): boolean {
    const revoke: Vehicle[] = [];
    for (const conflictId of connector.conflicts) {
      for (const holder of this.reservations.get(conflictId) ?? []) {
        const inside = holder.segment === conflictId || holder.clearing === conflictId;
        if (inside || isResponding(holder) || !this.canStopBeforeJunction(holder)) return false;
        revoke.push(holder);
      }
    }
    if (this.longConflict(vehicle, connector)) return false;
    const tail = this.lastInLine(connector.toLane, vehicle);
    if (tail && tail.s - tail.length < vehicle.length + vehicle.driver.minGap + EXIT_SPACE_MARGIN) return false;
    if (this.overtakerNearStart(connector, vehicle)) return false;
    if (!this.roomBehindKerbBlocker(vehicle, connector.toLane)) return false;
    if (this.crossingStopsInJunction(vehicle, connector)) return false;

    for (const holder of revoke) this.cancelReservation(holder);
    let holders = this.reservations.get(connector.id);
    if (!holders) this.reservations.set(connector.id, (holders = new Set()));
    holders.add(vehicle);
    vehicle.reservation = connector.id;
    return true;
  }

  /** A nearby movement is in use and one of the two vehicles is long (bus, lorry: they cut corners more). */
  private longConflict(vehicle: Vehicle, connector: Connector): boolean {
    const long = vehicle.length > LONG_VEHICLE;
    for (const id of connector.longConflicts) {
      for (const holder of this.reservations.get(id) ?? []) {
        if (long || holder.length > LONG_VEHICLE) return true;
      }
    }
    return false;
  }

  private canStopBeforeJunction(vehicle: Vehicle): boolean {
    const seg = this.segment(vehicle.segment);
    if (seg.kind !== 'lane') return false;
    const distance = seg.length - vehicle.s - STOP_LINE_MARGIN;
    return (vehicle.v * vehicle.v) / (2 * REVOKE_DECEL) < distance;
  }

  /**
   * Marks civilians ahead of (or beside) a responding vehicle in its path as
   * yielding. They pull over and stop until it has passed.
   */
  private assignYielding(): void {
    for (const v of this.vehicles) {
      v.yieldingTo = null;
      v.yieldMode = 'stop';
    }
    for (const e of this.vehicles) {
      if (!isResponding(e)) continue;
      const path = [e.segment, ...e.plan];
      let offset = -e.s; // distance from e's front to the start of the inspected segment
      for (let i = 0; i < path.length && offset < YIELD_AHEAD; i++) {
        const seg = this.segment(path[i]);
        if (seg.kind === 'lane') {
          // A car pulled over at the stop line would be in the way of e turning right there.
          const next = i + 1 < path.length ? this.segment(path[i + 1]) : null;
          const turnsRightHere = next?.kind === 'connector' && next.turn === 'right';
          for (const c of this.bySegment.get(seg.id) ?? []) {
            if (!this.canYield(c) || c.yieldingTo !== null) continue;
            // No room at the curb (parked vehicle beside it): just keep driving.
            if (!this.roomToPullOver(c)) continue;
            if (turnsRightHere && seg.length - c.s < STOP_LINE_PULL_OVER_LIMIT) continue;
            if (this.queuedAtLineAhead(e, c)) continue;
            const ahead = offset + c.s; // > 0: c's front is ahead of e's front
            // Keep yielding until e's tail is clear of c's front.
            if (ahead > -(e.length + 3) && ahead < YIELD_AHEAD) c.yieldingTo = e.id;
          }
        }
        offset += seg.length;
      }
      // Anyone right beside it keeps yielding too (e.g. e just entered a junction). With
      // the kerb ahead blocked, only while e is really beside it: one that e is merely
      // queued behind moves back out and drives on past the obstacle.
      for (const c of this.vehicles) {
        if (!this.canYield(c) || c.yieldingTo !== null || c.lateral <= 0.5 || !this.alongside(e, c)) continue;
        if (this.roomToPullOver(c) || this.alongside(e, c, -0.5) || this.overlapsAlong(e, c, e.v > 1 ? PASSING_LEAD : 0)) c.yieldingTo = e.id;
      }
    }
    // Next to a service vehicle that has stopped to park, stay pulled over but drive on.
    for (const e of this.vehicles) {
      if (!e.sirens || e.maneuver !== 'arriving') continue;
      for (const c of this.vehicles) {
        if (this.canYield(c) && c.yieldingTo === null && c.lateral > 0.5 && this.alongside(e, c)) {
          c.yieldingTo = e.id;
          c.yieldMode = 'hold';
        }
      }
    }
  }

  /**
   * `c` is ahead of responder `e` in the same lane, in the last metres before the stop
   * line, where nobody passes side by side: pulled over there it would wait for `e` while
   * `e` waits behind it. It drives on through the junction instead.
   */
  private queuedAtLineAhead(e: Vehicle, c: Vehicle): boolean {
    if (c.segment !== e.segment || c.s <= e.s) return false;
    const seg = this.segment(c.segment);
    return seg.kind === 'lane' && seg.length - c.s < STOP_ZONE;
  }

  /**
   * Everyone driving without sirens pulls over, except vehicles too wide to
   * be passed in the lane (fire engines on their way back), which just drive on.
   */
  private canYield(v: Vehicle): boolean {
    // Buses and lorries are wide too, but pull over further so their left side lines up with a car's.
    const fits = v.width <= MAX_CIVILIAN_WIDTH || SERVICE_ROLES.includes(v.role);
    return !v.sirens && v.maneuver === 'driving' && fits && v.overtaking === null;
  }

  /** How far right a yielding vehicle moves: wider ones go further, keeping the same left edge. */
  private pullOverLateral(v: Vehicle): number {
    return PULL_OVER_LATERAL + Math.max(0, (v.width - MAX_CIVILIAN_WIDTH) / 2);
  }

  /**
   * Some part of `e`'s body is level with some part of `c`'s along `c`'s heading (whatever
   * the gap between the centres): `c` moving back out would cut into it. A vehicle queued
   * right behind `c` does not overlap.
   */
  private overlapsAlong(e: Vehicle, c: Vehicle, margin = 0): boolean {
    const dx = Math.sin(c.pose.yaw);
    const dz = Math.cos(c.pose.yaw);
    const span = (v: Vehicle): [number, number] => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const b of vehicleBodies(v)) {
        const d = (b.pose.x - c.pose.x) * dx + (b.pose.z - c.pose.z) * dz;
        lo = Math.min(lo, d - b.length / 2);
        hi = Math.max(hi, d + b.length / 2);
      }
      return [lo, hi];
    };
    const [e0, e1] = span(e);
    const [c0, c1] = span(c);
    return e0 < c1 + margin && c0 < e1 + margin;
  }

  /**
   * Bodies close together (centres within half their lengths plus `margin`). With
   * a negative margin only vehicles really side by side count, not one queued
   * right behind the other.
   */
  private alongside(a: Vehicle, b: Vehicle, margin = 3): boolean {
    if (!a.trailer && !b.trailer) return Math.hypot(a.pose.x - b.pose.x, a.pose.z - b.pose.z) < (a.length + b.length) / 2 + margin;
    // Articulated lorries: beside the tractor or the trailer.
    for (const x of vehicleBodies(a)) {
      for (const y of vehicleBodies(b)) {
        if (Math.hypot(x.pose.x - y.pose.x, x.pose.z - y.pose.z) < (x.length + y.length) / 2 + margin) return true;
      }
    }
    return false;
  }

  /** Sideways target for a driving vehicle: pulled over, overtaking, or centred. */
  private lateralTarget(vehicle: Vehicle): number {
    const onLane = this.segment(vehicle.segment).kind === 'lane';
    if (vehicle.yieldingTo !== null) {
      // A long vehicle stays pulled over until its tail has left the lane too: the
      // responding vehicle may still be passing it there.
      const tailOnLane = vehicle.s < vehicle.length;
      return onLane || tailOnLane ? this.pullOverLateral(vehicle) : 0;
    }
    if (vehicle.overtaking !== null) return onLane ? this.overtakingLateral(vehicle) : 0;
    const dest = vehicle.destination;
    if (vehicle.stopInLane && dest && onLane && vehicle.plan.length === 0 && dest.s - vehicle.s < IN_LANE_APPROACH) {
      // Close to the kerb, unless someone stands at the kerb on the way (then stay centred to pass them).
      const kerbBusy = (this.allBySegment.get(dest.segment) ?? []).some(
        (o) => o !== vehicle && o.maneuver !== 'driving' && o.s > vehicle.s - vehicle.length - 2 && o.s - o.length < dest.s + 3,
      );
      return kerbBusy ? 0 : IN_LANE_STOP_LATERAL;
    }
    if (isResponding(vehicle)) {
      const passing = this.vehicles.some(
        (c) =>
          c.yieldingTo !== null &&
          ((c.segment === vehicle.segment && c.s > vehicle.s - vehicle.length - c.length - 3 && c.s < vehicle.s + 35) ||
            this.alongside(vehicle, c)),
      );
      // Move left just enough to pass the widest car pulled over to the right — but
      // never start while a unit coming the other way is overtaking (both would
      // cross the centre line). Once moved over, finish the manoeuvre.
      const alreadyOver = vehicle.lateral < -0.3;
      if (passing && (alreadyOver || !this.oncomingOvertaker(vehicle))) {
        return PULL_OVER_LATERAL - (MAX_CIVILIAN_WIDTH / 2 + vehicle.width / 2 + PASSING_CLEARANCE + 0.05);
      }
    }
    return 0;
  }

  /**
   * A responding unit on the opposite lane, close by, that is overtaking or
   * about to (ties broken by id, so two units never start together).
   */
  private oncomingOvertaker(vehicle: Vehicle): boolean {
    const lane = this.segment(vehicle.segment);
    if (lane.kind !== 'lane') return false;
    const opposite = this.oppositeLane.get(lane.id);
    if (opposite === undefined) return false;
    const oppositeLength = this.segment(opposite).length;
    return (this.bySegment.get(opposite) ?? []).some(
      (o) =>
        isResponding(o) &&
        (o.lateral < -0.05 || o.id < vehicle.id) &&
        Math.abs(oppositeLength - o.s - vehicle.s) < ONCOMING_RANGE + (o.length + vehicle.length) / 2,
    );
  }

  /** No parked vehicle at the curb right next to us. */
  private roomToPullOver(vehicle: Vehicle): boolean {
    return !(this.allBySegment.get(vehicle.segment) ?? []).some(
      (o) =>
        o !== vehicle &&
        o.segment === vehicle.segment &&
        o.maneuver !== 'driving' &&
        o.s > vehicle.s - vehicle.length - 2 &&
        o.s - o.length < vehicle.s + PULL_OVER_ROOM_AHEAD,
    ) && !this.kerbUsers().some(
      (k) => k.segment === vehicle.segment && k.to > vehicle.s - vehicle.length - 2 && k.from < vehicle.s + PULL_OVER_ROOM_AHEAD,
    );
  }

  /**
   * Left turns yield: deny while a vehicle with a green light is about to
   * take a conflicting straight or right-turn movement.
   */
  private oncomingHasPriority(leftTurn: Connector): boolean {
    for (const conflictId of leftTurn.conflicts) {
      const other = this.segment(conflictId) as Connector;
      if (other.turn === 'left' || other.fromLane === leftTurn.fromLane) continue;
      if (this.signals.lightFor(other.fromLane) !== 'green') continue;
      const lane = this.segment(other.fromLane);
      const head = this.firstInLine(lane.id);
      if (!head || head.plan[0] !== other.id || lane.length - head.s >= YIELD_DISTANCE) continue;
      // A head that is stopped without permission to go (e.g. its exit is blocked)
      // is not about to take the movement; don't wait for it forever. One held only by
      // left turns into the same exit is: otherwise a stream of left turns, each
      // reserving before the last has cleared, starves it (a lorry turning right).
      if (head.v > 0.5 || head.reservation === other.id || this.heldByLeftTurns(head, other)) return true;
    }
    return false;
  }

  /**
   * Stopped at its stop line, and nothing but reservations of left turns (which should
   * have yielded to it) keeps it from entering.
   */
  private heldByLeftTurns(vehicle: Vehicle, connector: Connector): boolean {
    const lane = this.segment(vehicle.segment);
    if (lane.kind !== 'lane' || lane.length - vehicle.s > STOP_LINE_MARGIN + vehicle.driver.minGap + 1) return false;
    if (vehicle.reservation !== null || vehicle.yieldingTo !== null) return false;
    let held = false;
    for (const id of connector.conflicts) {
      const other = this.segment(id) as Connector;
      // Only holders that can take the movement now count: one queued behind another
      // vehicle (a unit stuck behind the very left turn that is yielding) never clears.
      const holders = [...(this.reservations.get(id) ?? [])].filter(
        (h) => h.segment !== other.fromLane || this.firstInLine(other.fromLane) === h,
      );
      if (holders.length === 0) continue;
      if (other.turn !== 'left') return false;
      held = true;
    }
    if (!held || this.longConflict(vehicle, connector)) return false;
    if (this.overtakerNearStart(connector, vehicle)) return false;
    if (!this.roomBehindKerbBlocker(vehicle, connector.toLane)) return false;
    if (this.crossingStopsInJunction(vehicle, connector)) return false;
    const tail = this.lastInLine(connector.toLane);
    return !tail || tail.s - tail.length >= vehicle.length + vehicle.driver.minGap + EXIT_SPACE_MARGIN;
  }

  private cancelReservation(vehicle: Vehicle): void {
    if (vehicle.reservation === null) return;
    this.reservations.get(vehicle.reservation)?.delete(vehicle);
    vehicle.reservation = null;
  }

  private releaseClearing(vehicle: Vehicle): void {
    if (vehicle.clearing === null) return;
    this.reservations.get(vehicle.clearing)?.delete(vehicle);
    vehicle.clearing = null;
  }

  private firstInLine(segmentId: SegmentId): Vehicle | null {
    let first: Vehicle | null = null;
    for (const v of this.bySegment.get(segmentId) ?? []) if (!first || v.s > first.s) first = v;
    return first;
  }

  /** Rear-most vehicle on a segment; with `passer`, vehicles it can pass side by side are ignored. */
  private lastInLine(segmentId: SegmentId, passer?: Vehicle): Vehicle | null {
    let last: Vehicle | null = null;
    for (const v of this.bySegment.get(segmentId) ?? []) {
      if (passer && v.yieldingTo !== null) continue;
      if (!last || v.s < last.s) last = v;
    }
    return last;
  }

  // -------------------------------------------------------------------------
  // Buses: kerb spots and overtaking a bus halted in the lane
  // -------------------------------------------------------------------------

  /** A bus or delivery vehicle standing at (or pulling into / out of) the kerb spot ending at `dest`. */
  private serviceAtKerb(vehicle: Vehicle, dest: RoutePoint): Vehicle | null {
    for (const o of this.allBySegment.get(dest.segment) ?? []) {
      if (o === vehicle || !SERVICE_ROLES.includes(o.role) || o.maneuver === 'driving') continue;
      if (o.s > dest.s - vehicle.length - 1 && o.s - o.length < dest.s + 1) return o;
    }
    return null;
  }

  /**
   * Heading for a kerb spot on `laneId` that a bus or lorry still occupies:
   * enter only if the whole vehicle fits in the lane behind it, so it never
   * waits with its tail in the junction.
   */
  private roomBehindKerbBlocker(vehicle: Vehicle, laneId: SegmentId): boolean {
    const dest = vehicle.destination;
    if (!dest || dest.segment !== laneId || vehicle.stopInLane || vehicle.plan.length > 2) return true;
    const blocker = this.serviceAtKerb(vehicle, dest);
    return !blocker || blocker.s - blocker.length >= vehicle.length + vehicle.driver.minGap + EXIT_SPACE_MARGIN;
  }

  /** Someone already at the kerb where the vehicle would pull over. */
  private kerbTaken(vehicle: Vehicle, dest: RoutePoint, margin = 0.5): boolean {
    return (this.allBySegment.get(dest.segment) ?? []).some(
      (o) => o !== vehicle && o.maneuver !== 'driving' && o.s > dest.s - vehicle.length - margin && o.s - o.length < dest.s + margin,
    );
  }

  /** Vehicles overtaking on the lane running the other way along the same street. */
  private oncomingOvertakers(laneId: SegmentId): readonly Vehicle[] {
    const opposite = this.oppositeLane.get(laneId);
    return opposite === undefined ? [] : (this.overtakersBySegment.get(opposite) ?? []);
  }

  /** A car overtaking towards us in our lane is a stationary obstacle at its front bumper. */
  private oncomingOvertakerObstacles(
    vehicle: Vehicle,
    lane: Lane,
    isCurrent: boolean,
    offset: number,
    obstacle: (gap: number, speed: number) => void,
  ): void {
    for (const o of this.oncomingOvertakers(lane.id)) {
      const front = lane.length - o.s;
      if (isCurrent && vehicle.s > front) continue; // already beside it: braking would not help
      obstacle(offset + front, 0);
    }
  }

  /**
   * Entering via `connector` now would meet a car overtaking near the start of
   * its lane, or (turning in, as a non-responding vehicle) cut the corner past a
   * responding unit at the end of the opposite lane that is moved over to pass.
   * Going straight past such a unit fits, and two units never block each other.
   */
  private overtakerNearStart(connector: Connector, vehicle: Vehicle): boolean {
    const laneId = connector.toLane;
    const lane = this.segment(laneId);
    if (this.oncomingOvertakers(laneId).some((o) => lane.length - o.s < vehicle.length + OVERTAKER_ENTRY_ROOM)) return true;
    if (connector.turn === 'straight' || isResponding(vehicle)) return false;
    const opposite = this.oppositeLane.get(laneId);
    if (opposite === undefined) return false;
    const oppositeLength = this.segment(opposite).length;
    return (this.bySegment.get(opposite) ?? []).some(
      (o) => isResponding(o) && o.lateral < -0.3 && oppositeLength - o.s < OVERTAKER_ENTRY_ROOM,
    );
  }

  /** Sideways target while overtaking: beside the bus until past it, then back into the lane. */
  private overtakingLateral(vehicle: Vehicle): number {
    const bus = this.byId.get(vehicle.overtaking!);
    if (bus && bus.segment === vehicle.segment && vehicle.s - vehicle.length <= bus.s + 1.5) {
      return bus.lateral - ((bus.width + vehicle.width) / 2 + PASSING_CLEARANCE + 0.1);
    }
    return 0;
  }

  /** Ends finished overtaking manoeuvres and starts new ones where it is safe. */
  private updateOvertaking(): void {
    for (const v of this.vehicles) {
      if (v.overtaking === null) continue;
      const bus = this.byId.get(v.overtaking);
      const passed = !bus || bus.segment !== v.segment || v.s - v.length > bus.s + 1.5;
      if (passed && Math.abs(v.lateral) < 0.05) {
        v.lateral = 0;
        v.overtaking = null;
      }
    }
    for (const v of this.vehicles) {
      if (v.overtaking !== null) continue;
      const bus = this.overtakeCandidate(v);
      if (!bus) continue;
      v.overtaking = bus.id;
      const list = this.overtakersBySegment.get(v.segment);
      if (list) list.push(v);
      else this.overtakersBySegment.set(v.segment, [v]);
    }
  }

  /**
   * The halted vehicle (bus at a stop, garbage truck at a bin) right in front of a waiting car, if the car may drive
   * around it now: room to pull back in before the junction, no level
   * crossing, no responding vehicle around, and the opposite lane clear of
   * traffic that could meet it (including vehicles about to enter it).
   */
  private overtakeCandidate(v: Vehicle): Vehicle | null {
    if (v.role !== 'civilian' || v.sirens || v.maneuver !== 'driving' || v.yieldingTo !== null) return null;
    if (v.width > MAX_CIVILIAN_WIDTH || v.v > 3) return null;
    const lane = this.segment(v.segment);
    if (lane.kind !== 'lane') return null;
    const bus = this.nearestAhead(lane.id, v);
    if (!bus || !bus.halted || bus.segment !== lane.id) return null;
    if (bus.s - bus.length - v.s > 10) return null;
    const tail = v.s - v.length;
    const endPass = bus.s + v.length + OVERTAKE_MERGE_ROOM;
    if (tail < 1 || endPass > lane.length - STOP_ZONE - 3) return null;

    for (const o of this.bySegment.get(lane.id) ?? []) {
      if (o.overtaking !== null) return null; // one at a time
      if (o === v || o === bus) continue;
      if (o.s > bus.s - 0.01 && o.s - o.length < endPass + 3) return null; // no room to pull back in
    }
    if (this.crossings.crossingsOn(lane.id).some((lc) => lc.endS > tail - 5 && lc.stopS < endPass + 5)) return null;
    for (const e of this.vehicles) {
      if (isResponding(e) && Math.hypot(e.pose.x - v.pose.x, e.pose.z - v.pose.z) < OVERTAKE_EMERGENCY_RANGE) return null;
    }

    const opposite = this.oppositeLane.get(lane.id);
    if (opposite === undefined) return null;
    // Opposite-lane position of our tail: everyone there who has not yet passed it is in the way.
    const zoneEnd = this.segment(opposite).length - tail;
    for (const o of this.allBySegment.get(opposite) ?? []) {
      if (o.maneuver === 'parked' || o.maneuver === 'waiting_to_merge') continue;
      if (o.s - o.length < zoneEnd + 5) return null;
    }
    // A long vehicle that has just left the opposite lane may still have its tail at its end.
    for (const o of this.vehicles) {
      if (o.previousSegment === opposite && o.segment !== opposite && o.s < o.length) return null;
    }
    for (const id of this.incomingConnectors.get(opposite) ?? []) {
      if ((this.bySegment.get(id) ?? []).length > 0 || (this.reservations.get(id)?.size ?? 0) > 0) return null;
      const c = this.segment(id) as Connector;
      const head = this.firstInLine(c.fromLane);
      if (head && head.plan[0] === id && head.v > 1 && this.segment(c.fromLane).length - head.s < 40) return null;
    }
    return bus;
  }

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------

  private integrate(vehicle: Vehicle, accel: number, dt: number): void {
    vehicle.prevPose = vehicle.pose;
    vehicle.prevTrailer = vehicle.trailer;
    const v0 = vehicle.v;
    const v1 = Math.max(0, v0 + accel * dt);
    // When the vehicle comes to a stop within the step, use the exact stopping distance.
    const ds = v1 > 0 ? ((v0 + v1) / 2) * dt : Math.min(v0 * dt, (v0 * v0) / (2 * Math.max(-accel, 1e-6)));
    vehicle.v = v1;
    vehicle.a = accel;
    vehicle.s += ds;
    vehicle.odometer += ds;

    let seg = this.segment(vehicle.segment);
    while (vehicle.s >= seg.length && vehicle.plan.length > 0) {
      const nextId = vehicle.plan[0];
      const next = this.segment(nextId);
      if (next.kind === 'connector' && vehicle.reservation !== next.id) {
        // Safety net: never enter an intersection without a reservation.
        vehicle.s = seg.length - 0.01;
        vehicle.v = 0;
        break;
      }
      if (seg.kind === 'connector') {
        // Keep the junction reserved until the tail is out of it.
        this.releaseClearing(vehicle);
        vehicle.clearing = vehicle.reservation;
        vehicle.reservation = null;
      }
      vehicle.s -= seg.length;
      vehicle.previousSegment = vehicle.segment;
      vehicle.segment = nextId;
      vehicle.plan.shift();
      this.ensurePlan(vehicle);
      seg = next;
    }
    vehicle.s = Math.min(vehicle.s, seg.length);
    if (seg.kind === 'lane' && vehicle.s >= vehicle.length) this.releaseClearing(vehicle);

    const target = this.lateralTarget(vehicle);
    const step = LATERAL_SPEED * dt;
    vehicle.lateral += Math.max(-step, Math.min(step, target - vehicle.lateral));

    const dest = vehicle.destination;
    // An in-lane stop also counts when something keeps the vehicle a few metres short of it.
    const tolerance = vehicle.stopInLane ? IN_LANE_ARRIVAL_TOLERANCE : ARRIVAL_TOLERANCE;
    if (
      dest &&
      vehicle.plan.length === 0 &&
      vehicle.segment === dest.segment &&
      vehicle.v < 0.5 &&
      dest.s - vehicle.s < tolerance &&
      vehicle.s - dest.s < ARRIVAL_TOLERANCE
    ) {
      vehicle.v = 0;
      // A bay taken by someone else (e.g. a unit at an incident): stop in the lane instead.
      if (SERVICE_ROLES.includes(vehicle.role) && !vehicle.stopInLane && this.kerbTaken(vehicle, dest)) vehicle.stopInLane = true;
      if (vehicle.stopInLane) {
        // Keep the destination: it holds the vehicle at the stop until it is sent on.
        if (!vehicle.halted) {
          vehicle.halted = true;
          this.events.push({ kind: 'halted', vehicle });
        }
      } else {
        vehicle.destination = null;
        vehicle.maneuver = 'arriving';
      }
    }

    this.updatePose(vehicle);
  }

  /** Wandering vehicles keep one connector and the lane after it planned ahead. */
  private ensurePlan(vehicle: Vehicle): void {
    if (!vehicle.wander) return;
    while (vehicle.plan.length < 2) {
      const lastId = vehicle.plan.length ? vehicle.plan[vehicle.plan.length - 1] : vehicle.segment;
      const last = this.segment(lastId);
      vehicle.plan.push(last.kind === 'lane' ? this.chooseConnector(last) : last.toLane);
    }
  }

  private chooseConnector(lane: Lane): SegmentId {
    // Wandering cars never turn into the private yard road.
    const options = lane.outConnectors.map((id) => this.segment(id) as Connector).filter((c) => !(this.segment(c.toLane) as Lane).yard);
    const total = options.reduce((sum, c) => sum + TURN_WEIGHTS[c.turn], 0);
    let roll = this.rng.next() * total;
    for (const c of options) {
      roll -= TURN_WEIGHTS[c.turn];
      if (roll <= 0) return c.id;
    }
    return options[options.length - 1].id;
  }

  private updatePose(vehicle: Vehicle): void {
    if (vehicle.model === 'truck') {
      const { tractor, trailer } = this.articulatedPose(vehicle);
      vehicle.pose = tractor;
      vehicle.trailer = trailer;
    } else {
      vehicle.pose = this.computePose(vehicle);
    }
  }

  /** Point on the path `back` metres behind the front bumper (into the previous segment, then straight on). */
  private pointBehind(vehicle: Vehicle, back: number): Vec2 {
    const seg = this.segment(vehicle.segment);
    const s = vehicle.s - back;
    if (s >= 0) return samplePolyline(seg.points, s).point;
    const previous = vehicle.previousSegment !== null ? this.segment(vehicle.previousSegment) : null;
    if (previous && previous.length + s >= 0) return samplePolyline(previous.points, previous.length + s).point;
    const first = previous ?? seg;
    const start = first.points[0];
    const dir = normalize(sub(first.points[1], start));
    const missing = previous ? -(previous.length + s) : -s;
    return { x: start.x - dir.x * missing, z: start.z - dir.z * missing };
  }

  /**
   * Articulated lorry: the tractor between its front bumper and the fifth
   * wheel, the trailer between the fifth wheel and its axles, each on the path.
   */
  private articulatedPose(vehicle: Vehicle): { tractor: Pose; trailer: Pose } {
    const front = this.pointBehind(vehicle, 0);
    const kingpin = this.pointBehind(vehicle, TRUCK.kingpin);
    const axle = this.pointBehind(vehicle, TRUCK.kingpin + TRUCK.trailerAxle);
    const body = (ahead: Vec2, behind: Vec2, aheadOffset: number, length: number): Pose => {
      const dir = normalize(sub(ahead, behind));
      const side = rightOf(dir);
      // Centre: from the leading reference point, back by half the body length minus its overhang.
      const back = length / 2 - aheadOffset;
      return {
        x: ahead.x - dir.x * back + side.x * vehicle.lateral,
        z: ahead.z - dir.z * back + side.z * vehicle.lateral,
        yaw: Math.atan2(dir.x, dir.z),
      };
    };
    return {
      tractor: body(front, kingpin, 0, TRUCK.tractorLength),
      trailer: body(kingpin, axle, TRUCK.trailerOverhang, VEHICLE_DIMENSIONS.trailer.length),
    };
  }

  /**
   * Body centre and heading from the front and rear bumper positions along
   * the actual path, so long vehicles follow curves instead of sticking out.
   */
  private computePose(vehicle: Vehicle): Pose {
    const seg = this.segment(vehicle.segment);
    const front = samplePolyline(seg.points, vehicle.s);
    const rearS = vehicle.s - vehicle.length;
    const previous = rearS < 0 && vehicle.previousSegment !== null ? this.segment(vehicle.previousSegment) : null;
    const rearPoint = previous
      ? samplePolyline(previous.points, previous.length + rearS).point
      : samplePolyline(seg.points, rearS).point;
    // samplePolyline clamps at 0: extrapolate straight back when there is no earlier segment.
    const missing = previous ? 0 : Math.max(0, -rearS);
    const back = { x: rearPoint.x - front.dir.x * missing, z: rearPoint.z - front.dir.z * missing };

    let dx = front.point.x - back.x;
    let dz = front.point.z - back.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const side = rightOf({ x: dx, z: dz });
    return {
      x: (front.point.x + back.x) / 2 + side.x * vehicle.lateral,
      z: (front.point.z + back.z) / 2 + side.z * vehicle.lateral,
      yaw: Math.atan2(dx, dz),
    };
  }

  /** Index of vehicles that take part in traffic (parked ones are off the road). */
  private indexBySegment(): void {
    this.bySegment = new Map();
    this.allBySegment = new Map();
    this.overtakersBySegment = new Map();
    this.tailsBySegment = new Map();
    this.byId = new Map();
    const push = (map: Map<SegmentId, Vehicle[]>, v: Vehicle) => {
      const list = map.get(v.segment);
      if (list) list.push(v);
      else map.set(v.segment, [v]);
    };
    for (const v of this.vehicles) {
      this.byId.set(v.id, v);
      if (v.previousSegment !== null && v.s < v.length && v.maneuver === 'driving') {
        const list = this.tailsBySegment.get(v.previousSegment);
        if (list) list.push(v);
        else this.tailsBySegment.set(v.previousSegment, [v]);
      }
      if (v.overtaking !== null) push(this.overtakersBySegment, v);
      push(this.allBySegment, v);
      if (v.maneuver !== 'parked' && v.maneuver !== 'waiting_to_merge') push(this.bySegment, v);
    }
  }
}
