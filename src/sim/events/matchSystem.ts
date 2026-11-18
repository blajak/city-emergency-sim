import { kerbPoint } from '../dispatch/curb';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { Unit, UnitType } from '../dispatch/types';
import { type Rng, createRng } from '../math/rng';
import { distance } from '../math/vec2';
import type { RoutePoint } from '../routing/router';
import type { TrafficEvent, TrafficSystem } from '../traffic/trafficSystem';
import { VEHICLE_DIMENSIONS, type Vehicle, type VehicleModel } from '../traffic/vehicle';
import { loopSpaceFronts } from '../world/carPark';
import { approachDistance } from '../world/roadGeometry';
import type { Building, City } from '../world/types';

/**
 * Match day at the stadium (v3 feature 2). The user organises a match: fans drive in from
 * homes all over town to reserved spaces in the car park round the stadium while a police car
 * and an ambulance stand by in their own spaces there (the last ones before the exit); after the final whistle everyone sets off home
 * within a few seconds, and the car park's exits jam the streets around.
 */

export type MatchPhase = 'idle' | 'arriving' | 'playing' | 'leaving';

/** Seconds from "Organise a match" to kick-off (fans arrive meanwhile). */
export const ARRIVAL_TIME = 180;
/** Length of the match, s. */
export const MATCH_TIME = 120;
/** Fans should reach the car park between these times after the announcement, s. */
const FIRST_ARRIVAL = 35;
const LAST_ARRIVAL = ARRIVAL_TIME - 15;
/** Real driving time over the router's free-flow estimate (junctions, lights, traffic; measured ~2.6). */
const DRIVE_FACTOR = 2.6;
/**
 * After the whistle the fans are ready to pull out within this many seconds, the space nearest
 * the exit first, and each only once everyone parked nearer the exit has pulled out: a car
 * waiting to merge would otherwise watch the whole queue to the gate pass it (one waited
 * 260 s, seed 5).
 */
const LEAVE_SPREAD = 20;
/** Random extra delay per fan on top of its place in the order, s. */
const LEAVE_JITTER = 2;
/** Fans live this far from the stadium, m. */
const MIN_HOME_DISTANCE = 300;
const MAX_HOME_DISTANCE = 700;
/** Mean goals per match (both teams). */
const GOALS_PER_MATCH = 2.6;
/** Fans still on the road this long after the whistle are taken off the map, s. */
const LEAVING_TIMEOUT = 600;
/** Units standing by during a match. */
const DUTY: UnitType[] = ['police', 'ambulance'];

const FAN_COLORS = [0xd94b3d, 0x2f6fb3, 0xf2f2f2, 0x2b2b2b, 0x9aa3ab, 0xe0b23a, 0x3f8f5a, 0x7b4fa0, 0x5bb5d6, 0xb5543a];
const FAN_MODELS: VehicleModel[] = ['sedan', 'sedan', 'hatchback', 'hatchback', 'van'];
const HOME_KINDS: Building['kind'][] = ['residential', 'house', 'apartment'];

export type FanStatus = 'waiting' | 'driving_in' | 'parked' | 'leaving';

export interface Fan {
  id: number;
  home: Building;
  /** Index into `spaces`. */
  space: number;
  status: FanStatus;
  /** Sim time it sets off from home (waiting) or leaves the car park (parked, after the whistle). */
  at: number;
  vehicle: Vehicle | null;
}

export type MatchEvent =
  | { kind: 'announced'; fans: number; kickOff: number }
  | { kind: 'kick_off' }
  | { kind: 'goal'; side: 'home' | 'away'; minute: number }
  | { kind: 'final_whistle'; home: number; away: number }
  | { kind: 'car_park_empty' };

export class MatchSystem {
  readonly stadium: Building | null;
  readonly carPark: Building | null;
  /** Kerb spaces in the car park (front bumper position on an aisle lane), deepest first, lanes interleaved. */
  readonly spaces: RoutePoint[] = [];
  /** Where each duty unit stands: its own space in the car park, nearest the exit. */
  readonly dutySpaces = new Map<UnitType, RoutePoint>();
  phase: MatchPhase = 'idle';
  /** Sim time of kick-off and of the final whistle for the current match. */
  kickOff = 0;
  whistle = 0;
  score = { home: 0, away: 0 };
  readonly fans: Fan[] = [];
  /** Units standing by, and the unit types still waiting for a free unit. */
  readonly duty: Unit[] = [];
  private pendingDuty: UnitType[] = [];
  readonly stats = { matches: 0, fansParked: 0 };
  /** Things that happened since the UI last read them (`drainEvents`). */
  private events: MatchEvent[] = [];
  private readonly homes: Building[];
  private readonly rng: Rng;
  private time = 0;
  private nextFanId = 1;
  private lastSecond = -1;

  constructor(
    private readonly city: City,
    private readonly traffic: TrafficSystem,
    private readonly dispatcher: Dispatcher,
  ) {
    this.rng = createRng(city.seed ^ 0x3a7c0f11);
    this.stadium = city.buildings.find((b) => b.kind === 'stadium') ?? null;
    this.carPark = city.buildings.find((b) => b.kind === 'car_park') ?? null;
    const stadium = this.stadium;
    this.homes = stadium
      ? city.buildings.filter((b) => {
          const d = distance(b.footprint.center, stadium.footprint.center);
          return HOME_KINDS.includes(b.kind) && d >= MIN_HOME_DISTANCE && d <= MAX_HOME_DISTANCE;
        })
      : [];
    if (!stadium || !this.carPark) return;
    // Spaces along the loop's outer kerb, filled from the end of the loop (just before the
    // exit) backwards: nobody drives past a car that is still pulling in.
    const { edges, nodes } = city.roads;
    const loopLanes = traffic.graph.lanes
      .filter((l) => l.carPark && edges[l.edgeId].oneWay)
      .sort((a, b) => nodes[b.toNode].edges.length - nodes[a.toNode].edges.length); // the half ending at the gate first
    const all: RoutePoint[] = [];
    for (const lane of loopLanes) {
      const e = edges[lane.edgeId];
      const start = approachDistance(nodes[e.from]);
      const fronts = loopSpaceFronts(e.points, start, approachDistance(nodes[e.to]));
      for (const front of fronts.reverse()) all.push({ segment: lane.id, s: front - start });
    }
    // The two spaces nearest the exit are the duty units' (the ambulance's first); fans get the rest.
    if (all.length <= DUTY.length) return;
    for (const type of ['ambulance', 'police'] as const) this.dutySpaces.set(type, all.shift()!);
    this.spaces.push(...all);
  }

  /** A match can be organised: there is a car park and no match is on. */
  canOrganise(): boolean {
    return this.spaces.length > 0 && this.homes.length > 0 && this.phase === 'idle';
  }

  /** Duty unit types still waiting for a free unit. */
  waitingForUnits(): readonly UnitType[] {
    return this.pendingDuty;
  }

  /** Fans parked right now. */
  parked(): number {
    return this.fans.filter((f) => f.status === 'parked').length;
  }

  /** Match minute (0–90) while playing. */
  minute(): number {
    return Math.min(90, Math.floor(((this.time - this.kickOff) / MATCH_TIME) * 90));
  }

  drainEvents(): MatchEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Announces a match: kick-off in `ARRIVAL_TIME` s; fans and the duty units set off. */
  organise(): boolean {
    if (!this.canOrganise()) return false;
    this.phase = 'arriving';
    this.kickOff = this.time + ARRIVAL_TIME;
    this.whistle = this.kickOff + MATCH_TIME;
    this.score = { home: 0, away: 0 };
    this.stats.matches++;
    // As many fans as spaces, or a few fewer.
    const count = Math.max(1, Math.round(this.spaces.length * this.rng.range(0.85, 1)));
    // Each fan leaves home in time to arrive at its slot of the arrival window (driving
    // time estimated from the router), so the car park fills up before kick-off.
    for (let i = 0; i < count; i++) {
      const arrival = FIRST_ARRIVAL + (i / count) * (LAST_ARRIVAL - FIRST_ARRIVAL);
      // A home close enough to make it (the nearest of a few picks when none is).
      let home = this.rng.pick(this.homes);
      let drive = this.driveTime(home, i);
      for (let tries = 0; tries < 20 && drive > arrival; tries++) {
        const other = this.rng.pick(this.homes);
        const t = this.driveTime(other, i);
        if (t < drive) {
          home = other;
          drive = t;
        }
      }
      this.fans.push({ id: this.nextFanId++, home, space: i, status: 'waiting', at: this.time + Math.max(0, arrival - drive), vehicle: null });
    }
    this.pendingDuty = [...DUTY];
    this.events.push({ kind: 'announced', fans: count, kickOff: this.kickOff });
    return true;
  }

  update(time: number, events: readonly TrafficEvent[]): void {
    this.time = time;
    if (this.phase === 'idle' && this.fans.length === 0) return;
    for (const event of events) {
      if (event.kind === 'departed') continue;
      const fan = this.fans.find((f) => f.vehicle === event.vehicle);
      if (!fan) continue;
      if (event.kind === 'parked' && fan.status === 'driving_in') {
        fan.status = 'parked';
        this.stats.fansParked++;
        // Pulled in just after the whistle: leaves with the others.
        if (this.phase === 'leaving') fan.at = this.time + this.leaveDelay(fan);
      } else if (event.kind === 'halted' && fan.status === 'leaving') {
        this.remove(fan); // home
      }
    }

    // Phase changes.
    if (this.phase === 'arriving' && time >= this.kickOff) {
      this.phase = 'playing';
      this.events.push({ kind: 'kick_off' });
    }
    if (this.phase === 'playing' && time >= this.whistle) this.finalWhistle();
    if (this.phase === 'leaving' && (!this.fans.some((f) => this.inCarPark(f)) || time > this.whistle + LEAVING_TIMEOUT)) this.wrapUp();
    // Fans still on the road long after the match are taken off the map.
    if (this.phase === 'idle' && time > this.whistle + LEAVING_TIMEOUT) for (const fan of [...this.fans]) this.remove(fan);

    for (const fan of [...this.fans]) {
      if (time < fan.at) continue;
      if (fan.status === 'waiting') this.setOff(fan);
      else if (fan.status === 'parked' && this.phase === 'leaving' && this.nobodyPullingOutAhead(fan)) this.goHome(fan);
    }

    // Once a second: goals, and units for the stand-by still missing.
    const second = Math.floor(time);
    if (second === this.lastSecond) return;
    this.lastSecond = second;
    if (this.phase === 'playing' && this.rng.chance(GOALS_PER_MATCH / MATCH_TIME)) {
      const side = this.rng.chance(0.55) ? 'home' : 'away';
      this.score[side]++;
      this.events.push({ kind: 'goal', side, minute: this.minute() });
    }
    if (this.phase === 'arriving' || this.phase === 'playing') {
      this.pendingDuty = this.pendingDuty.filter((type) => {
        const space = this.dutySpaces.get(type);
        const unit = space ? this.dispatcher.assignDuty(type, space) : null;
        if (unit) this.duty.push(unit);
        return !unit && this.dispatcher.unitsOfType(type).length > 0;
      });
    }
  }

  /** A fan pulls out from the kerb at home and heads for its space. */
  private setOff(fan: Fan): void {
    if (this.phase !== 'arriving' && this.phase !== 'playing') return this.remove(fan);
    const model = this.rng.pick(FAN_MODELS);
    const { length } = VEHICLE_DIMENSIONS[model];
    // Home kerb free (else try another home a moment later).
    const at = kerbPoint(this.traffic.graph, this.city.roads, fan.home.address.edgeId, fan.home.address.side, fan.home.address.s, length);
    if (!this.kerbFree(at, length)) {
      fan.home = this.rng.pick(this.homes);
      fan.at = this.time + 1;
      return;
    }
    const vehicle = this.traffic.spawnParked({ role: 'civilian', model, color: this.rng.pick(FAN_COLORS), at });
    fan.vehicle = vehicle;
    if (!this.traffic.sendTo(vehicle, this.spaces[fan.space], false)) return this.remove(fan);
    fan.status = 'driving_in';
  }

  /** After the whistle: from the car park (or from wherever it still is) back home, stopping in the lane there. */
  private goHome(fan: Fan): void {
    const vehicle = fan.vehicle;
    if (!vehicle) return this.remove(fan);
    const at = kerbPoint(this.traffic.graph, this.city.roads, fan.home.address.edgeId, fan.home.address.side, fan.home.address.s, vehicle.length);
    if (!this.traffic.sendTo(vehicle, at, false, true)) return this.remove(fan);
    fan.status = 'leaving';
  }

  private finalWhistle(): void {
    this.phase = 'leaving';
    this.events.push({ kind: 'final_whistle', home: this.score.home, away: this.score.away });
    for (const fan of [...this.fans]) {
      if (fan.status === 'waiting') this.remove(fan);
      // Still on the way: straight home, unless already pulling into its space (sent off half
      // in the lane it would wait to merge with the car behind waiting for it).
      else if (fan.status === 'driving_in' && fan.vehicle?.maneuver !== 'arriving') this.goHome(fan);
      else fan.at = this.time + this.leaveDelay(fan);
    }
    this.pendingDuty = [];
  }

  /** Every fan parked nearer the exit has pulled out and joined the traffic on the loop. */
  private nobodyPullingOutAhead(fan: Fan): boolean {
    return !this.fans.some(
      (o) => o.space < fan.space && (o.status === 'parked' || (o.status === 'leaving' && o.vehicle !== null && o.vehicle.maneuver !== 'driving')),
    );
  }

  /** Seconds after the whistle a parked fan pulls out: in the order of the spaces from the exit. */
  private leaveDelay(fan: Fan): number {
    return (fan.space / this.spaces.length) * LEAVE_SPREAD + this.rng.range(0, LEAVE_JITTER);
  }

  /** Car park empty: the duty units go back (fans still driving home are left to arrive). */
  private wrapUp(): void {
    for (const fan of [...this.fans]) if (this.inCarPark(fan) || fan.status !== 'leaving') this.remove(fan);
    for (const unit of this.duty) this.dispatcher.releaseDuty(unit);
    this.duty.length = 0;
    this.phase = 'idle';
    this.events.push({ kind: 'car_park_empty' });
  }

  /** Parked in the car park, or still driving out of it (on an aisle or turning out of one). */
  private inCarPark(fan: Fan): boolean {
    if (fan.status === 'parked') return true;
    if (!fan.vehicle) return false;
    const seg = this.traffic.segment(fan.vehicle.segment);
    const lane = seg.kind === 'lane' ? seg : this.traffic.segment(seg.fromLane);
    return lane.kind === 'lane' && lane.carPark;
  }

  /** Estimated seconds from a home's kerb to a space. */
  private driveTime(home: Building, space: number): number {
    const at = kerbPoint(this.traffic.graph, this.city.roads, home.address.edgeId, home.address.side, home.address.s, 4.5);
    return (this.traffic.router.find(at, this.spaces[space])?.time ?? Infinity) * DRIVE_FACTOR;
  }

  private remove(fan: Fan): void {
    if (fan.vehicle) this.traffic.removeVehicle(fan.vehicle);
    this.fans.splice(this.fans.indexOf(fan), 1);
  }

  /** Nobody standing or driving at a kerb spot, no driveway use, not on a level crossing. */
  private kerbFree(at: RoutePoint, length: number): boolean {
    if (this.traffic.kerbInUse(at.segment, at.s - length - 3, at.s + 3) || this.traffic.blocksCrossing(at.segment, at.s, length)) return false;
    return !this.traffic.vehicles.some((v) => v.segment === at.segment && v.s > at.s - length - 3 && v.s - v.length < at.s + 3);
  }
}
