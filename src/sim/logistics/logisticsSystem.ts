import { kerbPoint } from '../dispatch/curb';
import type { Rng } from '../math/rng';
import { distance } from '../math/vec2';
import type { RoutePoint } from '../routing/router';
import type { TrafficEvent, TrafficSystem } from '../traffic/trafficSystem';
import { VEHICLE_DIMENSIONS, type Vehicle, type VehicleModel, type VehicleRole } from '../traffic/vehicle';
import type { Building, City } from '../world/types';

/**
 * Goods and waste on the move:
 * - articulated lorries: freight hub / factories → warehouses, and
 *   warehouses → supermarkets and the mall (bays long enough for a trailer);
 * - delivery vans: warehouses → shops;
 * - garbage trucks (bigger cities, with a waste depot): leave on a schedule,
 *   stop in the lane at a round of buildings, then unload at the depot.
 * Lorries and vans load at the origin's delivery bay, unload at the
 * customer's, and drive back; at home they go inside (leave the map).
 */

export type LogisticsKind = 'truck' | 'van' | 'garbage';
export type LogisticsStatus = 'loading' | 'delivering' | 'unloading' | 'returning' | 'collecting' | 'to_depot';

export interface LogisticsVehicle {
  id: number;
  name: string;
  kind: LogisticsKind;
  vehicle: Vehicle;
  status: LogisticsStatus;
  /** Where it came from and goes back to (garbage: the waste depot). */
  home: Building;
  /** Customer (null for garbage trucks). */
  customer: Building | null;
  cargo: string;
  /** When standing: sim time it moves on. */
  until: number;
  /** Garbage trucks: buildings still to collect from, in order. */
  round: Building[];
  /** Garbage trucks: the building it is heading to or standing at. */
  bin: Building | null;
  /** Garbage trucks: bins on this round, and how many are emptied. */
  binsTotal: number;
  binsDone: number;
}

const LOADING: Record<'truck' | 'van', [number, number]> = { truck: [25, 45], van: [10, 20] };
const UNLOADING: Record<'truck' | 'van', [number, number]> = { truck: [40, 70], van: [20, 40] };
const COLLECT_TIME: [number, number] = [10, 15];
const DEPOT_UNLOAD = 30;
/** Seconds between garbage truck departures. */
const GARBAGE_INTERVAL = 300;
const FIRST_GARBAGE = 20;
const BINS_PER_ROUND = 8;
/** Bins on one round are at least this far apart, m. */
const BIN_SPACING = 25;
/** Lane room an in-lane stop leaves at either end (for queuing / overtaking), m. */
const BIN_LANE_START = 14;
const BIN_LANE_END = 27;
/** New jobs start at most this often, s. */
const SPAWN_INTERVAL = 1;

const TRUCK_COLORS = [0x2b5ca8, 0xc0392b, 0x2e7d5b, 0xe67e22, 0x6d4c41, 0x37474f, 0x8e44ad];
const VAN_COLORS = [0xd32f2f, 0x1976d2, 0x388e3c, 0xf9a825, 0x6a1b9a, 0x00838f];
const GARBAGE_COLOR = 0xef8a17;
const TRUCK_CARGO = ['furniture', 'electronics', 'building materials', 'food', 'paper', 'machinery', 'textiles', 'beverages'];
const VAN_CARGO = ['parcels', 'groceries', 'clothes', 'books', 'flowers', 'pharmacy goods', 'bakery supplies'];

const MODEL: Record<LogisticsKind, VehicleModel> = { truck: 'truck', van: 'delivery_van', garbage: 'garbage_truck' };
const ROLE: Record<LogisticsKind, VehicleRole> = { truck: 'truck', van: 'delivery', garbage: 'garbage' };
const LABEL: Record<LogisticsKind, string> = { truck: 'Truck', van: 'Van', garbage: 'Garbage truck' };

export class LogisticsSystem {
  readonly fleet: LogisticsVehicle[] = [];
  /** Running totals for the "city pulse" read-out. */
  readonly stats = { deliveries: 0, binsEmptied: 0, garbageRounds: 0 };
  readonly targets: Record<LogisticsKind, number>;
  private readonly freightHub: Building | null;
  private readonly factories: Building[];
  private readonly warehouses: Building[];
  private readonly stores: Building[];
  private readonly shops: Building[];
  private readonly wasteDepot: Building | null;
  private readonly industrial: Building[];
  private readonly frontage: Building[];
  private readonly numbers: Record<LogisticsKind, number> = { truck: 1, van: 1, garbage: 1 };
  private nextSpawn = 0;
  private nextGarbage = FIRST_GARBAGE;
  private time = 0;

  constructor(
    private readonly city: City,
    private readonly traffic: TrafficSystem,
    private readonly rng: Rng,
  ) {
    const withBay = (kinds: Building['kind'][]) => city.buildings.filter((b) => b.bay && kinds.includes(b.kind));
    this.freightHub = withBay(['freight_hub'])[0] ?? null;
    this.factories = withBay(['factory']);
    this.warehouses = withBay(['warehouse']);
    this.stores = withBay(['supermarket', 'mall']);
    this.shops = withBay(['shop']);
    this.wasteDepot = withBay(['waste_depot'])[0] ?? null;
    this.industrial = city.buildings.filter((b) => city.districts[b.district].kind === 'industrial' && !b.plot);
    this.frontage = city.buildings.filter((b) => !b.plot && b.kind !== 'fire_station' && b.kind !== 'police_station');
    const scale = city.scale;
    const hasTrucks = this.warehouses.length > 0 && (this.factories.length > 0 || this.freightHub !== null);
    this.targets = {
      // Short streets in the small town: one lorry at a time is plenty.
      truck: hasTrucks ? (scale < 2 ? 1 : Math.round(2 * scale)) : 0,
      van: this.warehouses.length > 0 && this.shops.length > 0 ? Math.max(2, Math.round(2 * scale)) : 0,
      garbage: this.wasteDepot ? Math.max(1, Math.round(scale * 0.3)) : 0,
    };
    // Start with lorries and vans already loading, so the city is busy from the first minute.
    for (let i = 0; i < this.targets.truck; i++) this.startJob('truck');
    for (let i = 0; i < this.targets.van; i++) this.startJob('van');
  }

  of(vehicle: Vehicle): LogisticsVehicle | undefined {
    return this.fleet.find((l) => l.vehicle === vehicle);
  }

  count(kind: LogisticsKind): number {
    return this.fleet.filter((l) => l.kind === kind).length;
  }

  update(time: number, events: readonly TrafficEvent[]): void {
    this.time = time;
    for (const event of events) {
      if (event.kind === 'departed') continue;
      const item = this.of(event.vehicle);
      if (item) this.arrived(item);
    }
    for (const item of [...this.fleet]) {
      const standing = item.status === 'loading' || item.status === 'unloading' || item.status === 'collecting';
      if (standing && time >= item.until && !this.traffic.isBeingOvertaken(item.vehicle)) this.moveOn(item);
    }
    if (time >= this.nextSpawn) {
      this.nextSpawn = time + SPAWN_INTERVAL;
      if (this.count('truck') < this.targets.truck) this.startJob('truck');
      else if (this.count('van') < this.targets.van) this.startJob('van');
    }
    if (this.wasteDepot && time >= this.nextGarbage) {
      if (this.count('garbage') >= this.targets.garbage || this.startGarbageRound()) this.nextGarbage = time + GARBAGE_INTERVAL;
    }
  }

  // -------------------------------------------------------------------------

  private bayPoint(building: Building, length: number): RoutePoint {
    const bay = building.bay!;
    return kerbPoint(this.traffic.graph, this.city.roads, bay.edgeId, bay.side, bay.s, length);
  }

  /** Nobody standing or driving at the kerb spot. */
  private spotFree(at: RoutePoint, length: number): boolean {
    return !this.traffic.vehicles.some((v) => v.segment === at.segment && v.s > at.s - length - 3 && v.s - v.length < at.s + 3);
  }

  /** A lorry or van starts loading at its origin's bay. False when no origin bay is free. */
  private startJob(kind: 'truck' | 'van'): boolean {
    const length = VEHICLE_DIMENSIONS[MODEL[kind]].length;
    for (let attempt = 0; attempt < 6; attempt++) {
      const job = kind === 'truck' ? this.pickTruckJob() : this.pickVanJob();
      if (!job) return false;
      const at = this.bayPoint(job.home, length);
      if (!this.spotFree(at, length) || this.bayBusy(job.home) || this.bayBusy(job.customer)) continue;
      const item = this.spawn(kind, job.home, at, true);
      item.customer = job.customer;
      item.cargo = this.rng.pick(kind === 'truck' ? TRUCK_CARGO : VAN_CARGO);
      item.status = 'loading';
      item.until = this.time + this.rng.range(...LOADING[kind]);
      return true;
    }
    return false;
  }

  /** Some lorry or van is at this building's bay or on its way there. */
  private bayBusy(building: Building): boolean {
    return this.fleet.some((l) => {
      if (l.kind === 'garbage') return false;
      const usesHome = l.status === 'loading' || l.status === 'returning';
      const usesCustomer = l.status !== 'returning';
      return (usesHome && l.home === building) || (usesCustomer && l.customer === building);
    });
  }

  /** Goods in: hub / factory → warehouse; goods out: warehouse → supermarket or mall. */
  private pickTruckJob(): { home: Building; customer: Building } | null {
    if (this.warehouses.length === 0) return null;
    if (this.stores.length > 0 && this.rng.chance(0.4)) {
      const customer = this.rng.pick(this.stores);
      return { home: this.nearestOf(this.warehouses, customer, 4), customer };
    }
    const origins = this.factories.length > 0 ? this.factories : [];
    const home = this.freightHub && (origins.length === 0 || this.rng.chance(0.4)) ? this.freightHub : origins.length ? this.rng.pick(origins) : null;
    if (!home) return null;
    // Mostly a nearby warehouse, so trips stay in the industrial districts.
    return { home, customer: this.nearestOf(this.warehouses.filter((w) => w !== home), home, 4) };
  }

  private pickVanJob(): { home: Building; customer: Building } | null {
    if (this.warehouses.length === 0 || this.shops.length === 0) return null;
    const customer = this.rng.pick(this.shops);
    return { home: this.nearestOf(this.warehouses, customer, 5), customer };
  }

  /** The nearest of a few random candidates (keeps trips local without always picking the same one). */
  private nearestOf(candidates: Building[], to: Building, tries: number): Building {
    let best = this.rng.pick(candidates);
    for (let i = 1; i < tries; i++) {
      const c = this.rng.pick(candidates);
      if (distance(c.footprint.center, to.footprint.center) < distance(best.footprint.center, to.footprint.center)) best = c;
    }
    return best;
  }

  private spawn(kind: LogisticsKind, home: Building, at: RoutePoint, parked: boolean): LogisticsVehicle {
    const color = kind === 'garbage' ? GARBAGE_COLOR : this.rng.pick(kind === 'truck' ? TRUCK_COLORS : VAN_COLORS);
    const spec = { role: ROLE[kind], model: MODEL[kind], color, at };
    const vehicle = parked ? this.traffic.spawnParked(spec) : this.traffic.spawnDriving(spec);
    const item: LogisticsVehicle = {
      id: vehicle.id,
      name: `${LABEL[kind]} ${this.numbers[kind]++}`,
      kind,
      vehicle,
      status: 'loading',
      home,
      customer: null,
      cargo: kind === 'garbage' ? 'waste' : '',
      until: 0,
      round: [],
      bin: null,
      binsTotal: 0,
      binsDone: 0,
    };
    this.fleet.push(item);
    return item;
  }

  private send(item: LogisticsVehicle, to: RoutePoint, inLane = false): boolean {
    const ok = this.traffic.sendTo(item.vehicle, to, false, inLane);
    item.vehicle.driver.speedFactor = item.kind === 'van' ? 1 : item.kind === 'truck' ? 0.85 : 0.8;
    return ok;
  }

  private remove(item: LogisticsVehicle): void {
    this.traffic.removeVehicle(item.vehicle);
    this.fleet.splice(this.fleet.indexOf(item), 1);
  }

  /** Done standing: on to the customer, back home, or to the next bin. */
  private moveOn(item: LogisticsVehicle): void {
    const length = item.vehicle.length;
    if (item.kind === 'garbage') {
      // Unloaded at the depot: the truck goes inside.
      if (item.status === 'unloading') {
        this.stats.garbageRounds++;
        return this.remove(item);
      }
      if (item.bin) {
        // Done at this bin.
        item.binsDone++;
        this.stats.binsEmptied++;
      }
      return this.nextBin(item);
    }
    if (item.status === 'loading' && item.customer) {
      if (this.send(item, this.bayPoint(item.customer, length))) item.status = 'delivering';
      else this.remove(item);
    } else if (item.status === 'unloading') {
      this.stats.deliveries++;
      if (this.send(item, this.bayPoint(item.home, length))) item.status = 'returning';
      else this.remove(item);
    }
  }

  /** Stopped at a bay (or in the lane next to it when the bay was taken). */
  private arrived(item: LogisticsVehicle): void {
    switch (item.status) {
      case 'delivering':
        item.status = 'unloading';
        item.until = this.time + this.rng.range(...UNLOADING[item.kind as 'truck' | 'van']);
        break;
      case 'returning':
        this.remove(item);
        break;
      case 'collecting':
        item.until = this.time + this.rng.range(...COLLECT_TIME);
        break;
      case 'to_depot':
        // Unload at the recycling hall, then go inside.
        item.status = 'unloading';
        item.until = this.time + DEPOT_UNLOAD;
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Garbage collection
  // -------------------------------------------------------------------------

  private startGarbageRound(): boolean {
    const depot = this.wasteDepot!;
    const length = VEHICLE_DIMENSIONS.garbage_truck.length;
    const at = this.bayPoint(depot, length);
    if (!this.spotFree(at, length)) return false;
    const item = this.spawn('garbage', depot, at, true);
    item.round = this.planRound(depot);
    item.binsTotal = item.round.length;
    item.status = 'collecting';
    item.until = this.time; // leaves at once
    return true;
  }

  /**
   * About ten buildings close together — mostly in an industrial district —
   * ordered as a round starting nearest the depot.
   */
  private planRound(depot: Building): Building[] {
    const pool = this.rng.chance(0.7) && this.industrial.length > 0 ? this.industrial : this.frontage;
    // A round in the nearer half of the pool, so the truck doesn't cross the whole city first.
    const byDistance = [...pool].sort(
      (x, y) => distance(x.footprint.center, depot.footprint.center) - distance(y.footprint.center, depot.footprint.center),
    );
    const seed = this.rng.pick(byDistance.slice(0, Math.max(1, Math.ceil(byDistance.length / 2))));
    const nearby = this.frontage
      .map((b) => ({ b, d: distance(b.footprint.center, seed.footprint.center) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, BINS_PER_ROUND * 4)
      .map((x) => x.b);
    const chosen: Building[] = [];
    for (const b of nearby) {
      if (chosen.length >= BINS_PER_ROUND) break;
      if (!this.binPoint(b)) continue;
      const tooClose = chosen.some((c) => distance(c.footprint.center, b.footprint.center) < BIN_SPACING);
      if (!tooClose) chosen.push(b);
    }
    // Greedy order by driving time (a bin across the street may mean a loop round the block).
    const round: Building[] = [];
    let from = this.bayPoint(depot, VEHICLE_DIMENSIONS.garbage_truck.length);
    while (chosen.length) {
      let best = 0;
      let bestTime = Infinity;
      chosen.forEach((b, i) => {
        const time = this.traffic.router.find(from, this.binPoint(b)!)?.time ?? Infinity;
        if (time < bestTime) {
          bestTime = time;
          best = i;
        }
      });
      const next = chosen.splice(best, 1)[0];
      round.push(next);
      from = this.binPoint(next)!;
    }
    return round;
  }

  /** Where the garbage truck stops in the lane in front of a building, or null where it shouldn't. */
  private binPoint(b: Building): RoutePoint | null {
    const length = VEHICLE_DIMENSIONS.garbage_truck.length;
    const { edgeId, side, s } = b.address;
    const point = kerbPoint(this.traffic.graph, this.city.roads, edgeId, side, s, length);
    const lane = this.traffic.graph.segments[point.segment];
    const front = Math.min(lane.length - BIN_LANE_END, Math.max(length + BIN_LANE_START, point.s));
    if (front < length + BIN_LANE_START) return null; // lane too short
    if (this.traffic.blocksCrossing(point.segment, front, length)) return null;
    return { segment: point.segment, s: front };
  }

  private nextBin(item: LogisticsVehicle): void {
    while (item.round.length > 0) {
      const bin = item.round.shift()!;
      const at = this.binPoint(bin);
      if (at && this.send(item, at, true)) {
        item.bin = bin;
        item.status = 'collecting';
        item.until = Infinity; // set on arrival
        return;
      }
    }
    item.bin = null;
    if (this.send(item, this.bayPoint(item.home, item.vehicle.length))) item.status = 'to_depot';
    else this.remove(item);
  }
}
