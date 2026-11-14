import { samplePolyline } from '../math/geometry';
import type { Rng } from '../math/rng';
import { rightOf } from '../math/vec2';
import { type RoutePoint, Router } from '../routing/router';
import { NO_SIGNALS, type SignalLookup } from '../signals/signalSystem';
import { DEFAULT_DRIVER, idmFreeTerm, idmInteractionTerm } from './idm';
import type { Connector, Lane, LaneGraph, Segment, SegmentId, Turn } from './laneGraph';
import {
  type Pose,
  VEHICLE_DIMENSIONS,
  type Vehicle,
  type VehicleModel,
  type VehicleRole,
  isResponding,
  parkingOffset,
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

const TURN_WEIGHTS: Record<Turn, number> = { straight: 0.5, right: 0.25, left: 0.25 };
const CAR_COLORS = [0xd94b3d, 0x2f6fb3, 0xf2f2f2, 0x2b2b2b, 0x9aa3ab, 0xe0b23a, 0x3f8f5a, 0x7b4fa0, 0x5bb5d6, 0xb5543a];
const MODELS: VehicleModel[] = ['sedan', 'sedan', 'hatchback', 'hatchback', 'van'];

export type TrafficEvent = { kind: 'parked'; vehicle: Vehicle } | { kind: 'departed'; vehicle: Vehicle };

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
  private nextId = 0;
  readonly router: Router;
  private events: TrafficEvent[] = [];

  constructor(
    readonly graph: LaneGraph,
    private readonly rng: Rng,
    private readonly signals: SignalLookup = NO_SIGNALS,
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
    const lanes = this.graph.lanes.filter((l) => l.length > 25);
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
      if (crowded) continue;
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
    vehicle.pose = this.computePose(vehicle);
    vehicle.prevPose = { ...vehicle.pose };
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
  sendTo(vehicle: Vehicle, destination: RoutePoint, sirens: boolean): boolean {
    const route = this.routeFrom(vehicle, destination);
    if (!route) return false;
    vehicle.plan = route.segments.slice(1);
    vehicle.wander = false;
    vehicle.destination = destination;
    vehicle.sirens = sirens;
    vehicle.driver.speedFactor = sirens ? EMERGENCY_SPEED_FACTOR : 1;
    // A reservation for the junction ahead is void if the new route turns elsewhere
    // (on a connector, the reservation is the junction being crossed: keep it).
    const onLane = this.segment(vehicle.segment).kind === 'lane';
    if (onLane && vehicle.reservation !== null && vehicle.reservation !== vehicle.plan[0]) {
      this.cancelReservation(vehicle);
    }
    if (vehicle.maneuver === 'parked' || vehicle.maneuver === 'arriving') vehicle.maneuver = 'waiting_to_merge';
    return true;
  }

  /** Lets a vehicle cruise the city with random turns (police patrol). */
  patrol(vehicle: Vehicle): void {
    vehicle.destination = null;
    vehicle.wander = true;
    vehicle.sirens = false;
    vehicle.driver.speedFactor = 0.9;
    // On a lane, keep an already reserved intersection so the car doesn't brake hard
    // mid-approach. On a connector the reservation is the one being driven on.
    const onLane = this.segment(vehicle.segment).kind === 'lane';
    vehicle.plan = onLane && vehicle.reservation !== null ? [vehicle.reservation] : [];
    this.ensurePlan(vehicle);
    if (vehicle.maneuver === 'parked' || vehicle.maneuver === 'arriving') vehicle.maneuver = 'waiting_to_merge';
  }

  /** Travel time estimate from the vehicle's position, or Infinity when unreachable. */
  travelTime(vehicle: Vehicle, destination: RoutePoint): number {
    return this.routeFrom(vehicle, destination)?.time ?? Infinity;
  }

  private routeFrom(vehicle: Vehicle, destination: RoutePoint) {
    return this.router.find({ segment: vehicle.segment, s: vehicle.s }, destination);
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
      pose: { x: 0, z: 0, yaw: 0 },
      prevPose: { x: 0, z: 0, yaw: 0 },
    };
    vehicle.pose = this.computePose(vehicle);
    vehicle.prevPose = { ...vehicle.pose };
    return vehicle;
  }

  // -------------------------------------------------------------------------
  // Simulation step
  // -------------------------------------------------------------------------

  /** Advances all vehicles; returns parking / departure events from this step. */
  step(dt: number): TrafficEvent[] {
    this.events = [];
    this.indexBySegment();
    this.assignYielding();
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
    vehicle.pose = this.computePose(vehicle);
  }

  private blockedOnRight(vehicle: Vehicle): boolean {
    return (this.allBySegment.get(vehicle.segment) ?? []).some(
      (o) =>
        o !== vehicle &&
        o.segment === vehicle.segment &&
        o.maneuver === 'driving' &&
        o.lateral > vehicle.lateral &&
        o.s > vehicle.s - vehicle.length - 1 &&
        o.s - o.length < vehicle.s + 1,
    );
  }

  private canMerge(vehicle: Vehicle): boolean {
    for (const other of this.bySegment.get(vehicle.segment) ?? []) {
      if (other === vehicle) continue;
      if (other.s > vehicle.s - MERGE_GAP_BEHIND && other.s - other.length < vehicle.s + 3) return false;
    }
    if (vehicle.s < MERGE_GAP_BEHIND) {
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
    const desiredSpeed = current.speedLimit * p.speedFactor;
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

      const isFinal = vehicle.destination !== null && i === path.length - 1;
      if (isFinal) {
        // Final segment of a route: come to a stop at the destination.
        obstacle(offset + vehicle.destination!.s + p.minGap, 0);
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
        if (!best || other.s < best.s) best = other;
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
    if (connector.turn === 'left' && this.oncomingHasPriority(connector)) return false;
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
    const tail = this.lastInLine(connector.toLane, vehicle);
    if (tail && tail.s - tail.length < vehicle.length + vehicle.driver.minGap + EXIT_SPACE_MARGIN) return false;

    for (const holder of revoke) this.cancelReservation(holder);
    let holders = this.reservations.get(connector.id);
    if (!holders) this.reservations.set(connector.id, (holders = new Set()));
    holders.add(vehicle);
    vehicle.reservation = connector.id;
    return true;
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
            const ahead = offset + c.s; // > 0: c's front is ahead of e's front
            // Keep yielding until e's tail is clear of c's front.
            if (ahead > -(e.length + 3) && ahead < YIELD_AHEAD) c.yieldingTo = e.id;
          }
        }
        offset += seg.length;
      }
      // Anyone right beside it keeps yielding too (e.g. e just entered a junction).
      for (const c of this.vehicles) {
        if (this.canYield(c) && c.yieldingTo === null && this.alongside(e, c) && c.lateral > 0.5) {
          c.yieldingTo = e.id;
        }
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
   * Everyone driving without sirens pulls over, except vehicles too wide to
   * be passed in the lane (fire engines on their way back), which just drive on.
   */
  private canYield(v: Vehicle): boolean {
    return !v.sirens && v.maneuver === 'driving' && v.width <= MAX_CIVILIAN_WIDTH;
  }

  private alongside(a: Vehicle, b: Vehicle): boolean {
    return Math.hypot(a.pose.x - b.pose.x, a.pose.z - b.pose.z) < (a.length + b.length) / 2 + 3;
  }

  /** Sideways target for a driving vehicle: pulled over, overtaking, or centred. */
  private lateralTarget(vehicle: Vehicle): number {
    const onLane = this.segment(vehicle.segment).kind === 'lane';
    if (vehicle.yieldingTo !== null) return onLane ? PULL_OVER_LATERAL : 0;
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
        o.s - o.length < vehicle.s + 2,
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
      if (head && head.plan[0] === other.id && lane.length - head.s < YIELD_DISTANCE) return true;
    }
    return false;
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
  // Motion
  // -------------------------------------------------------------------------

  private integrate(vehicle: Vehicle, accel: number, dt: number): void {
    vehicle.prevPose = vehicle.pose;
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
    if (
      dest &&
      vehicle.plan.length === 0 &&
      vehicle.segment === dest.segment &&
      vehicle.v < 0.5 &&
      Math.abs(dest.s - vehicle.s) < ARRIVAL_TOLERANCE
    ) {
      vehicle.destination = null;
      vehicle.v = 0;
      vehicle.maneuver = 'arriving';
    }

    vehicle.pose = this.computePose(vehicle);
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
    const options = lane.outConnectors.map((id) => this.segment(id) as Connector);
    const total = options.reduce((sum, c) => sum + TURN_WEIGHTS[c.turn], 0);
    let roll = this.rng.next() * total;
    for (const c of options) {
      roll -= TURN_WEIGHTS[c.turn];
      if (roll <= 0) return c.id;
    }
    return options[options.length - 1].id;
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
    const push = (map: Map<SegmentId, Vehicle[]>, v: Vehicle) => {
      const list = map.get(v.segment);
      if (list) list.push(v);
      else map.set(v.segment, [v]);
    };
    for (const v of this.vehicles) {
      push(this.allBySegment, v);
      if (v.maneuver !== 'parked' && v.maneuver !== 'waiting_to_merge') push(this.bySegment, v);
    }
  }
}
