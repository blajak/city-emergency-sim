import { curbStop, kerbPoint } from '../dispatch/curb';
import type { Incident } from '../dispatch/types';
import { obbAxes, obbLocalToWorld, projectOnPolyline, samplePolyline } from '../math/geometry';
import type { Rng } from '../math/rng';
import { type Vec2, add, dot, rightOf, scale } from '../math/vec2';
import type { RoutePoint } from '../routing/router';
import type { SignalSystem } from '../signals/signalSystem';
import { type OffroadMove, offroadPose, startOffroad, stepOffroad } from '../traffic/offroad';
import type { KerbUse, TrafficEvent, TrafficSystem } from '../traffic/trafficSystem';
import { type Pose, VEHICLE_DIMENSIONS, type Vehicle, parkingOffset } from '../traffic/vehicle';
import { districtAt } from '../world/districts';
import { UTILITY_GARAGE_DEPTH } from '../world/buildings';
import { LANE_WIDTH } from '../world/constants';
import type { Building, City, DistrictId } from '../world/types';

/**
 * The power grid: one substation per district. A district can lose power
 * (switched off on the power plant card, or a fire at the plant cuts a random
 * district). Without power its traffic lights go out (junctions work as
 * unsignalised ones) and, at night, its windows and street lamps go dark.
 *
 * Utility crews in power-company vans wait on the driveway of their depot
 * next to the plant. A crew drives out, along the streets to the district's
 * substation, works there and restores power, then drives back onto the
 * driveway. Fire-caused cuts get a crew automatically once the fire is out;
 * cuts switched on the card stay until switched back on or a crew is sent.
 */

export type PowerCause = 'manual' | 'fire';

export interface DistrictPower {
  district: DistrictId;
  on: boolean;
  cause: PowerCause | null;
  /** Fire at the plant that caused the cut (repairs wait until it is out). */
  incidentId: number | null;
  /** Crew assigned to restore it. */
  crew: Crew | null;
}

export type CrewStatus = 'at_depot' | 'leaving' | 'to_substation' | 'repairing' | 'returning' | 'entering';

export interface Crew {
  id: number;
  name: string;
  /** Driveway spot (index). */
  spot: number;
  status: CrewStatus;
  district: DistrictId | null;
  /** On the road: the traffic vehicle; on the driveway: null (see `pose`). */
  vehicle: Vehicle | null;
  /** Driveway manoeuvre in progress. */
  move: OffroadMove | null;
  /** Pose while on the driveway (drawn like a vehicle). */
  pose: Pose;
  prevPose: Pose;
  until: number;
}

/** Driveway crew as the renderer sees it. */
export interface DrivewayVan {
  model: 'utility_van';
  color: number;
  sirens: false;
  pose: Pose;
  prevPose: Pose;
}

export type DispatchResult = { ok: true; crew: Crew } | { ok: false; reason: 'powered' | 'busy' | 'fire' | 'no_crew' | 'assigned' };

const VAN_COLOR = 0xf2b705;
const REPAIR_TIME: [number, number] = [60, 90];
const VAN = VEHICLE_DIMENSIONS.utility_van;
/** A van turning between the kerb and the driveway is near the road for this much of its path, m. */
const KERB_MANOEUVRE = 15;
/** Driveway layout (plot frame, +z towards the street). */
const TURN_RADIUS = 3.5;
const SPOT_REAR = 1.5;
const SECOND_SPOT_OFFSET = 4.5;
/** Kerb spots before / after the driveway entry, m along the street. */
const KERB_GAP = 8;

export class PowerSystem {
  readonly districts: DistrictPower[];
  readonly crews: Crew[] = [];
  /** Bumped on every power change (renderers compare it to know when to refresh). */
  version = 0;
  private readonly depot: Building | null;
  private readonly plant: Building | null;
  private readonly districtOfNode: DistrictId[];
  private readonly fireCuts = new Set<number>();
  private time = 0;
  private layout: DrivewayLayout | null = null;

  constructor(
    private readonly city: City,
    private readonly traffic: TrafficSystem,
    private readonly signals: SignalSystem,
    private readonly rng: Rng,
  ) {
    this.districts = city.districts.map((d) => ({ district: d.id, on: true, cause: null, incidentId: null, crew: null }));
    this.districtOfNode = city.roads.nodes.map((n) => districtAt(city.districts, n.pos));
    this.plant = city.power.plant !== null ? city.buildings[city.power.plant] : null;
    this.depot = city.power.depot !== null ? city.buildings[city.power.depot] : null;
    if (this.depot) {
      this.layout = drivewayLayout(city, this.traffic, this.depot);
      for (let spot = 0; spot < city.power.depotSpots; spot++) {
        const pose = this.layout.spotPose(spot);
        this.crews.push({
          id: spot + 1, name: `Crew ${spot + 1}`, spot, status: 'at_depot', district: null,
          vehicle: null, move: null, pose, prevPose: { ...pose }, until: 0,
        });
      }
      this.traffic.setKerbUsers(() => this.kerbUse());
    }
  }

  /**
   * Kerb strips a van uses while turning between the road and the driveway (it is
   * off the road network then, so traffic would not see it): nobody pulls over there.
   * The driveway gate itself (between the vans' entry and exit kerb spots) is always
   * kept clear: a unit parked there for a call blocked a van coming out.
   */
  private kerbUse(): KerbUse[] {
    const layout = this.layout;
    const use: KerbUse[] = [];
    if (!layout) return use;
    const [a, b] = [layout.entryKerb.s, layout.exitKerb.s - VAN.length].sort((x, y) => x - y);
    use.push({ segment: layout.exitKerb.segment, from: a, to: b });
    for (const crew of this.crews) {
      const move = crew.move;
      if (!move) continue;
      if (crew.status === 'entering' && move.s < KERB_MANOEUVRE) {
        use.push({ segment: layout.entryKerb.segment, from: layout.entryKerb.s - VAN.length - 1, to: layout.entryKerb.s + KERB_MANOEUVRE });
      }
      if (crew.status === 'leaving' && move.pathLength - move.s < KERB_MANOEUVRE) {
        use.push({ segment: layout.exitKerb.segment, from: layout.exitKerb.s - KERB_MANOEUVRE, to: layout.exitKerb.s + 1 });
      }
    }
    return use;
  }

  get plantBuilding(): Building | null {
    return this.plant;
  }

  isOn(district: DistrictId): boolean {
    return this.districts[district].on;
  }

  /** Vans standing or moving on the depot driveway (not part of road traffic). */
  get drivewayVans(): DrivewayVan[] {
    return this.crews
      .filter((c) => c.vehicle === null)
      .map((c) => ({ model: 'utility_van', color: VAN_COLOR, sirens: false, pose: c.pose, prevPose: c.prevPose }));
  }

  crewOf(vehicle: Vehicle): Crew | undefined {
    return this.crews.find((c) => c.vehicle === vehicle);
  }

  /** Cuts a district's power from the plant card. It stays off until switched on or repaired. */
  switchOff(district: DistrictId): void {
    const d = this.districts[district];
    if (!d.on) return;
    this.setPower(d, false, 'manual', null);
  }

  /** Restores power from the plant card (not while the plant is burning for this cut). */
  switchOn(district: DistrictId): boolean {
    const d = this.districts[district];
    if (d.on) return true;
    if (this.fireStillBurning(d)) return false;
    if (d.crew) this.sendHome(d.crew);
    this.setPower(d, true, null, null);
    return true;
  }

  /** Sends a free crew to repair a district's substation. */
  dispatchCrew(district: DistrictId): DispatchResult {
    const d = this.districts[district];
    if (d.on) return { ok: false, reason: 'powered' };
    if (d.crew) return { ok: false, reason: 'assigned' };
    if (this.fireStillBurning(d)) return { ok: false, reason: 'fire' };
    if (this.crews.length === 0) return { ok: false, reason: 'no_crew' };
    const crew = this.crews.find((c) => c.status === 'at_depot') ?? this.crews.find((c) => c.status === 'returning');
    if (!crew) return { ok: false, reason: 'busy' };
    d.crew = crew;
    crew.district = district;
    if (crew.status === 'returning' && crew.vehicle) {
      // Turn round on the way home.
      crew.status = 'to_substation';
      if (!this.traffic.sendTo(crew.vehicle, this.substationPoint(district), false)) this.sendHome(crew);
    } else {
      this.leaveDepot(crew);
    }
    return { ok: true, crew };
  }

  update(time: number, events: readonly TrafficEvent[], incidents: readonly Incident[]): void {
    const dt = time - this.time;
    this.time = time;
    this.watchPlantFires(incidents);
    for (const event of events) {
      // Parked at the kerb, or stopped in the lane when the kerb was taken.
      if (event.kind === 'departed') continue;
      const crew = this.crewOf(event.vehicle);
      if (crew) this.arrived(crew);
    }
    for (const crew of this.crews) this.updateCrew(crew, dt);
  }

  // -------------------------------------------------------------------------

  private setPower(d: DistrictPower, on: boolean, cause: PowerCause | null, incidentId: number | null): void {
    d.on = on;
    d.cause = on ? null : cause;
    d.incidentId = on ? null : incidentId;
    if (on) d.crew = null;
    const dark = new Set<number>();
    this.districtOfNode.forEach((district, node) => {
      if (!this.districts[district].on) dark.add(node);
    });
    this.signals.setDark(dark);
    this.version++;
  }

  private fireStillBurning(d: DistrictPower): boolean {
    return d.cause === 'fire' && d.incidentId !== null && this.fireCuts.has(d.incidentId);
  }

  /** A fire at the plant cuts a random powered district; once it is out, a crew goes to repair. */
  private watchPlantFires(incidents: readonly Incident[]): void {
    if (!this.plant) return;
    for (const incident of incidents) {
      if (incident.buildingId !== this.plant.id || incident.type !== 'fire') continue;
      const known = this.fireCuts.has(incident.id) || this.districts.some((d) => d.incidentId === incident.id);
      if (incident.status !== 'resolved' && !known) {
        this.fireCuts.add(incident.id);
        const powered = this.districts.filter((d) => d.on);
        if (powered.length > 0) this.setPower(this.rng.pick(powered), false, 'fire', incident.id);
      } else if (incident.status === 'resolved' && this.fireCuts.has(incident.id)) {
        this.fireCuts.delete(incident.id);
      }
    }
    // Repairs for fire cuts start once the fire is out (and keep trying while crews are busy).
    for (const d of this.districts) {
      if (!d.on && d.cause === 'fire' && !d.crew && !this.fireStillBurning(d)) this.dispatchCrew(d.district);
    }
  }

  private substationPoint(district: DistrictId): RoutePoint {
    const id = this.city.power.substations[district];
    const building = id !== null ? this.city.buildings[id] : this.plant!;
    return curbStop(this.traffic.graph, this.city.roads, building, VAN.length);
  }

  private leaveDepot(crew: Crew): void {
    if (!this.layout) return;
    crew.status = 'leaving';
    crew.move = startOffroad(this.layout.exitPath(crew.spot), VAN.length, this.layout.exitHoldIndex);
  }

  private sendHome(crew: Crew): void {
    if (crew.district !== null) {
      const d = this.districts[crew.district];
      if (d.crew === crew) d.crew = null;
    }
    crew.district = null;
    if (!crew.vehicle || !this.layout) return;
    crew.status = 'returning';
    if (!this.traffic.sendTo(crew.vehicle, this.layout.entryKerb, false)) {
      // Unreachable: just go back inside.
      this.traffic.removeVehicle(crew.vehicle);
      crew.vehicle = null;
      crew.status = 'at_depot';
      crew.pose = this.layout.spotPose(crew.spot);
      crew.prevPose = { ...crew.pose };
    }
  }

  private arrived(crew: Crew): void {
    if (crew.status === 'to_substation') {
      crew.status = 'repairing';
      crew.until = this.time + this.rng.range(...REPAIR_TIME);
    } else if (crew.status === 'returning' && this.layout && crew.vehicle) {
      // Off the road and onto the driveway.
      crew.pose = { ...crew.vehicle.pose };
      crew.prevPose = { ...crew.pose };
      this.traffic.removeVehicle(crew.vehicle);
      crew.vehicle = null;
      crew.status = 'entering';
      crew.move = startOffroad(this.layout.entryPath(crew.spot), VAN.length);
    }
  }

  private updateCrew(crew: Crew, dt: number): void {
    crew.prevPose = crew.pose;
    const layout = this.layout;
    if (crew.move && layout && (crew.status === 'leaving' || crew.status === 'entering')) {
      const hold = crew.status === 'leaving' && this.kerbTaken(layout.exitKerb);
      const done = stepOffroad(crew.move, dt, hold);
      crew.pose = offroadPose(crew.move.path, crew.move.s, VAN.length);
      if (!done) return;
      crew.move = null;
      if (crew.status === 'entering') {
        crew.status = 'at_depot';
        crew.pose = layout.spotPose(crew.spot);
        return;
      }
      // Out at the kerb: from here on it is road traffic.
      crew.vehicle = this.traffic.spawnParked({ role: 'utility', model: 'utility_van', color: VAN_COLOR, at: layout.exitKerb });
      if (crew.district === null) return this.sendHome(crew);
      crew.status = 'to_substation';
      if (!this.traffic.sendTo(crew.vehicle, this.substationPoint(crew.district), false)) this.sendHome(crew);
      return;
    }
    if (crew.status === 'repairing' && this.time >= crew.until && crew.district !== null) {
      const d = this.districts[crew.district];
      if (!this.traffic.isBeingOvertaken(crew.vehicle!)) {
        this.setPower(d, true, null, null);
        this.sendHome(crew);
      }
    }
  }

  private kerbTaken(at: RoutePoint): boolean {
    return this.traffic.vehicles.some((v) => v.segment === at.segment && v.s > at.s - VAN.length - 3 && v.s - v.length < at.s + 3);
  }
}

// ---------------------------------------------------------------------------
// Driveway geometry
// ---------------------------------------------------------------------------

interface DrivewayLayout {
  spotPose(spot: number): Pose;
  /** Spot → street → kerb spot beyond the entry (front bumper path). */
  exitPath(spot: number): Vec2[];
  /** Path index where a leaving van waits while the kerb spot is taken. */
  exitHoldIndex: number;
  /** Kerb spot → driveway entry → turning loop → spot. */
  entryPath(spot: number): Vec2[];
  /** Where a leaving van joins traffic (parked, then merges). */
  exitKerb: RoutePoint;
  /** Where a returning van stops before turning into the driveway. */
  entryKerb: RoutePoint;
}

/**
 * The depot site: garage at the back, a paved apron with one or two van
 * spots facing the street. Vans enter on the side further along the street,
 * loop round behind the spots and park nose-out, so they always leave
 * forwards and turn right into the kerb lane.
 */
export function drivewayLayout(city: City, traffic: TrafficSystem, depot: Building): DrivewayLayout {
  const plot = depot.plot!;
  const edge = city.roads.edges[depot.address.edgeId];
  const side = depot.address.side;
  const toWorld = (x: number, z: number) => obbLocalToWorld(plot, x, z);
  const [localX] = obbAxes(plot.rotation);
  // +1 when local +x points in the direction of travel of the kerb lane.
  const sAt = (p: Vec2) => projectOnPolyline(edge.points, p);
  const edgeDir = samplePolyline(edge.points, depot.address.s).dir;
  const u = Math.sign(dot(localX, scale(edgeDir, side))) || 1;
  const t = side; // travel direction along the edge for the kerb lane
  const kerbLine = (s: number) => {
    const sample = samplePolyline(edge.points, s);
    return add(sample.point, scale(rightOf(sample.dir), side * (LANE_WIDTH / 2 + parkingOffset(VAN.width))));
  };

  const xEntry = u * (plot.halfW - 2.5);
  const spotX = (spot: number) => xEntry - u * (2 * TURN_RADIUS + spot * SECOND_SPOT_OFFSET);
  const entryX = (spot: number) => spotX(spot) + u * 2 * TURN_RADIUS;
  const zTurn = -plot.halfD + UTILITY_GARAGE_DEPTH + TURN_RADIUS + 1.2; // the loop (and the van's width) stays clear of the garage
  const zRear = zTurn + SPOT_REAR - 0.9;
  const zFront = zRear + VAN.length;
  const zGate = plot.halfD + 1;

  const sEntry = sAt(toWorld(xEntry, plot.halfD));
  const exitCentre = sEntry + t * (KERB_GAP + VAN.length / 2);
  const entryCentre = sEntry - t * (KERB_GAP + VAN.length / 2);
  const exitKerb = kerbPoint(traffic.graph, city.roads, edge.id, side, exitCentre, VAN.length);
  const entryKerb = kerbPoint(traffic.graph, city.roads, edge.id, side, entryCentre, VAN.length);

  const arc = (spot: number): Vec2[] => {
    // Half circle behind the spots, from the entry lane (heading in) to the spot (heading out).
    const cx = (spotX(spot) + entryX(spot)) / 2;
    const points: Vec2[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI;
      points.push(toWorld(cx + u * TURN_RADIUS * Math.cos(a), zTurn - TURN_RADIUS * Math.sin(a)));
    }
    return points;
  };

  return {
    spotPose(spot) {
      const centre = toWorld(spotX(spot), (zRear + zFront) / 2);
      return { x: centre.x, z: centre.z, yaw: plot.rotation };
    },
    exitPath(spot) {
      const sOut = sAt(toWorld(spotX(spot), plot.halfD));
      return [
        toWorld(spotX(spot), zRear),
        toWorld(spotX(spot), zFront),
        toWorld(spotX(spot), zGate),
        kerbLine(sOut + t * 4.5),
        kerbLine(exitCentre + (t * VAN.length) / 2),
      ];
    },
    exitHoldIndex: 2,
    entryPath(spot) {
      return [
        kerbLine(entryCentre - (t * VAN.length) / 2),
        kerbLine(entryCentre + (t * VAN.length) / 2),
        kerbLine(sAt(toWorld(entryX(spot), plot.halfD)) - t * 3),
        toWorld(entryX(spot), zGate),
        ...arc(spot),
        toWorld(spotX(spot), zFront),
      ];
    },
    exitKerb,
    entryKerb,
  };
}
