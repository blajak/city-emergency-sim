import { kerbPoint } from '../dispatch/curb';
import { samplePolyline } from '../math/geometry';
import { type Vec2, add, distance, normalize, rightOf, scale, sub } from '../math/vec2';
import type { Rng } from '../math/rng';
import type { RoutePoint } from '../routing/router';
import type { SegmentId } from '../traffic/laneGraph';
import type { TrafficEvent, TrafficSystem } from '../traffic/trafficSystem';
import { type Pose, VEHICLE_DIMENSIONS, type Vehicle, parkingOffset } from '../traffic/vehicle';
import { BUS_LENGTH, BUS_WIDTH, LANE_WIDTH, STREET_CLEARANCE } from '../world/constants';
import { type DepotYard, depotYard } from '../world/depotYard';
import type { Building, BusLine, BusStop, BusStopId, City } from '../world/types';

/** Target time between two buses of a line, s. */
const TARGET_HEADWAY = 300;
const MAX_BUSES_PER_LINE = 4;
/** Round trips a bus drives before going back to the depot. */
const SHIFT_CYCLES = 3;
/** Scheduled speed is the free-flow speed divided by this (junctions, traffic). */
const SCHEDULE_SLOWDOWN = 1.35;
/** Scheduled dwell at a stop, s. */
const SCHEDULED_DWELL = 18;
const DWELL_RANGE: [number, number] = [12, 18];
/** Layover at the far terminus, s. */
const FAR_LAYOVER = 25;
/** Minimum stand at the home terminus, s. */
const MIN_LAYOVER = 10;
/** A replacement bus leaves the depot this much earlier than strictly needed, s. */
const PULL_OUT_MARGIN = 120;
/** Share of the depot stalls occupied at the start. */
const YARD_FILL = 0.5;
const YARD_SPEED = 3;
const YARD_ACCEL = 1;
/** No bus leaves the yard while a returning bus is this close to the depot, m. */
const RETURNING_RANGE = 150;

export type BusStatus = 'to_line' | 'driving' | 'at_stop' | 'layover' | 'to_depot';

export interface Bus {
  /** Fleet number. */
  id: number;
  name: string;
  line: BusLine;
  vehicle: Vehicle;
  status: BusStatus;
  /** Index in `line.calls` of the stop the bus is heading to or standing at. */
  call: number;
  /** When standing at a stop: sim time it leaves. */
  departAt: number;
  /** Next scheduled departure from the home terminus. */
  plannedDeparture: number;
  /** Departures from the home terminus left before the bus returns to the depot. */
  cyclesLeft: number;
}

export interface BusArrival {
  line: BusLine;
  bus: Bus;
  /** Estimated seconds until the bus reaches the stop (0 = standing there). */
  eta: number;
}

/** Per-line data for driving the route on the lane graph. */
interface LineRuntime {
  line: BusLine;
  /** Lane for each route step. */
  lanes: SegmentId[];
  /** Connector from step i's lane to step i+1's lane (cyclic). */
  connectors: SegmentId[];
  /** Where the bus's front bumper ends up at each call. */
  points: RoutePoint[];
  /** Scheduled time from leaving the home terminus to reaching each call, s. */
  offsets: number[];
  /** Scheduled time for one full round trip, s. */
  cycle: number;
  fleet: number;
  /** Drive from the depot to the home terminus (scheduled), s. */
  fromDepot: number;
}

/** A bus in the depot yard: parked in a stall or driving between the stall and the street. */
export interface YardBus {
  model: 'bus';
  color: number;
  sirens: false;
  stall: number;
  /** Polyline the front bumper follows while moving; null when parked. */
  path: Vec2[] | null;
  pathLength: number;
  /** Front bumper position along `path`. */
  s: number;
  v: number;
  /** Leaving: the bus waits here (front bumper) while the kerb outside is taken. */
  holdAt: number;
  pullOut: PullOut | null;
  pose: Pose;
  prevPose: Pose;
}

interface PullOut {
  line: LineRuntime;
  at: number;
  /** Home-terminus departure the new bus takes over. */
  slot: number;
}

/**
 * Runs the bus lines: buses drive their line's loop stop by stop, stand at
 * each stop for a while (in a bay or in the lane), keep to a simple
 * timetable at the home terminus, and after a shift go back to the depot
 * while a fresh bus pulls out to take over their departures.
 */
export class BusSystem {
  readonly buses: Bus[] = [];
  /** Buses in the depot yard (not part of road traffic). */
  readonly yard: YardBus[] = [];
  private readonly yardLayout: DepotYard | null;
  private readonly lines: LineRuntime[] = [];
  private readonly pullOuts: PullOut[] = [];
  private readonly depot: Building | null;
  private readonly depotPoint: RoutePoint | null;
  private nextId = 1;
  private time = 0;

  constructor(
    private readonly city: City,
    private readonly traffic: TrafficSystem,
    private readonly rng: Rng,
  ) {
    const { length } = VEHICLE_DIMENSIONS.bus;
    this.depot = city.transit.depot !== null ? city.buildings[city.transit.depot] : null;
    const bay = this.depot?.bay;
    this.depotPoint = bay ? kerbPoint(traffic.graph, city.roads, bay.edgeId, bay.side, bay.s, length) : null;
    for (const line of city.transit.lines) this.lines.push(this.prepareLine(line));
    this.yardLayout = this.depot && bay ? depotYard(this.depot) : null;
    this.fillYard();
    this.placeInitialBuses();
  }

  stop(id: BusStopId): BusStop {
    return this.city.transit.stops[id];
  }

  busOf(vehicle: Vehicle): Bus | undefined {
    return this.buses.find((b) => b.vehicle === vehicle);
  }

  /** The stop a bus is heading to or standing at. */
  currentStop(bus: Bus): BusStop {
    return this.stop(bus.line.calls[bus.call].stop);
  }

  /** Lines that call at a stop. */
  linesAt(stopId: BusStopId): BusLine[] {
    return this.city.transit.lines.filter((l) => l.calls.some((c) => c.stop === stopId));
  }

  /** The next `count` stops of a bus in service with estimated seconds to each. */
  upcoming(bus: Bus, count: number): { stop: BusStop; eta: number }[] {
    if (bus.status === 'to_depot') return [];
    const rt = this.runtime(bus);
    const n = bus.line.calls.length;
    const standing = bus.status === 'at_stop' || bus.status === 'layover';
    const out: { stop: BusStop; eta: number }[] = [];
    for (let k = standing ? 1 : 0; out.length < Math.min(count, n); k++) {
      const call = (bus.call + k) % n;
      out.push({ stop: this.stop(bus.line.calls[call].stop), eta: this.eta(rt, bus, call) });
    }
    return out;
  }

  /** Next buses of every line serving the stop, soonest first. */
  arrivals(stopId: BusStopId): BusArrival[] {
    const out: BusArrival[] = [];
    for (const rt of this.lines) {
      const calls = rt.line.calls.map((c, i) => (c.stop === stopId ? i : -1)).filter((i) => i >= 0);
      for (const target of calls) {
        let best: BusArrival | null = null;
        for (const bus of this.buses) {
          if (bus.line !== rt.line || bus.status === 'to_depot') continue;
          const eta = this.eta(rt, bus, target);
          if (!best || eta < best.eta) best = { line: rt.line, bus, eta };
        }
        if (best) out.push(best);
      }
    }
    return out.sort((a, b) => a.eta - b.eta);
  }

  update(time: number, events: readonly TrafficEvent[]): void {
    const dt = time - this.time;
    this.time = time;
    this.moveYardBuses(dt);
    for (const event of events) {
      if (event.kind === 'departed') continue;
      const bus = this.busOf(event.vehicle);
      if (bus) this.arrived(bus);
    }
    for (const bus of [...this.buses]) {
      const standing = bus.status === 'at_stop' || bus.status === 'layover';
      // Never pull away while a car is driving around the bus.
      if (standing && time >= bus.departAt && !this.traffic.isBeingOvertaken(bus.vehicle)) this.depart(bus);
    }
    // Returned buses wait at the kerb outside until the yard is free.
    for (const bus of [...this.buses]) {
      if (bus.status === 'to_depot' && bus.vehicle.maneuver === 'parked') this.arrived(bus);
    }
    for (let i = this.pullOuts.length - 1; i >= 0; i--) {
      if (time >= this.pullOuts[i].at && this.pullOut(this.pullOuts[i])) this.pullOuts.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------

  private prepareLine(line: BusLine): LineRuntime {
    const { graph } = this.traffic;
    const { length } = VEHICLE_DIMENSIONS.bus;
    const lanes = line.route.map((step) => {
      const lane = graph.lanes.find((l) => l.edgeId === step.edgeId && l.forward === step.forward);
      if (!lane) throw new Error(`Line ${line.name}: no lane on edge ${step.edgeId}`);
      return lane;
    });
    const connectors = lanes.map((lane, i) => {
      const next = lanes[(i + 1) % lanes.length];
      const id = lane.outConnectors.find((c) => {
        const seg = graph.segments[c];
        return seg.kind === 'connector' && seg.toLane === next.id;
      });
      if (id === undefined) throw new Error(`Line ${line.name}: no turn from lane ${lane.id} to ${next.id}`);
      return id;
    });
    const points = line.calls.map((call) => {
      const stop = this.stop(call.stop);
      return kerbPoint(graph, this.city.roads, stop.edgeId, stop.side, stop.s, length);
    });

    // Timetable: scheduled time from the home terminus to each call.
    const time = (id: SegmentId) => (graph.segments[id].length / graph.segments[id].speedLimit) * SCHEDULE_SLOWDOWN;
    const offsets: number[] = [0];
    for (let k = 1; k <= line.calls.length; k++) {
      const from = line.calls[k - 1];
      const to = line.calls[k % line.calls.length];
      const fromPoint = points[k - 1];
      const toPoint = points[k % line.calls.length];
      let t = 0;
      const plan = this.planBetween(lanes.map((l) => l.id), connectors, from.step, to.step, fromPoint.s, toPoint.s);
      if (plan.length === 0) t = ((toPoint.s - fromPoint.s) / lanes[from.step].speedLimit) * SCHEDULE_SLOWDOWN;
      else {
        t += time(lanes[from.step].id) * (1 - fromPoint.s / lanes[from.step].length);
        for (const id of plan.slice(0, -1)) t += time(id);
        t += time(lanes[to.step].id) * (toPoint.s / lanes[to.step].length);
      }
      const dwell = k - 1 === line.turnCall ? FAR_LAYOVER : SCHEDULED_DWELL;
      offsets.push(offsets[k - 1] + (k - 1 === 0 ? 0 : dwell) + t);
    }
    const cycle = offsets.pop()! + MIN_LAYOVER;
    const fleet = Math.max(1, Math.min(MAX_BUSES_PER_LINE, Math.round(cycle / TARGET_HEADWAY)));
    let fromDepot = 0;
    if (this.depotPoint) {
      const route = this.traffic.router.find(this.depotPoint, points[0]);
      fromDepot = route ? route.time * SCHEDULE_SLOWDOWN : 0;
    }
    return { line, lanes: lanes.map((l) => l.id), connectors, points, offsets, cycle, fleet, fromDepot };
  }

  /** Lanes and connectors from step `from` (exclusive) to step `to` (inclusive) along the loop. */
  private planBetween(lanes: SegmentId[], connectors: SegmentId[], from: number, to: number, fromS: number, toS: number): SegmentId[] {
    if (from === to && toS > fromS) return [];
    const plan: SegmentId[] = [];
    let i = from;
    do {
      const j = (i + 1) % lanes.length;
      plan.push(connectors[i], lanes[j]);
      i = j;
    } while (i !== to);
    return plan;
  }

  /** Spreads each line's buses evenly over its stops, already in service. */
  private placeInitialBuses(): void {
    const used = new Set<BusStopId>();
    for (const rt of this.lines) {
      const n = rt.line.calls.length;
      for (let j = 0; j < rt.fleet; j++) {
        let call = Math.round((j * n) / rt.fleet) % n;
        for (let k = 0; k < n && used.has(rt.line.calls[call].stop); k++) call = (call + 1) % n;
        if (used.has(rt.line.calls[call].stop)) continue;
        used.add(rt.line.calls[call].stop);
        const bus = this.spawn(rt, rt.points[call], false);
        bus.call = call;
        bus.plannedDeparture = call === 0 ? 0 : rt.cycle - rt.offsets[call];
        bus.cyclesLeft = this.depotPoint ? 1 + (j % SHIFT_CYCLES) : Infinity;
        // Arrives at once: it starts standing at the stop.
        this.traffic.sendAlong(bus.vehicle, [], rt.points[call], !this.currentStop(bus).bay);
      }
    }
  }

  private spawn(rt: LineRuntime, at: RoutePoint, parked: boolean): Bus {
    const spec = { role: 'bus' as const, model: 'bus' as const, color: rt.line.color, at };
    const vehicle = parked ? this.traffic.spawnParked(spec) : this.traffic.spawnDriving(spec);
    vehicle.driver.speedFactor = 0.85;
    const id = this.nextId++;
    const bus: Bus = {
      id,
      name: `Bus ${id}`,
      line: rt.line,
      vehicle,
      status: 'driving',
      call: 0,
      departAt: 0,
      plannedDeparture: 0,
      cyclesLeft: SHIFT_CYCLES,
    };
    this.buses.push(bus);
    return bus;
  }

  private runtime(bus: Bus): LineRuntime {
    return this.lines.find((rt) => rt.line === bus.line)!;
  }

  /** The bus stopped: at its stop (bay or lane), or back at the depot. */
  private arrived(bus: Bus): void {
    if (bus.status === 'to_depot') {
      if (bus.vehicle.maneuver === 'parked' && this.driveIntoYard(bus.vehicle)) {
        this.traffic.removeVehicle(bus.vehicle);
        this.buses.splice(this.buses.indexOf(bus), 1);
      }
      return;
    }
    if (bus.status !== 'driving' && bus.status !== 'to_line') return;
    if (bus.call === 0) {
      bus.status = 'layover';
      bus.departAt = Math.max(this.time + MIN_LAYOVER, bus.plannedDeparture);
    } else {
      bus.status = 'at_stop';
      bus.departAt = this.time + (bus.call === bus.line.turnCall ? FAR_LAYOVER : this.rng.range(...DWELL_RANGE));
    }
  }

  private depart(bus: Bus): void {
    const rt = this.runtime(bus);
    const { calls } = bus.line;
    if (bus.call === 0) {
      bus.plannedDeparture = Math.max(bus.plannedDeparture, this.time) + rt.cycle;
      bus.cyclesLeft--;
      // Last round trip: a fresh bus will take over the next departure.
      if (bus.cyclesLeft === 0 && this.depotPoint) {
        this.pullOuts.push({ line: rt, slot: bus.plannedDeparture, at: bus.plannedDeparture - rt.fromDepot - PULL_OUT_MARGIN });
      }
    }
    const last = bus.call === calls.length - 1;
    if (last && bus.cyclesLeft <= 0 && this.depotPoint && this.traffic.sendTo(bus.vehicle, this.depotPoint, false)) {
      bus.status = 'to_depot';
      bus.vehicle.driver.speedFactor = 0.85;
      return;
    }
    const next = (bus.call + 1) % calls.length;
    const plan = this.planBetween(rt.lanes, rt.connectors, calls[bus.call].step, calls[next].step, rt.points[bus.call].s, rt.points[next].s);
    bus.call = next;
    bus.status = 'driving';
    this.traffic.sendAlong(bus.vehicle, plan, rt.points[next], !this.currentStop(bus).bay);
  }

  /**
   * A bus leaves the depot for the home terminus: it drives out of the yard
   * first when there is one. False while it has to wait.
   */
  private pullOut(p: PullOut): boolean {
    if (this.kerbBlocked()) return false;
    const yard = this.yardLayout;
    if (yard) {
      if (this.yard.some((y) => y.path) || this.returningNearby()) return false;
      const parked = this.yard.filter((y) => !y.path);
      const yb = parked.find((y) => y.color === p.line.line.color) ?? parked[0];
      if (yb) {
        yb.color = p.line.line.color;
        yb.pullOut = p;
        this.setYardPath(yb, this.exitPath(yb.stall));
        return true;
      }
    }
    return this.enterService(p);
  }

  /** The kerb spot in front of the depot is taken. */
  private kerbBlocked(): boolean {
    const at = this.depotPoint!;
    return this.traffic.vehicles.some(
      (v) => v.segment === at.segment && v.s > at.s - BUS_LENGTH - 3 && v.s - v.length < at.s + 3,
    );
  }

  private returningNearby(): boolean {
    const gate = this.kerbWorld(0);
    return this.buses.some(
      (b) => b.status === 'to_depot' && distance({ x: b.vehicle.pose.x, z: b.vehicle.pose.z }, gate) < RETURNING_RANGE,
    );
  }

  /** The bus appears at the depot kerb (parked) and heads for its line. */
  private enterService(p: PullOut): boolean {
    const at = this.depotPoint!;
    const bus = this.spawn(p.line, at, true);
    bus.status = 'to_line';
    bus.call = 0;
    bus.plannedDeparture = p.slot;
    bus.cyclesLeft = SHIFT_CYCLES;
    const stop = this.currentStop(bus);
    if (!this.traffic.sendTo(bus.vehicle, p.line.points[0], false, !stop.bay)) {
      this.traffic.removeVehicle(bus.vehicle);
      this.buses.splice(this.buses.indexOf(bus), 1);
      return true;
    }
    bus.vehicle.driver.speedFactor = 0.85;
    return true;
  }

  // -------------------------------------------------------------------------
  // Depot yard
  // -------------------------------------------------------------------------

  private fillYard(): void {
    const yard = this.yardLayout;
    if (!yard || this.lines.length === 0) return;
    const count = Math.round(yard.stalls.length * YARD_FILL);
    for (let i = 0; i < count; i++) {
      // Spread over the row: every other stall.
      const stall = Math.min(yard.stalls.length - 1, Math.round((i * yard.stalls.length) / count));
      if (this.yard.some((y) => y.stall === stall)) continue;
      const pose = this.stallPose(stall);
      this.yard.push({
        model: 'bus', color: this.lines[i % this.lines.length].line.color, sirens: false, stall,
        path: null, pathLength: 0, s: 0, v: 0, holdAt: Infinity, pullOut: null, pose, prevPose: { ...pose },
      });
    }
  }

  private stallPose(stall: number): Pose {
    const yard = this.yardLayout!;
    const c = yard.stalls[stall].center;
    return { x: c.x, z: c.z, yaw: yard.yaw };
  }

  /** Point on the kerb line in front of the depot, `along` metres past the parked bus's front (direction of travel). */
  private kerbWorld(along: number, lateral = LANE_WIDTH / 2 + parkingOffset(BUS_WIDTH)): Vec2 {
    const bay = this.depot!.bay!;
    const edge = this.city.roads.edges[bay.edgeId];
    const s = bay.s + bay.side * (BUS_LENGTH / 2 + along);
    const sample = samplePolyline(edge.points, s);
    return add(sample.point, scale(rightOf(sample.dir), bay.side * lateral));
  }

  /** Stall → front aisle → gate → kerb spot (front bumper path). */
  private exitPath(stall: number): Vec2[] {
    const yard = this.yardLayout!;
    const { x } = yard.stalls[stall];
    const gate = this.kerbWorld(-(BUS_LENGTH + 14), STREET_CLEARANCE + 3);
    const gx = clampAbs(yard.toLocal(gate).x, yard.xSide);
    return [
      yard.toWorld(x, yard.zStall - BUS_LENGTH / 2),
      yard.toWorld(x, yard.zStall + BUS_LENGTH / 2),
      yard.toWorld(x, yard.zFront),
      yard.toWorld(gx, yard.zFront),
      gate,
      this.kerbWorld(-(BUS_LENGTH + 6)),
      this.kerbWorld(0),
    ];
  }

  /** Kerb spot → gate → front aisle → side lane → back aisle → into the stall. */
  private entryPath(stall: number): Vec2[] {
    const yard = this.yardLayout!;
    const { x } = yard.stalls[stall];
    const gate = this.kerbWorld(12, STREET_CLEARANCE + 3);
    const gx = clampAbs(yard.toLocal(gate).x, yard.xSide);
    // Go round on the far side from the exit, so a bus waiting to leave is not in the way.
    const exitX = yard.toLocal(this.kerbWorld(-(BUS_LENGTH + 14), STREET_CLEARANCE + 3)).x;
    const side = Math.sign(gx - exitX) || 1;
    return [
      this.kerbWorld(-BUS_LENGTH),
      this.kerbWorld(0),
      this.kerbWorld(5),
      gate,
      yard.toWorld(gx, yard.zFront),
      yard.toWorld(side * yard.xSide, yard.zFront),
      yard.toWorld(side * yard.xSide, yard.zBack),
      yard.toWorld(x, yard.zBack),
      yard.toWorld(x, yard.zStall - BUS_LENGTH / 2),
      yard.toWorld(x, yard.zStall + BUS_LENGTH / 2),
    ];
  }

  private setYardPath(yb: YardBus, path: Vec2[]): void {
    yb.path = path;
    yb.pathLength = path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);
    yb.s = distance(path[0], path[1]); // front bumper at the second point, rear at the first
    yb.v = 0;
    // Leaving: wait at the gate (4th point) while the kerb is taken.
    yb.holdAt = yb.pullOut ? path.slice(1, 5).reduce((sum, p, i) => sum + distance(path[i], p), 0) : Infinity;
  }

  /** A bus parked at the depot kerb drives into a free stall. False while it has to wait. */
  private driveIntoYard(vehicle: Vehicle): boolean {
    const yard = this.yardLayout;
    if (!yard) return true; // no yard: the bus just goes inside
    // Only a bus waiting at the gate to leave may be in the yard meanwhile.
    if (this.yard.some((y) => y.path && !(y.pullOut && y.s >= y.holdAt - 0.1))) return false;
    const free = yard.stalls.map((_, i) => i).filter((i) => !this.yard.some((y) => y.stall === i));
    if (free.length === 0) return true;
    const stall = free[Math.floor(free.length / 2)];
    const pose = { ...vehicle.pose };
    const yb: YardBus = {
      model: 'bus', color: vehicle.color, sirens: false, stall,
      path: null, pathLength: 0, s: 0, v: 0, holdAt: Infinity, pullOut: null, pose, prevPose: { ...pose },
    };
    this.setYardPath(yb, this.entryPath(stall));
    this.yard.push(yb);
    return true;
  }

  private moveYardBuses(dt: number): void {
    for (const yb of [...this.yard]) {
      yb.prevPose = yb.pose;
      if (!yb.path) continue;
      const remaining = yb.pathLength - yb.s;
      let limit = remaining;
      if (yb.pullOut && this.kerbBlocked()) limit = Math.min(limit, yb.holdAt - yb.s);
      yb.v = Math.min(YARD_SPEED, yb.v + YARD_ACCEL * dt, Math.sqrt(2 * YARD_ACCEL * Math.max(0, limit)));
      yb.s = Math.min(yb.s + yb.v * dt, yb.s + Math.max(0, limit));
      yb.pose = yardPose(yb.path, yb.s);
      if (yb.s < yb.pathLength - 0.05) continue;
      if (yb.pullOut) {
        // Out at the kerb: from here on it is road traffic.
        this.yard.splice(this.yard.indexOf(yb), 1);
        this.enterService(yb.pullOut);
      } else {
        yb.path = null;
        yb.pose = this.stallPose(yb.stall);
      }
    }
  }

  /** Estimated seconds until `bus` reaches call `target` of its line. */
  private eta(rt: LineRuntime, bus: Bus, target: number): number {
    const { offsets, cycle } = rt;
    if (bus.status === 'to_line') return Math.max(0, bus.plannedDeparture - this.time) + offsets[target];
    const standing = bus.status === 'at_stop' || bus.status === 'layover';
    if (standing && bus.call === target) return 0;
    // Time until the bus is at (and leaving) its current call, then the timetable onwards.
    const legBefore = bus.call === 0 ? cycle - offsets[offsets.length - 1] : offsets[bus.call] - offsets[bus.call - 1];
    const base = standing ? Math.max(0, bus.departAt - this.time) : legBefore / 2;
    let ahead = offsets[target] - offsets[bus.call];
    if (ahead < 0 || (ahead === 0 && standing)) ahead += cycle;
    return base + ahead;
  }
}

function clampAbs(x: number, max: number): number {
  return Math.max(-max, Math.min(max, x));
}

/** Pose of a bus whose front bumper is at `s` along `path` (rear follows the same path). */
function yardPose(path: Vec2[], s: number): Pose {
  const front = samplePolyline(path, s).point;
  const rearS = s - BUS_LENGTH;
  let rear: Vec2;
  if (rearS >= 0) rear = samplePolyline(path, rearS).point;
  else rear = add(path[0], scale(normalize(sub(path[0], path[1])), -rearS));
  const dx = front.x - rear.x;
  const dz = front.z - rear.z;
  return { x: (front.x + rear.x) / 2, z: (front.z + rear.z) / 2, yaw: Math.atan2(dx, dz) };
}
