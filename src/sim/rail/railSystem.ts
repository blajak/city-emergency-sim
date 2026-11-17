import { projectOnPolyline, samplePolyline } from '../math/geometry';
import type { LaneGraph, SegmentId } from '../traffic/laneGraph';
import type { Vehicle } from '../traffic/vehicle';
import { type Track, isPassengerTrack } from '../world/rail';
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

export type TrainKind = 'passenger' | 'freight' | 'longhaul';

const PERFORMANCE: Record<TrainKind, Performance> = {
  passenger: { maxSpeed: 15, accel: 0.8, decel: 1.0 },
  freight: { maxSpeed: 10, accel: 0.45, decel: 0.8 },
  longhaul: { maxSpeed: 12, accel: 0.35, decel: 0.7 },
};

// --- Long-distance freight ----------------------------------------------------
/**
 * Push-pull: a locomotive at each end and up to four container wagons (79 m), as many as
 * fit in the hub with the whole train clear of the street crossing (the hub's column of
 * blocks is widened for this, `HUB_EXTRA_WIDTH`; fewer wagons only as a safety net).
 */
const LONGHAUL_MAX_WAGONS = 4;
const LONGHAUL_MIN_WAGONS = 2;
/** The standing train's tail keeps this far from a crossing's centre on the siding, m. */
const LONGHAUL_CROSSING_CLEARANCE = 6;
function longhaulCars(wagons: number): TrainCar[] {
  const loco = { model: 'freight_loco' as const, length: 12 };
  return [loco, ...Array.from({ length: wagons }, () => ({ model: 'container_wagon' as const, length: 12.5 })), loco];
}
/** Seconds between long-distance freight trains. */
const LONGHAUL_INTERVAL = 480;
const LONGHAUL_FIRST = 60;
/** Time standing in the hub while containers are swapped, s. */
const LONGHAUL_DWELL = 120;
/** Speed coming out of the tunnel, m/s. */
const LONGHAUL_ENTRY_SPEED = 8;

/** Hard braking when something blocks the line unexpectedly, m/s². */
const EMERGENCY_DECEL = 2.5;
const STATION_DWELL = 20;
const FREIGHT_DWELL = 30;
const DWELL: Record<TrainKind, number> = { passenger: STATION_DWELL, freight: FREIGHT_DWELL, longhaul: LONGHAUL_DWELL };
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
  kind: TrainKind;
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
  /** Passenger trains: timetable arrival (sim time) at each stop still in `stops`. */
  schedule: number[];
}

/** A train arriving less than this late counts as on time, s. */
export const ON_TIME_TOLERANCE = 30;

export type RailEvent = { kind: 'train_arrived'; train: Train; place: string };

/** Predicted time a crossing is closed to road traffic, seconds from now. */
export interface ClosureWindow {
  from: number;
  until: number;
}

/** How long ahead closures are predicted, s. */
const FORECAST_HORIZON = 300;

/** Where a (real or expected) train is and what it does next, for forecasting. */
interface TrainOutlook {
  perf: Performance;
  /** Head position and travel direction along the track. */
  head: number;
  dir: 1 | -1;
  length: number;
  /** Seconds before it moves (dwell, or until it leaves the tunnel). */
  wait: number;
  v: number;
  /** Stops ahead (head positions), in travel order. */
  stops: number[];
  dwell: number;
}

export class RailSystem {
  readonly trains: Train[] = [];
  /** Running totals, e.g. for a "city pulse" read-out. */
  readonly stats = {
    stationStops: 0,
    freightTrips: 0,
    /** Passenger train arrivals at stations, and those less than ON_TIME_TOLERANCE late. */
    arrivals: 0,
    onTime: 0,
    /** Long-distance freight trains that reached the hub. */
    longhaulVisits: 0,
  };
  readonly crossings: LevelCrossing[];
  private readonly laneCrossings: Map<SegmentId, LaneCrossing[]>;
  private readonly tracks: Track[];
  private readonly stationStops: { track: Track; name: string; s: number }[] = [];
  private nextTrainId = 1;
  private nextDeparture = new Map<number, number>();
  private time = 0;
  private vehicles: readonly Vehicle[] = [];
  private events: RailEvent[] = [];
  private readonly forecast = new Map<number, ClosureWindow[]>();
  /** Long-distance freight service on the hub siding (null: no siding, or no room for a train). */
  readonly longhaul: { track: Track; cars: TrainCar[]; length: number; wagons: number } | null;

  constructor(
    city: City,
    private readonly graph: LaneGraph,
  ) {
    this.tracks = city.rail.tracks;
    this.crossings = findLevelCrossings(city.roads, graph, this.tracks);
    this.laneCrossings = crossingsByLane(this.crossings);

    for (const track of this.tracks.filter((t) => isPassengerTrack(t.kind))) {
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
    const siding = this.tracks.find((t) => t.kind === 'longhaul');
    this.longhaul = siding ? this.planLonghaul(siding) : null;
    if (this.longhaul) this.nextDeparture.set(this.longhaul.track.id, LONGHAUL_FIRST);
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

  /**
   * Seconds a road vehicle reaching this crossing `eta` seconds from now is
   * expected to wait at the barrier (0 when it should be open then).
   */
  expectedWait(lc: LaneCrossing, eta: number): number {
    let t = eta;
    // Back-to-back closures (trains in both directions) chain.
    for (let guard = 0; guard < 8; guard++) {
      const w = this.closures(lc.crossing).find((c) => c.from <= t && t < c.until);
      if (!w) break;
      t = w.until;
    }
    return t - eta;
  }

  /** Predicted closures of a crossing over the next few minutes (cached per step). */
  closures(crossing: LevelCrossing): readonly ClosureWindow[] {
    let windows = this.forecast.get(crossing.id);
    if (!windows) {
      windows = this.predictClosures(crossing);
      this.forecast.set(crossing.id, windows);
    }
    return windows;
  }

  step(dt: number): RailEvent[] {
    this.time += dt;
    this.forecast.clear();
    this.events = [];
    this.updateOccupancy();
    this.updateCrossings(dt);
    this.spawnTunnelTrains();
    for (const train of this.trains) this.moveTrain(train, dt);
    // Passenger trains leave through the tunnel at the end of their track; long-distance
    // freight backs out through the tunnel it came from.
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      const gone = t.kind === 'passenger' ? t.s - t.length > t.track.length : t.kind === 'longhaul' && t.dir === -1 && t.s < 0;
      if (gone) this.trains.splice(i, 1);
    }
    return this.events;
  }

  // -------------------------------------------------------------------------
  // Trains
  // -------------------------------------------------------------------------

  /** Trains due out of a tunnel: passenger trains, and long-distance freight into the hub. */
  private spawnTunnelTrains(): void {
    for (const track of this.tracks) {
      if (track.kind === 'freight') continue;
      const due = this.nextDeparture.get(track.id) ?? Infinity;
      if (this.time < due) continue;
      if (track.kind === 'longhaul') {
        // One track used both ways: wait until the previous train has left.
        if (this.trains.some((t) => t.track === track)) continue;
        this.trains.push(this.longhaulTrain(track));
        this.nextDeparture.set(track.id, due + LONGHAUL_INTERVAL);
        continue;
      }
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
        schedule: this.timetable(stops, due),
      });
      this.nextDeparture.set(track.id, due + PASSENGER_INTERVAL);
    }
  }

  /**
   * As many wagons as fit between the street crossing(s) on the siding and the hub buffer,
   * so the standing train never blocks a street; no service when even two don't fit.
   */
  private planLonghaul(siding: Track): { track: Track; cars: TrainCar[]; length: number; wagons: number } | null {
    const stop = siding.length - BUFFER_GAP;
    const crossingsAt = this.crossings.flatMap((c) => c.tracks.filter((t) => t.trackId === siding.id).map((t) => t.s));
    const clearFrom = Math.max(0, ...crossingsAt.map((s) => s + LONGHAUL_CROSSING_CLEARANCE));
    for (let wagons = LONGHAUL_MAX_WAGONS; wagons >= LONGHAUL_MIN_WAGONS; wagons--) {
      const cars = longhaulCars(wagons);
      const length = trainLength(cars);
      if (stop - length >= clearFrom) return { track: siding, cars, length, wagons };
    }
    return null;
  }

  /** A long-distance freight train coming out of the tunnel, heading for the hub buffer. */
  private longhaulTrain(track: Track): Train {
    return {
      id: this.nextTrainId++,
      kind: 'longhaul',
      track,
      cars: this.longhaul!.cars,
      length: this.longhaul!.length,
      s: 0,
      prevS: 0,
      dir: 1,
      v: LONGHAUL_ENTRY_SPEED,
      dwell: 0,
      stops: [track.length - BUFFER_GAP],
      stoppedAt: null,
      schedule: [],
    };
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
      schedule: [],
    });
  }

  /**
   * Timetable for a passenger train leaving the tunnel at `departure`: arrival at
   * each stop with a clear line (station dwells included).
   */
  private timetable(stops: readonly number[], departure: number): number[] {
    const perf = PERFORMANCE.passenger;
    const times: number[] = [];
    let t = departure;
    let v = PASSENGER_ENTRY_SPEED;
    let at = 0;
    for (const stop of stops) {
      t += legTime(stop - at, v, true, perf);
      times.push(t);
      t += STATION_DWELL;
      v = 0;
      at = stop;
    }
    return times;
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
      train.dwell = DWELL[train.kind];
      train.stoppedAt = this.placeName(train, nextStop);
      if (train.kind === 'passenger') {
        this.stats.stationStops++;
        const planned = train.schedule.shift();
        if (planned !== undefined) {
          this.stats.arrivals++;
          if (this.time - planned < ON_TIME_TOLERANCE) this.stats.onTime++;
        }
      } else if (train.kind === 'freight') {
        this.stats.freightTrips++;
      } else {
        this.stats.longhaulVisits++;
      }
      this.events.push({ kind: 'train_arrived', train, place: train.stoppedAt });
    }
  }

  private depart(train: Train): void {
    train.stoppedAt = null;
    // Shuttle: at an end of the line (no stops left), reverse towards the other end.
    // (At the start it is loading at the hub with the terminal still ahead.)
    // Long-distance freight: done in the hub, back out into the tunnel (no more stops).
    if (train.kind === 'passenger' || train.stops.length > 0) return;
    train.dir = train.dir === 1 ? -1 : 1;
    train.stops = train.kind === 'longhaul' ? [] : [train.dir === 1 ? train.track.length - BUFFER_GAP : BUFFER_GAP];
  }

  /** Where the train stops next (station or freight terminal), or null when it is leaving the city. */
  nextStopName(train: Train): string | null {
    const next = train.stops[0];
    return next === undefined ? null : this.placeName(train, next);
  }

  /** Centre of the train on the map (for the camera and picking). */
  trainCentre(train: Train): { x: number; z: number } {
    const centre = Math.min(train.track.length, Math.max(0, train.s - train.length / 2));
    const p = samplePolyline(train.track.points, centre).point;
    return { x: p.x, z: p.z };
  }

  /** Each car's body on the map (cars still in a tunnel are left out). */
  carBodies(train: Train): { x: number; z: number; yaw: number; length: number }[] {
    const bodies: { x: number; z: number; yaw: number; length: number }[] = [];
    let cursor = train.s;
    for (const car of train.cars) {
      const front = cursor;
      const rear = cursor - car.length;
      cursor = rear - CAR_GAP;
      if (front < 0.5 || rear > train.track.length - 0.5) continue;
      const a = samplePolyline(train.track.points, Math.max(0, front)).point;
      const b = samplePolyline(train.track.points, Math.max(0, rear)).point;
      bodies.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, yaw: Math.atan2(a.x - b.x, a.z - b.z), length: car.length });
    }
    return bodies;
  }

  private placeName(train: Train, stopS: number): string {
    if (train.kind === 'longhaul') return 'Freight Hub';
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
          // (The barrier pauses while someone is still on the crossing.)
          if (!c.occupied) c.barrier = Math.max(c.barrier, Math.min(1, Math.max(0, (c.timer - (WARNING_TIME - BARRIER_LOWER_TIME)) / BARRIER_LOWER_TIME)));
          if (!needed) this.setState(c, 'open');
          // Barriers only come down on an empty crossing: a long, slow lorry that
          // entered just before the lights started gets off first.
          else if (c.timer >= WARNING_TIME && !c.occupied) this.setState(c, 'closed');
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

  // -------------------------------------------------------------------------
  // Forecast
  // -------------------------------------------------------------------------

  /**
   * Closures from trains on the line, the freight shuttle's way back and the
   * next two departures out of each tunnel. A crossing is closed from CLOSE_ETA
   * before the head arrives until the tail has passed (station stops included,
   * braking for other crossings and trains ignored).
   */
  private predictClosures(crossing: LevelCrossing): ClosureWindow[] {
    const windows: ClosureWindow[] = [];
    const add = (o: TrainOutlook, trackS: number) => {
      const toHead = (trackS - o.head) * o.dir;
      const tail = o.head - o.dir * o.length;
      const toTail = (trackS - tail) * o.dir + 5;
      if (toTail <= 0) return; // passed
      const arrive = toHead > 0 ? this.timeToCover(o, toHead) : 0; // 0: already on it
      if (arrive > FORECAST_HORIZON) return;
      const clear = this.timeToCover(o, toTail);
      // Road traffic goes again as soon as the crossing opens (barriers still rising).
      windows.push({ from: Math.max(0, arrive - CLOSE_ETA), until: clear });
    };
    for (const o of this.outlooks()) {
      for (const t of crossing.tracks) if (t.trackId === o.trackId) add(o, t.s);
    }
    // Overlapping closures (trains in both directions) are one closure.
    windows.sort((a, b) => a.from - b.from);
    const merged: ClosureWindow[] = [];
    for (const w of windows) {
      const last = merged[merged.length - 1];
      if (last && w.from <= last.until) last.until = Math.max(last.until, w.until);
      else merged.push({ ...w });
    }
    return merged;
  }

  private outlooks(): (TrainOutlook & { trackId: number })[] {
    const list: (TrainOutlook & { trackId: number })[] = [];
    for (const train of this.trains) {
      const base = { trackId: train.track.id, perf: PERFORMANCE[train.kind], length: train.length, dwell: DWELL[train.kind], v: train.v };
      if (train.kind !== 'passenger' && train.dwell > 0 && train.stops.length === 0) {
        // Loading at an end of the line: it will reverse.
        list.push(this.reversed(train.kind, base, this.head(train), train.dir, train.dwell));
      } else {
        const now = { ...base, head: this.head(train), dir: train.dir, wait: Math.max(0, train.dwell), stops: train.stops };
        list.push(now);
        const end = train.stops[train.stops.length - 1];
        // Freight reverses at the end of its run: forecast the way back too.
        if (train.kind !== 'passenger' && end !== undefined) list.push(this.wayBack(train.kind, now, end));
      }
    }
    for (const [trackId, due] of this.nextDeparture) {
      const track = this.tracks.find((t) => t.id === trackId)!;
      if (track.kind === 'longhaul') {
        // The next long-distance train in, and back out after its stay in the hub.
        if (due <= this.time && this.trains.some((t) => t.track === track)) continue;
        const base = { trackId, perf: PERFORMANCE.longhaul, length: this.longhaul!.length, dwell: LONGHAUL_DWELL };
        const end = track.length - BUFFER_GAP;
        const comingIn = { ...base, head: 0, dir: 1 as const, wait: Math.max(0, due - this.time), v: LONGHAUL_ENTRY_SPEED, stops: [end] };
        list.push(comingIn, this.wayBack('longhaul', comingIn, end));
        continue;
      }
      const stops = this.stationStops
        .filter((st) => st.track.id === trackId)
        .map((st) => st.s + trainLength(PASSENGER_CARS) / 2)
        .sort((a, b) => a - b);
      for (const k of [0, 1]) {
        list.push({
          trackId,
          perf: PERFORMANCE.passenger,
          head: 0,
          dir: 1,
          length: trainLength(PASSENGER_CARS),
          wait: Math.max(0, due + k * PASSENGER_INTERVAL - this.time),
          v: PASSENGER_ENTRY_SPEED,
          stops,
          dwell: STATION_DWELL,
        });
      }
    }
    return list;
  }

  /**
   * A freight train after it has reversed at an end of its line: the shuttle heads for
   * the other end, long-distance freight back out through the tunnel (no stops).
   */
  private reversed(
    kind: TrainKind,
    base: Omit<TrainOutlook, 'head' | 'dir' | 'wait' | 'v' | 'stops'> & { trackId: number },
    head: number,
    dir: 1 | -1,
    wait: number,
  ): TrainOutlook & { trackId: number } {
    const back = dir === 1 ? -1 : 1;
    const track = this.tracks.find((t) => t.id === base.trackId)!;
    const stops = kind === 'longhaul' ? [] : [back === 1 ? track.length - BUFFER_GAP : BUFFER_GAP];
    return { ...base, head: head - dir * base.length, dir: back, wait, v: 0, stops };
  }

  /** The return run of a freight train now heading for `end` (arrive, stay, reverse). */
  private wayBack(kind: TrainKind, now: TrainOutlook & { trackId: number }, end: number): TrainOutlook & { trackId: number } {
    const arrive = this.timeToCover({ ...now, stops: [] }, (end - now.head) * now.dir);
    // Slow down to the buffers rather than run through: approximate with a stop leg.
    const brake = now.perf.maxSpeed / now.perf.decel / 2;
    return this.reversed(kind, now, end, now.dir, arrive + brake + DWELL[kind]);
  }

  /** Seconds until the head has moved `distance` metres, stopping at stations on the way. */
  private timeToCover(o: TrainOutlook, distance: number): number {
    let time = o.wait;
    let v = o.v;
    let done = 0;
    for (const stop of o.stops) {
      const d = (stop - o.head) * o.dir;
      // (A train pulling up to a stop is still going to stop there.)
      if (d < done - 0.3) continue;
      if (d >= distance) break;
      time += legTime(d - done, v, true, o.perf) + o.dwell;
      v = 0;
      done = d;
    }
    return time + legTime(distance - done, v, false, o.perf);
  }

  /**
   * A train is on the crossing or could reach it within CLOSE_ETA seconds. Uses
   * the forecast, so the barriers and the routing of emergency units agree (and a
   * train that will stop at a station first doesn't close the crossing early).
   */
  private trainNear(c: LevelCrossing): boolean {
    return this.closures(c).some((w) => w.from <= 0);
  }
}

const NONE: readonly LaneCrossing[] = [];

/**
 * Seconds to cover `distance` from speed `v0`: accelerate, cruise at the top
 * speed, and brake to a stop at the end when `stop`.
 */
function legTime(distance: number, v0: number, stop: boolean, perf: Performance): number {
  if (distance <= 0) return 0;
  const { accel: a, decel: b, maxSpeed: vm } = perf;
  v0 = Math.min(v0, vm);
  const accelDist = (vm * vm - v0 * v0) / (2 * a);
  const brakeDist = stop ? (vm * vm) / (2 * b) : 0;
  if (accelDist + brakeDist <= distance) {
    return (vm - v0) / a + (distance - accelDist - brakeDist) / vm + (stop ? vm / b : 0);
  }
  // Never reaches the top speed: peak speed where accelerating meets braking.
  const peak = Math.sqrt((distance + (v0 * v0) / (2 * a)) / (1 / (2 * a) + (stop ? 1 / (2 * b) : 0)));
  if (peak < v0) return stop ? (2 * distance) / v0 : distance / v0;
  return (peak - v0) / a + (stop ? peak / b : 0);
}

function trainLength(cars: readonly TrainCar[]): number {
  return cars.reduce((sum, c) => sum + c.length, 0) + CAR_GAP * (cars.length - 1);
}

export { CAR_GAP };
