import { samplePolyline } from '../math/geometry';
import { type Rng, createRng } from '../math/rng';
import { type Vec2, add, dot, normalize, rightOf, scale, sub, vec2 } from '../math/vec2';
import { CAR_GAP, type RailSystem, type Train } from '../rail/railSystem';
import type { LaneGraph } from '../traffic/laneGraph';
import { TRUCK, VEHICLE_DIMENSIONS, type Vehicle } from '../traffic/vehicle';
import type { RoutePoint } from '../routing/router';
import type { Track } from '../world/rail';
import type { Building, City } from '../world/types';

/**
 * Containers and the gantry cranes that move them (v3 F2).
 *
 * Two yards: the Freight Hub, where long-distance trains swap containers with the local
 * shuttle (through a buffer stack when the shuttle is away), and the Dockside Freight
 * Terminal, where the shuttle's containers go into the stacks and others come out.
 * Containers are 40 ft, one per wagon; each knows where it came from: `outside` (brought by
 * a long-distance train) or `city` (loaded in town, going out).
 *
 * Each crane works in its yard's straight frame: `u` along the track, `w` across it (away
 * from the yard's building), height up. It does one move at a time: lift, travel, lower,
 * grab, lift, travel, lower, release. Trains at a yard wait until the crane has nothing more
 * to do for them (`RailSystem.departureHold`).
 */

export type ContainerOrigin = 'outside' | 'city';

export const CONTAINER_LENGTH = 12.2;
export const CONTAINER_WIDTH = 2.44;
export const CONTAINER_HEIGHT = 2.6;
/** Bottom of a container standing on a wagon (deck top + the rendered rail height). */
export const WAGON_DECK = 1.37;
const MAX_TIERS = 3;

const OUTSIDE_COLORS = [0x2b5ca8, 0x2e7d5b, 0x5d6d7e, 0x1f6f8b, 0x3f51b5, 0x00897b];
const CITY_COLORS = [0xc0392b, 0xe67e22, 0xf1c40f, 0xd35400, 0xa93226];

/** With more outside containers than this waiting in the stacks, the next long-distance train comes with empty wagons for them. */
const OUTSIDE_BACKLOG_LIMIT = 8;
const HUB_START_CITY = 2;
const DOCKSIDE_START_CITY = 6;
/** Outside containers waiting at Dockside at the start, so the lorries have work at once. */
const DOCKSIDE_START_OUTSIDE = 4;
/** Bottom of a container on a lorry's chassis (deck top + the road surface), m. */
export const CHASSIS_DECK = 1.46;
/** Lorry spots on the yard lane: the rear lorry's tail this far into the lane, and the gap between the two, m. */
const REAR_SPOT_TAIL = 3;
const SPOT_GAP = 4;
/** Trailer centre behind a lorry's front bumper (kingpin − overhang + half the trailer), m. */
const TRAILER_CENTRE = TRUCK.kingpin - TRUCK.trailerOverhang + VEHICLE_DIMENSIONS.trailer.length / 2;

// Crane kinematics (tuned for 20–30 s per move).
const GANTRY_SPEED = 3;
const TROLLEY_SPEED = 2;
const HOIST_SPEED = 2;
const LATCH_TIME = 1.5;
/** Spreader clearance above the highest thing it passes over, m. */
const LIFT_CLEARANCE = 0.8;
/** Typical duration of one crane move, for forecasting, s. */
const MOVE_ESTIMATE = 24;
/** Parked spreader height, m. */
const REST_HEIGHT = 11;

export interface Container {
  id: number;
  origin: ContainerOrigin;
  color: number;
  /** Long-distance containers to be unloaded at the hub. */
  forCity: boolean;
  /**
   * Leaving the city (by shuttle and long-distance train): loaded in town, or brought back
   * by a container lorry after unloading. The colour stays that of its origin.
   */
  outbound: boolean;
}

/** A container lorry working for the Dockside yard (driven by the logistics system). */
export interface YardLorry {
  vehicle: Vehicle;
  container: Container | null;
  /** Spot it stands at on the yard lane (0 = front, under the crane; 1 = rear), null when not standing there. */
  at: number | null;
}

/** Somewhere a container can be picked up or put down. */
export type Spot =
  | { kind: 'wagon'; train: Train; car: number }
  | { kind: 'stack'; index: number }
  | { kind: 'lorry'; lorry: YardLorry };

export interface CraneTask {
  container: Container;
  from: Spot;
  to: Spot;
}

export type CranePhase = 'idle' | 'lift' | 'travel' | 'lower' | 'latch';

export interface Crane {
  /** Gantry position along the rails, trolley position across, spreader height (bottom). */
  u: number;
  w: number;
  h: number;
  holding: Container | null;
  task: CraneTask | null;
  phase: CranePhase;
  timer: number;
  /** Height the current lift goes to. */
  liftTo: number;
  moves: number;
}

export interface StackSlot {
  u: number;
  w: number;
  tiers: Container[];
}

export type YardKind = 'hub' | 'dockside';

export interface Yard {
  kind: YardKind;
  name: string;
  /** Frame: world = origin + u·uAxis + w·wAxis. */
  origin: Vec2;
  uAxis: Vec2;
  wAxis: Vec2;
  /** Crane rails: travel range along u, and the legs' w positions. */
  uRange: [number, number];
  legs: [number, number];
  /** Gantry half-length along u (the legs stand this far either side of the gantry's centre). */
  halfSpan: number;
  crane: Crane;
  stacks: StackSlot[];
}

export class ContainerSystem {
  readonly yards: Yard[] = [];
  /** Running totals: crane moves, outside containers set down at Dockside, city containers taken away by train, and containers created / gone into the tunnel (for conservation checks). */
  readonly stats = { craneMoves: 0, delivered: 0, shipped: 0, created: 0, left: 0 };
  /** Container lorries serving Dockside (registered by the logistics system). */
  readonly lorries: YardLorry[] = [];
  /**
   * Where a lorry stops on the yard lane (front bumper), front spot first; empty without a
   * yard road.
   */
  readonly lorrySpots: RoutePoint[] = [];
  /** Containers on wagons, per train (index = car; null for locos and empty wagons). */
  private readonly loads = new Map<Train, (Container | null)[]>();
  private readonly rng: Rng;
  private nextId = 1;
  private readonly hub: Yard | null = null;
  private readonly dockside: Yard | null = null;

  constructor(
    city: City,
    private readonly rail: RailSystem,
    graph: LaneGraph,
  ) {
    this.rng = createRng(city.seed ^ 0x51ed270b);
    const freight = city.rail.tracks.find((t) => t.kind === 'freight');
    const hubBuilding = city.buildings.find((b) => b.kind === 'freight_hub');
    const terminal = city.buildings.find((b) => b.kind === 'freight_terminal');
    if (!freight || !hubBuilding || !terminal || !rail.longhaul) return;
    const yardLane = graph.lanes.find((l) => l.yard) ?? null;
    if (yardLane) {
      const lorry = VEHICLE_DIMENSIONS.truck.length;
      const rear = REAR_SPOT_TAIL + lorry;
      this.lorrySpots.push({ segment: yardLane.id, s: rear + SPOT_GAP + lorry }, { segment: yardLane.id, s: rear });
    }
    this.hub = this.planHub(freight, rail.longhaul.track, rail.longhaul.length, rail.longhaul.cars.length, hubBuilding);
    this.dockside = this.planDockside(freight, terminal, yardLane?.points ?? null);
    this.yards.push(this.hub, this.dockside);
    for (let i = 0; i < HUB_START_CITY; i++) this.putOnStack(this.hub, this.create('city'));
    for (let i = 0; i < DOCKSIDE_START_CITY; i++) this.putOnStack(this.dockside, this.create('city'));
    if (yardLane) for (let i = 0; i < DOCKSIDE_START_OUTSIDE; i++) this.putOnStack(this.dockside, this.create('outside'));
    rail.departureHold = (train) => this.holdEstimate(train);
  }

  // -------------------------------------------------------------------------
  // Container lorries (driven by the logistics system)
  // -------------------------------------------------------------------------

  registerLorry(vehicle: Vehicle): YardLorry {
    const lorry: YardLorry = { vehicle, container: null, at: null };
    this.lorries.push(lorry);
    return lorry;
  }

  /** The crane is about to work on, or is working on, this lorry: it must not move. */
  craneBusyWith(lorry: YardLorry): boolean {
    const t = this.dockside?.crane.task;
    return !!t && ((t.from.kind === 'lorry' && t.from.lorry === lorry) || (t.to.kind === 'lorry' && t.to.lorry === lorry));
  }

  /** Loaded with a container for town and the crane done with it: it may leave. */
  lorryLoaded(lorry: YardLorry): boolean {
    return !!lorry.container && !lorry.container.outbound && !this.craneBusyWith(lorry);
  }

  /** Unloaded at a warehouse / shop: the same container goes back, now for shipping out. */
  lorryUnloaded(lorry: YardLorry): void {
    if (lorry.container) lorry.container.outbound = true;
  }

  /** Trains that carry containers. */
  trains(): Train[] {
    return [...this.loads.keys()];
  }

  /** Containers on a train's cars (index = car), or undefined for trains without any. */
  loadOf(train: Train): readonly (Container | null)[] | undefined {
    return this.loads.get(train);
  }

  /** Where a yard-frame point is on the map. */
  toWorld(yard: Yard, u: number, w: number): Vec2 {
    return add(yard.origin, add(scale(yard.uAxis, u), scale(yard.wAxis, w)));
  }

  /** Yard-frame coordinates of a world point. */
  toYard(yard: Yard, p: Vec2): { u: number; w: number } {
    const d = sub(p, yard.origin);
    return { u: dot(d, yard.uAxis), w: dot(d, yard.wAxis) };
  }

  /** Centre of a car on the map and its heading. */
  carPose(train: Train, car: number, s = train.s): { x: number; z: number; yaw: number } {
    let front = s;
    for (let i = 0; i < car; i++) front -= train.cars[i].length + CAR_GAP;
    const rear = front - train.cars[car].length;
    const pts = train.track.points;
    const a = samplePolyline(pts, Math.max(0, front - 2.6)).point;
    const b = samplePolyline(pts, Math.max(0, rear + 2.6)).point;
    const mid = samplePolyline(pts, Math.max(0, (front + rear) / 2)).point;
    return { x: mid.x, z: mid.z, yaw: Math.atan2(a.x - b.x, a.z - b.z) };
  }

  step(dt: number): void {
    this.syncTrains();
    for (const yard of this.yards) this.stepCrane(yard, dt);
  }

  /** Every container that exists, for tests (conservation) and counts. */
  all(): Container[] {
    const list: Container[] = [];
    for (const load of this.loads.values()) for (const c of load) if (c) list.push(c);
    for (const yard of this.yards) {
      for (const s of yard.stacks) list.push(...s.tiers);
      if (yard.crane.holding) list.push(yard.crane.holding);
    }
    for (const l of this.lorries) {
      if (l.container) list.push(l.container);
    }
    return list;
  }

  // -------------------------------------------------------------------------
  // Trains coming and going
  // -------------------------------------------------------------------------

  private syncTrains(): void {
    for (const train of this.rail.trains) {
      if (train.kind === 'passenger' || this.loads.has(train)) continue;
      const load: (Container | null)[] = train.cars.map(() => null);
      const wagons = train.cars.map((c, i) => (c.model === 'container_wagon' ? i : -1)).filter((i) => i >= 0);
      if (train.kind === 'freight') {
        // The shuttle starts at the hub with containers for Dockside.
        for (const i of wagons) load[i] = this.create('outside');
      } else {
        // Through containers stay on; some are for the city. With too many outside
        // containers waiting in town, those wagons come empty and take some back.
        const forCity = this.rng.chance(0.5) ? [wagons[1], wagons[2]] : [wagons[0], wagons[wagons.length - 1]];
        const backlog = this.waitingOutside() > OUTSIDE_BACKLOG_LIMIT;
        for (const i of wagons) {
          if (!forCity.includes(i)) load[i] = this.create('outside');
          else if (!backlog) {
            const c = this.create('outside');
            c.forCity = true;
            load[i] = c;
          }
        }
      }
      this.loads.set(train, load);
    }
    for (const train of [...this.loads.keys()]) {
      if (this.rail.trains.includes(train)) continue;
      // Gone into the tunnel with its containers.
      const gone = this.loads.get(train)!.filter((c) => c !== null);
      this.stats.shipped += gone.filter((c) => c!.outbound).length;
      this.stats.left += gone.length;
      this.loads.delete(train);
    }
  }

  private waitingOutside(): number {
    return this.yards.reduce((n, y) => n + y.stacks.reduce((m, s) => m + s.tiers.filter((c) => !c.outbound).length, 0), 0);
  }

  private create(origin: ContainerOrigin): Container {
    const color = this.rng.pick(origin === 'outside' ? OUTSIDE_COLORS : CITY_COLORS);
    this.stats.created++;
    return { id: this.nextId++, origin, color, forCity: false, outbound: origin === 'city' };
  }

  // -------------------------------------------------------------------------
  // Yard layout
  // -------------------------------------------------------------------------

  /** Frame along a track at `s`, with w pointing away from the building. */
  private frame(track: Track, s: number, building: Building): { origin: Vec2; uAxis: Vec2; wAxis: Vec2 } {
    const { point, dir } = samplePolyline(track.points, s);
    const uAxis = normalize(dir);
    let wAxis = rightOf(uAxis);
    if (dot(sub(building.footprint.center, point), wAxis) > 0) wAxis = scale(wAxis, -1);
    return { origin: point, uAxis, wAxis };
  }

  /** Track coordinate of each car's centre for a train standing with its head at `head` (travelling towards higher s). */
  private static carCentres(cars: { length: number }[], head: number): number[] {
    const centres: number[] = [];
    let front = head;
    for (const car of cars) {
      centres.push(front - car.length / 2);
      front -= car.length + CAR_GAP;
    }
    return centres;
  }

  /**
   * Hub: the crane spans the shuttle's track and the siding, its legs between the passenger
   * and shuttle tracks and beyond two rows of stacks south of the siding. Stack bays line up
   * with the long-distance train's wagons.
   */
  private planHub(freight: Track, siding: Track, trainLength: number, carCount: number, building: Building): Yard {
    const f = this.frame(freight, 30, building);
    const yard = this.emptyYard('hub', 'Freight Hub', f);
    const cars = Array.from({ length: carCount }, (_, i) => ({ length: i === 0 || i === carCount - 1 ? 12 : 12.5 }));
    const centres = ContainerSystem.carCentres(cars, siding.length - 3).slice(1, -1);
    const sidingW = this.toYard(yard, samplePolyline(siding.points, siding.length - trainLength / 2).point).w;
    const rows = [sidingW + 1.45 + 0.6 + CONTAINER_WIDTH / 2, sidingW + 1.45 + 0.6 + CONTAINER_WIDTH * 1.5 + 0.6];
    for (const s of centres) {
      const u = this.toYard(yard, samplePolyline(siding.points, s).point).u;
      for (const w of rows) yard.stacks.push({ u, w, tiers: [] });
    }
    // Shuttle wagons at the hub (head at the buffer, s = 3, standing towards s > 3).
    const shuttle = ContainerSystem.carCentres([{ length: 12 }, { length: 12.5 }, { length: 12.5 }, { length: 12 }], 3 + 52).slice(1, -1);
    const us = [...yard.stacks.map((s) => s.u), ...shuttle.map((s) => this.toYard(yard, samplePolyline(freight.points, s).point).u)];
    yard.uRange = [Math.min(...us) - 1, Math.max(...us) + 1];
    yard.legs = [-2.25, rows[1] + CONTAINER_WIDTH / 2 + 1.2];
    this.parkCrane(yard);
    return yard;
  }

  /**
   * Dockside: three rows of stacks beside the track, bays along the standing shuttle. With a
   * yard road the crane is wider: its far legs stand beyond the road and it reaches both lorry
   * spots.
   */
  private planDockside(freight: Track, building: Building, yardLane: Vec2[] | null): Yard {
    const end = freight.length - 3;
    const f = this.frame(freight, end - 26, building);
    const yard = this.emptyYard('dockside', 'Dockside Freight Terminal', f);
    const wagons = ContainerSystem.carCentres([{ length: 12 }, { length: 12.5 }, { length: 12.5 }, { length: 12 }], end).slice(1, -1);
    const mid = (this.toYard(yard, samplePolyline(freight.points, wagons[0]).point).u + this.toYard(yard, samplePolyline(freight.points, wagons[1]).point).u) / 2;
    const rows = [0, 1, 2].map((k) => 1.45 + 0.6 + CONTAINER_WIDTH / 2 + k * (CONTAINER_WIDTH + 0.6));
    for (const k of [-1.5, -0.5, 0.5, 1.5]) for (const w of rows) yard.stacks.push({ u: mid + k * (CONTAINER_LENGTH + 1), w, tiers: [] });
    const us = yard.stacks.map((s) => s.u);
    let farLeg = rows[2] + CONTAINER_WIDTH / 2 + 1.2;
    if (yardLane) {
      // Trailer centres of lorries standing at the spots.
      for (const spot of this.lorrySpots) {
        const p = samplePolyline(yardLane, spot.s - TRAILER_CENTRE).point;
        const { u, w } = this.toYard(yard, p);
        us.push(u);
        farLeg = Math.max(farLeg, w + VEHICLE_DIMENSIONS.truck.width / 2 + 2.2);
      }
    }
    yard.uRange = [Math.min(...us) - 1, Math.max(...us) + 1];
    yard.legs = [-2.4, farLeg];
    this.parkCrane(yard);
    return yard;
  }

  private emptyYard(kind: YardKind, name: string, f: { origin: Vec2; uAxis: Vec2; wAxis: Vec2 }): Yard {
    return {
      kind,
      name,
      ...f,
      uRange: [0, 0],
      legs: [0, 0],
      halfSpan: 4,
      crane: { u: 0, w: 0, h: REST_HEIGHT, holding: null, task: null, phase: 'idle', timer: 0, liftTo: REST_HEIGHT, moves: 0 },
      stacks: [],
    };
  }

  private parkCrane(yard: Yard): void {
    yard.crane.u = (yard.uRange[0] + yard.uRange[1]) / 2;
    yard.crane.w = 0;
  }

  /** Puts a container on the best stack for it (same origin on top, else an empty bay). */
  private putOnStack(yard: Yard, c: Container): boolean {
    const slot = this.stackFor(yard, c);
    if (slot === null) return false;
    yard.stacks[slot].tiers.push(c);
    return true;
  }

  // -------------------------------------------------------------------------
  // Spots
  // -------------------------------------------------------------------------

  /** A train of this kind standing at the yard (the crane may work on it), or null. */
  dockedTrain(yard: Yard, kind: 'freight' | 'longhaul'): Train | null {
    return this.docked(yard, kind);
  }

  /** A train standing at this yard (crane may work on it). */
  private docked(yard: Yard, kind: Train['kind']): Train | null {
    return this.rail.trains.find((t) => t.kind === kind && t.v === 0 && t.stoppedAt === yard.name && this.loads.has(t)) ?? null;
  }

  private stackFor(yard: Yard, c: Container): number | null {
    let best: number | null = null;
    let bestScore = -Infinity;
    yard.stacks.forEach((s, i) => {
      if (s.tiers.length >= MAX_TIERS || this.reserved(yard, { kind: 'stack', index: i })) return;
      const top = s.tiers[s.tiers.length - 1];
      // Same direction (in / out) on top first (nothing gets buried), then empty bays, then anything.
      const score = top ? (top.outbound === c.outbound ? 10 + s.tiers.length : 0) : 5;
      const near = -Math.abs(s.u - yard.crane.u) / 100;
      if (score + near > bestScore) {
        bestScore = score + near;
        best = i;
      }
    });
    return best;
  }

  /** A stack whose top container matches, or null. */
  private stackWith(yard: Yard, match: (c: Container) => boolean): number | null {
    let best: number | null = null;
    yard.stacks.forEach((s, i) => {
      const top = s.tiers[s.tiers.length - 1];
      if (!top || !match(top) || this.reserved(yard, { kind: 'stack', index: i })) return;
      if (best === null || s.tiers.length > yard.stacks[best].tiers.length) best = i;
    });
    return best;
  }

  private reserved(yard: Yard, spot: Spot): boolean {
    const t = yard.crane.task;
    return !!t && (sameSpot(t.from, spot) || sameSpot(t.to, spot));
  }

  private wagonsOf(train: Train | null, match: (c: Container | null) => boolean): Spot[] {
    if (!train) return [];
    const load = this.loads.get(train)!;
    const spots: Spot[] = [];
    load.forEach((c, car) => {
      if (train.cars[car].model === 'container_wagon' && match(c)) spots.push({ kind: 'wagon', train, car });
    });
    return spots;
  }

  private containerAt(yard: Yard, spot: Spot): Container | null {
    if (spot.kind === 'wagon') return this.loads.get(spot.train)?.[spot.car] ?? null;
    if (spot.kind === 'lorry') return spot.lorry.container;
    const tiers = yard.stacks[spot.index].tiers;
    return tiers[tiers.length - 1] ?? null;
  }

  /** Lorries standing at a yard spot, front spot first. */
  private standingLorries(): YardLorry[] {
    return this.lorries.filter((l) => l.at !== null && l.vehicle.v < 0.05).sort((a, b) => a.at! - b.at!);
  }

  /** Yard-frame position of a spot and the height of the container bottom there (top container, or where a new one goes). */
  private spotPose(yard: Yard, spot: Spot, placing: boolean): { u: number; w: number; bottom: number } {
    if (spot.kind === 'lorry') {
      const t = spot.lorry.vehicle.trailer ?? spot.lorry.vehicle.pose;
      const { u, w } = this.toYard(yard, vec2(t.x, t.z));
      return { u, w, bottom: CHASSIS_DECK };
    }
    if (spot.kind === 'wagon') {
      const p = this.carPose(spot.train, spot.car);
      const { u, w } = this.toYard(yard, vec2(p.x, p.z));
      return { u, w, bottom: WAGON_DECK };
    }
    const s = yard.stacks[spot.index];
    const n = s.tiers.length - (placing ? 0 : 1);
    return { u: s.u, w: s.w, bottom: n * CONTAINER_HEIGHT };
  }

  // -------------------------------------------------------------------------
  // What to do next
  // -------------------------------------------------------------------------

  private nextTask(yard: Yard): CraneTask | null {
    const moves = yard.kind === 'hub' ? this.hubMoves(yard) : this.docksideMoves(yard);
    for (const [from, to] of moves) {
      if (!from || !to) continue;
      const container = this.containerAt(yard, from);
      if (container) return { container, from, to };
    }
    return null;
  }

  /** Candidate moves in priority order (from, to); the first complete one is taken. */
  private hubMoves(yard: Yard): [Spot | null, Spot | null][] {
    const lh = this.docked(yard, 'longhaul');
    const sh = this.docked(yard, 'freight');
    const lhForCity = this.wagonsOf(lh, (c) => !!c?.forCity)[0] ?? null;
    const lhFree = this.wagonsOf(lh, (c) => c === null)[0] ?? null;
    const shCity = this.wagonsOf(sh, (c) => !!c?.outbound)[0] ?? null;
    const shFree = this.wagonsOf(sh, (c) => c === null)[0] ?? null;
    const stackTo = (from: Spot | null) => {
      const c = from && this.containerAt(yard, from);
      const i = c ? this.stackFor(yard, c) : null;
      return i === null ? null : ({ kind: 'stack', index: i } as Spot);
    };
    const stackFrom = (match: (c: Container) => boolean) => {
      const i = this.stackWith(yard, match);
      return i === null ? null : ({ kind: 'stack', index: i } as Spot);
    };
    const backlog = this.waitingOutside() > OUTSIDE_BACKLOG_LIMIT;
    return [
      [lhForCity, shFree],
      [shCity, lhFree],
      [lhForCity, stackTo(lhForCity)],
      [shCity, stackTo(shCity)],
      [lh ? stackFrom((c) => c.outbound) : null, lhFree],
      // Too many outside containers in town: send some back out.
      [lh && backlog ? stackFrom((c) => !c.outbound) : null, lhFree],
      [sh ? stackFrom((c) => !c.outbound) : null, shFree],
    ];
  }

  /**
   * Dockside: the shuttle's incoming containers into the stacks and outbound ones onto it;
   * lorries hand in returned containers and get one for town (front spot first).
   */
  private docksideMoves(yard: Yard): [Spot | null, Spot | null][] {
    const sh = this.docked(yard, 'freight');
    const stackTo = (from: Spot | null): Spot | null => {
      const c = from && this.containerAt(yard, from);
      const i = c ? this.stackFor(yard, c) : null;
      return i === null ? null : { kind: 'stack', index: i };
    };
    const stackFrom = (match: (c: Container) => boolean): Spot | null => {
      const i = this.stackWith(yard, match);
      return i === null ? null : { kind: 'stack', index: i };
    };
    const shIn = this.wagonsOf(sh, (c) => !!c && !c.outbound)[0] ?? null;
    const shFree = this.wagonsOf(sh, (c) => c === null)[0] ?? null;
    const lorries = this.standingLorries();
    const returned = lorries.find((l) => l.container?.outbound);
    const empty = lorries.find((l) => !l.container);
    const lorrySpot = (l: YardLorry | undefined): Spot | null => (l ? { kind: 'lorry', lorry: l } : null);
    return [
      [shIn, stackTo(shIn)],
      [lorrySpot(returned), stackTo(lorrySpot(returned))],
      [sh ? stackFrom((c) => c.outbound) : null, shFree],
      [empty ? stackFrom((c) => !c.outbound) : null, lorrySpot(empty)],
    ];
  }

  /**
   * Seconds the crane still needs for a train standing at a yard (0: it may go). Used as the
   * departure gate and by the crossing forecast.
   */
  holdEstimate(train: Train): number {
    if (train.kind === 'passenger' || !this.loads.has(train)) return 0;
    const yard = this.yards.find((y) => y.name === train.stoppedAt);
    if (!yard || train.v !== 0) return 0;
    const t = yard.crane.task;
    const onTrain = (s: Spot) => s.kind === 'wagon' && s.train === train;
    const busy = !!t && (onTrain(t.from) || onTrain(t.to));
    // The gate: a move for this train that the crane could start now.
    const pending = (yard.kind === 'hub' ? this.hubMoves(yard) : this.docksideMoves(yard)).some(
      ([from, to]) => from && to && (onTrain(from) || onTrain(to)) && this.containerAt(yard, from),
    );
    if (!busy && !pending) return 0;
    return this.taskRemaining(yard) + this.movesLeft(yard, train) * MOVE_ESTIMATE;
  }

  /**
   * Moves still to do for a standing train after the crane's current task: containers to
   * take off, then free wagons to fill (as far as the yard has containers for it).
   */
  private movesLeft(yard: Yard, train: Train): number {
    const load = this.loads.get(train)!;
    const wagons = load.filter((_, i) => train.cars[i].model === 'container_wagon');
    const t = yard.crane.task;
    const outgoing = (c: Container | null) => (yard.kind === 'hub' ? (train.kind === 'longhaul' ? !!c?.forCity : !!c?.outbound) : !!c && !c.outbound);
    let off = wagons.filter(outgoing).length;
    let free = wagons.filter((c) => c === null).length;
    if (t && !yard.crane.holding && t.from.kind === 'wagon' && t.from.train === train) off--; // being taken off now
    if (t && t.to.kind === 'wagon' && t.to.train === train) free--; // being filled now
    const onStacks = (outbound: boolean) => yard.stacks.reduce((n, s) => n + s.tiers.filter((c) => c.outbound === outbound).length, 0);
    let supply: number;
    if (yard.kind === 'dockside') supply = onStacks(true) + this.lorries.filter((l) => l.at !== null && l.container?.outbound).length;
    else if (train.kind === 'longhaul') {
      const sh = this.docked(yard, 'freight');
      supply = onStacks(true) + (sh ? this.loads.get(sh)!.filter((c) => c?.outbound).length : 0);
      if (this.waitingOutside() > OUTSIDE_BACKLOG_LIMIT) supply += onStacks(false);
    } else {
      const lh = this.docked(yard, 'longhaul');
      supply = onStacks(false) + (lh ? this.loads.get(lh)!.filter((c) => c?.forCity).length : 0);
    }
    return Math.max(0, off) + Math.min(Math.max(0, free) + Math.max(0, off), supply);
  }

  /** Seconds until the crane's current task is done (0 when idle). */
  private taskRemaining(yard: Yard): number {
    const crane = yard.crane;
    const task = crane.task;
    if (!task) return 0;
    const travel = (u0: number, w0: number, u1: number, w1: number) => Math.max(Math.abs(u1 - u0) / GANTRY_SPEED, Math.abs(w1 - w0) / TROLLEY_SPEED);
    const to = this.spotPose(yard, task.to, true);
    const toReach = to.bottom + CONTAINER_HEIGHT;
    let time = 0;
    let { u, w, h } = crane;
    let up = crane.liftTo;
    if (!crane.holding) {
      const from = this.spotPose(yard, task.from, false);
      const reach = from.bottom + CONTAINER_HEIGHT;
      if (crane.phase === 'lift') time += (up - h) / HOIST_SPEED;
      if (crane.phase === 'lift' || crane.phase === 'travel') time += travel(u, w, from.u, from.w) + (up - reach) / HOIST_SPEED;
      if (crane.phase === 'lower') time += (h - reach) / HOIST_SPEED;
      time += crane.phase === 'latch' ? crane.timer : LATCH_TIME;
      ({ u, w } = from);
      h = reach;
      up = Math.max(h, REST_HEIGHT - 1); // typical lift with a container
    }
    if (crane.phase !== 'latch' || !crane.holding) {
      if (!crane.holding || crane.phase === 'lift') time += Math.max(0, up - h) / HOIST_SPEED;
      if (!crane.holding || crane.phase !== 'lower') time += travel(u, w, to.u, to.w) + Math.max(0, up - toReach) / HOIST_SPEED;
      else time += Math.max(0, h - toReach) / HOIST_SPEED;
      time += LATCH_TIME;
    } else time += crane.timer;
    return time;
  }

  // -------------------------------------------------------------------------
  // Crane motion
  // -------------------------------------------------------------------------

  private stepCrane(yard: Yard, dt: number): void {
    const crane = yard.crane;
    if (!crane.task) {
      crane.task = this.nextTask(yard);
      if (!crane.task) {
        crane.phase = 'idle';
        crane.h = Math.min(REST_HEIGHT, crane.h + HOIST_SPEED * dt);
        return;
      }
      this.startLift(yard);
    }
    const task = crane.task;
    const target = crane.holding ? task.to : task.from;
    const pose = this.spotPose(yard, target, !!crane.holding);
    // Spreader height over the target: on top of the container to grab, or (carrying one) its top once set down.
    const reach = pose.bottom + CONTAINER_HEIGHT;
    switch (crane.phase) {
      case 'lift':
        crane.h = Math.min(crane.liftTo, crane.h + HOIST_SPEED * dt);
        if (crane.h >= crane.liftTo - 1e-6) crane.phase = 'travel';
        break;
      case 'travel': {
        crane.u = approach(crane.u, pose.u, GANTRY_SPEED * dt);
        crane.w = approach(crane.w, pose.w, TROLLEY_SPEED * dt);
        if (crane.u === pose.u && crane.w === pose.w) crane.phase = 'lower';
        break;
      }
      case 'lower':
        crane.u = pose.u;
        crane.w = pose.w;
        crane.h = Math.max(reach, crane.h - HOIST_SPEED * dt);
        if (crane.h <= reach + 1e-6) {
          crane.phase = 'latch';
          crane.timer = LATCH_TIME;
        }
        break;
      case 'latch':
        crane.timer -= dt;
        if (crane.timer > 0) break;
        if (!crane.holding) {
          this.take(yard, task.from);
          crane.holding = task.container;
        } else {
          this.place(yard, task.to, crane.holding);
          crane.holding = null;
          crane.task = null;
          crane.moves++;
          this.stats.craneMoves++;
          crane.phase = 'idle';
          return;
        }
        this.startLift(yard);
        break;
      default:
        break;
    }
  }

  /** Lift high enough to clear everything between here and the target. */
  private startLift(yard: Yard): void {
    const crane = yard.crane;
    const task = crane.task!;
    const target = crane.holding ? task.to : task.from;
    const pose = this.spotPose(yard, target, !!crane.holding);
    const lo = Math.min(crane.u, pose.u) - CONTAINER_LENGTH / 2;
    const hi = Math.max(crane.u, pose.u) + CONTAINER_LENGTH / 2;
    let top = WAGON_DECK + CONTAINER_HEIGHT; // anything on a wagon
    for (const s of yard.stacks) if (s.u > lo && s.u < hi) top = Math.max(top, s.tiers.length * CONTAINER_HEIGHT);
    top = Math.max(top, pose.bottom + CONTAINER_HEIGHT);
    // Spreader bottom; a held container hangs below it.
    crane.liftTo = Math.max(crane.h, top + LIFT_CLEARANCE + (crane.holding ? CONTAINER_HEIGHT : 0));
    crane.phase = 'lift';
  }

  private take(yard: Yard, spot: Spot): void {
    if (spot.kind === 'wagon') this.loads.get(spot.train)![spot.car] = null;
    else if (spot.kind === 'lorry') spot.lorry.container = null;
    else yard.stacks[spot.index].tiers.pop();
  }

  private place(yard: Yard, spot: Spot, c: Container): void {
    c.forCity = false;
    if (spot.kind === 'wagon') {
      this.loads.get(spot.train)![spot.car] = c;
      return;
    }
    if (spot.kind === 'lorry') {
      spot.lorry.container = c;
      return;
    }
    yard.stacks[spot.index].tiers.push(c);
    // (Lorries only bring outbound containers: an incoming one here came off the shuttle.)
    if (yard.kind === 'dockside' && !c.outbound) this.stats.delivered++;
  }
}

function sameSpot(a: Spot, b: Spot): boolean {
  if (a.kind === 'stack') return b.kind === 'stack' && a.index === b.index;
  if (a.kind === 'lorry') return b.kind === 'lorry' && a.lorry === b.lorry;
  return b.kind === 'wagon' && a.train === b.train && a.car === b.car;
}

function approach(x: number, target: number, step: number): number {
  return Math.abs(target - x) <= step ? target : x + Math.sign(target - x) * step;
}
