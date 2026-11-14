import { projectOnPolyline } from '../math/geometry';
import type { LaneGraph, SegmentId } from '../traffic/laneGraph';
import type { Vehicle } from '../traffic/vehicle';
import type { Track } from '../world/rail';
import type { City } from '../world/types';
import { type LaneCrossing, type LevelCrossing, crossingsByLane, findLevelCrossings } from './crossings';

/**
 * Trains and level crossings.
 *
 * Passenger trains run on their own track in each direction, come out of a
 * tunnel at one map edge, stop at both stations and disappear into the
 * tunnel at the other edge. The freight train shuttles on its own track
 * between the freight hub and the terminal (locomotives at both ends).
 *
 * Level crossings close well before a train arrives; a train only passes a
 * crossing that is closed AND has no road vehicle on it, otherwise it brakes.
 */

export type CarModel = 'emu_cab' | 'emu_middle' | 'freight_loco' | 'container_wagon';

export interface TrainCar {
  model: CarModel;
  length: number;
}

const CAR_GAP = 1;
const PASSENGER_CARS: TrainCar[] = [
  { model: 'emu_cab', length: 17 },
  { model: 'emu_middle', length: 17 },
  { model: 'emu_cab', length: 17 },
];
const FREIGHT_CARS: TrainCar[] = [
  { model: 'freight_loco', length: 12 },
  { model: 'container_wagon', length: 12.5 },
  { model: 'container_wagon', length: 12.5 },
  { model: 'freight_loco', length: 12 },
];

interface Performance {
  maxSpeed: number;
  accel: number;
  decel: number;
}

const PERFORMANCE: Record<'passenger' | 'freight', Performance> = {
  passenger: { maxSpeed: 15, accel: 0.8, decel: 1.0 },
  freight: { maxSpeed: 10, accel: 0.45, decel: 0.8 },
};
/** Hard braking when something blocks the line unexpectedly, m/s². */
const EMERGENCY_DECEL = 2.5;
const STATION_DWELL = 20;
const FREIGHT_DWELL = 30;
/** Seconds between passenger trains in each direction. */
const PASSENGER_INTERVAL = 150;
/** Close a crossing when a train could be there within this many seconds. */
const CLOSE_ETA = 18;
/** Lights flash this long before the barriers are fully down. */
const WARNING_TIME = 5;
/** Barriers start lowering this long before WARNING_TIME ends. */
const BARRIER_LOWER_TIME = 3;
const BARRIER_RAISE_TIME = 2;
/** A train stops this far before a crossing it may not pass yet, m. */
const CROSSING_STOP_DISTANCE = 8;
/** Minimum gap to the train ahead on the same track, m. */
const TRAIN_GAP = 30;
/** Speed at which passenger trains come out of the tunnel, m/s. */
const PASSENGER_ENTRY_SPEED = 10;
/** Freight trains stop this far from the buffers, m. */
const BUFFER_GAP = 3;

export interface Train {
  id: number;
  kind: 'passenger' | 'freight';
  track: Track;
  cars: TrainCar[];
  /** Total length including gaps. */
  length: number;
  /** Coordinate of the train's end with the larger track position (head when dir = 1). */
  s: number;
  prevS: number;
  dir: 1 | -1;
  v: number;
  dwell: number;
  /** Stops (head positions, in travel order) not yet served. */
  stops: number[];
  /** Station / terminal currently being served, for display. */
  stoppedAt: string | null;
}

export type RailEvent = { kind: 'train_arrived'; train: Train; place: string };

export class RailSystem {
  readonly trains: Train[] = [];
  /** Running totals, e.g. for a "city pulse" read-out. */
  readonly stats = { stationStops: 0, freightTrips: 0 };
  readonly crossings: LevelCrossing[];
  private readonly laneCrossings: Map<SegmentId, LaneCrossing[]>;
  private readonly tracks: Track[];
  private readonly stationStops: { track: Track; name: string; s: number }[] = [];
  private nextTrainId = 1;
  private nextDeparture = new Map<number, number>();
  private time = 0;
  private vehicles: readonly Vehicle[] = [];
  private events: RailEvent[] = [];

  constructor(
    city: City,
    private readonly graph: LaneGraph,
  ) {
    this.tracks = city.rail.tracks;
    this.crossings = findLevelCrossings(city.roads, graph, this.tracks);
    this.laneCrossings = crossingsByLane(this.crossings);

    for (const track of this.tracks.filter((t) => t.kind !== 'freight')) {
      for (const b of city.buildings.filter((x) => x.kind === 'train_station')) {
        const centre = b.plot?.center ?? b.footprint.center;
        this.stationStops.push({ track, name: b.name ?? 'Station', s: projectOnPolyline(track.points, centre) });
      }
    }
    // First trains: eastbound right away, westbound half an interval later.
    this.tracks.forEach((t) => {
      if (t.kind === 'eastbound') this.nextDeparture.set(t.id, 2);
      if (t.kind === 'westbound') this.nextDeparture.set(t.id, 2 + PASSENGER_INTERVAL / 2);
    });
    const freight = this.tracks.find((t) => t.kind === 'freight');
    if (freight) this.spawnFreight(freight);
  }

  /** Road vehicles the crossings watch for (set once by the simulation). */
  attachTraffic(vehicles: readonly Vehicle[]): void {
    this.vehicles = vehicles;
  }

  /** Centre line of a lane (for drawing crossing furniture). */
  lanePoints(laneId: SegmentId) {
    return this.graph.segments[laneId].points;
  }

  /** Level crossings on a lane, ordered along it. */
  crossingsOn(laneId: SegmentId): readonly LaneCrossing[] {
    return this.laneCrossings.get(laneId) ?? NONE;
  }

  step(dt: number): RailEvent[] {
    this.time += dt;
    this.events = [];
    this.updateOccupancy();
    this.updateCrossings(dt);
    this.spawnPassengerTrains();
    for (const train of this.trains) this.moveTrain(train, dt);
    // Passenger trains leave through the tunnel at the end of their track.
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      if (t.kind === 'passenger' && t.s - t.length > t.track.length) this.trains.splice(i, 1);
    }
    return this.events;
  }

  // -------------------------------------------------------------------------
  // Trains
  // -------------------------------------------------------------------------

  private spawnPassengerTrains(): void {
    for (const track of this.tracks) {
      if (track.kind === 'freight') continue;
      const due = this.nextDeparture.get(track.id) ?? Infinity;
      if (this.time < due) continue;
      // Wait until the previous train is clear of the tunnel mouth.
      const blocked = this.trains.some((t) => t.track === track && t.s - t.length < TRAIN_GAP);
      if (blocked) continue;
      const cars = PASSENGER_CARS;
      const stops = this.stationStops
        .filter((st) => st.track === track)
        .map((st) => st.s + trainLength(cars) / 2)
        .sort((a, b) => a - b);
      this.trains.push({
        id: this.nextTrainId++,
        kind: 'passenger',
        track,
        cars,
        length: trainLength(cars),
        s: 0,
        prevS: 0,
        dir: 1,
        v: PASSENGER_ENTRY_SPEED,
        dwell: 0,
        stops,
        stoppedAt: null,
      });
      this.nextDeparture.set(track.id, due + PASSENGER_INTERVAL);
    }
  }

  private spawnFreight(track: Track): void {
    const length = trainLength(FREIGHT_CARS);
    // Starts at the hub, loading, heading for the terminal.
    this.trains.push({
      id: this.nextTrainId++,
      kind: 'freight',
      track,
      cars: FREIGHT_CARS,
      length,
      s: BUFFER_GAP + length,
      prevS: BUFFER_GAP + length,
      dir: 1,
      v: 0,
      dwell: FREIGHT_DWELL / 2,
      stops: [track.length - BUFFER_GAP],
      stoppedAt: 'Freight Hub',
    });
  }

  private head(train: Train): number {
    return train.dir === 1 ? train.s : train.s - train.length;
  }

  private moveTrain(train: Train, dt: number): void {
    train.prevS = train.s;
    if (train.dwell > 0) {
      train.dwell -= dt;
      train.v = 0;
      if (train.dwell <= 0) this.depart(train);
      return;
    }
    const perf = PERFORMANCE[train.kind];
    const head = this.head(train);
    const ahead = (s: number) => (s - head) * train.dir;

    // Closest place the train must be able to stop at.
    let limit = Infinity;
    const nextStop = train.stops[0];
    if (nextStop !== undefined) limit = Math.min(limit, ahead(nextStop));
    for (const crossing of this.crossings) {
      if (crossing.state === 'closed' && !crossing.occupied) continue;
      for (const t of crossing.tracks) {
        if (t.trackId !== train.track.id) continue;
        const d = ahead(t.s);
        if (d > 0) limit = Math.min(limit, d - CROSSING_STOP_DISTANCE);
      }
    }
    for (const other of this.trains) {
      if (other === train || other.track !== train.track) continue;
      // Gap from our head to the other train's nearer end.
      const otherNear = train.dir === 1 ? other.s - other.length : other.s;
      const d = ahead(otherNear);
      if (d > -other.length) limit = Math.min(limit, d - TRAIN_GAP);
    }

    // Speed that still allows stopping at the limit with service braking.
    const allowed = Math.sqrt(2 * perf.decel * Math.max(0, limit));
    const target = Math.min(perf.maxSpeed, allowed);
    if (train.v < target) train.v = Math.min(target, train.v + perf.accel * dt);
    else train.v = Math.max(target, train.v - EMERGENCY_DECEL * dt);
    const move = Math.min(train.v * dt, Math.max(0, limit));
    train.s += train.dir * move;

    // Arrived at a stop.
    if (nextStop !== undefined && ahead(nextStop) < 0.3 && train.v < 0.5) {
      train.v = 0;
      train.stops.shift();
      train.dwell = train.kind === 'freight' ? FREIGHT_DWELL : STATION_DWELL;
      train.stoppedAt = this.placeName(train, nextStop);
      if (train.kind === 'passenger') this.stats.stationStops++;
      else this.stats.freightTrips++;
      this.events.push({ kind: 'train_arrived', train, place: train.stoppedAt });
    }
  }

  private depart(train: Train): void {
    train.stoppedAt = null;
    if (train.kind !== 'freight') return;
    // Shuttle: reverse towards the other end of the line.
    train.dir = train.dir === 1 ? -1 : 1;
    train.stops = [train.dir === 1 ? train.track.length - BUFFER_GAP : BUFFER_GAP];
  }

  private placeName(train: Train, stopS: number): string {
    if (train.kind === 'freight') return stopS < train.track.length / 2 ? 'Freight Hub' : 'Dockside Freight Terminal';
    const centre = stopS - train.length / 2;
    const station = this.stationStops.find((st) => st.track === train.track && Math.abs(st.s - centre) < 1);
    return station?.name ?? 'Station';
  }

  // -------------------------------------------------------------------------
  // Crossings
  // -------------------------------------------------------------------------

  private updateOccupancy(): void {
    for (const c of this.crossings) c.occupied = false;
    for (const v of this.vehicles) {
      for (const lc of this.laneCrossings.get(v.segment) ?? NONE) {
        if (v.s > lc.startS && v.s - v.length < lc.endS) lc.crossing.occupied = true;
      }
    }
  }

  private updateCrossings(dt: number): void {
    for (const c of this.crossings) {
      const needed = this.trainNear(c);
      c.timer += dt;
      switch (c.state) {
        case 'open':
          c.barrier = Math.max(0, 1 - c.timer / BARRIER_RAISE_TIME);
          if (needed) this.setState(c, 'warning');
          break;
        case 'warning':
          c.barrier = Math.min(1, Math.max(0, (c.timer - (WARNING_TIME - BARRIER_LOWER_TIME)) / BARRIER_LOWER_TIME));
          if (!needed) this.setState(c, 'open');
          else if (c.timer >= WARNING_TIME) this.setState(c, 'closed');
          break;
        case 'closed':
          c.barrier = 1;
          if (!needed) this.setState(c, 'open');
          break;
      }
    }
  }

  private setState(c: LevelCrossing, state: LevelCrossing['state']): void {
    c.state = state;
    c.timer = 0;
  }

  /** A train is on the crossing or could reach it within CLOSE_ETA seconds. */
  private trainNear(c: LevelCrossing): boolean {
    for (const train of this.trains) {
      for (const t of c.tracks) {
        if (t.trackId !== train.track.id) continue;
        const tail = train.s - train.length;
        if (t.s > tail - 5 && t.s < train.s + 5) return true; // on it
        const d = (t.s - this.head(train)) * train.dir;
        if (d <= 0) continue; // already passed
        const perf = PERFORMANCE[train.kind];
        const eta = train.dwell > 0 ? train.dwell + Math.sqrt((2 * d) / perf.accel) : d / Math.max(train.v, 4);
        if (eta <= CLOSE_ETA) return true;
      }
    }
    // Trains about to come out of a tunnel.
    for (const [trackId, due] of this.nextDeparture) {
      for (const t of c.tracks) {
        if (t.trackId === trackId && Math.max(0, due - this.time) + t.s / PASSENGER_ENTRY_SPEED <= CLOSE_ETA) return true;
      }
    }
    return false;
  }
}

const NONE: readonly LaneCrossing[] = [];

function trainLength(cars: readonly TrainCar[]): number {
  return cars.reduce((sum, c) => sum + c.length, 0) + CAR_GAP * (cars.length - 1);
}

export { CAR_GAP };
