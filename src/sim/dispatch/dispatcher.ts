import type { Rng } from '../math/rng';
import type { RoutePoint } from '../routing/router';
import type { TrafficEvent, TrafficSystem } from '../traffic/trafficSystem';
import { VEHICLE_DIMENSIONS, type Vehicle, type VehicleModel } from '../traffic/vehicle';
import type { Building, BuildingId, City } from '../world/types';
import { clampToLane, curbStop } from './curb';
import {
  type Incident,
  type IncidentType,
  PRIORITY_RANK,
  priorityFor,
  type ReportResult,
  UNIT_TYPE_FOR,
  type Unit,
  type UnitType,
} from './types';

/** Seconds the dispatcher needs to process a call before assigning a unit. */
const CALL_PROCESSING: [number, number] = [3, 6];
const ON_SCENE_DURATION: Record<IncidentType, [number, number]> = {
  fire: [20, 40],
  crime: [10, 25],
};
export const MAX_UNITS_PER_STATION = 3;
export const MIN_UNITS_PER_STATION = 1;
/** Free kerb between a unit at a scene and other vehicles standing there, m. */
const SCENE_GAP = 1.5;
/** Parking slot offsets in front of a station, in vehicle lengths. */
const SLOT_ORDER = [0, 1, -1];

const UNIT_SPECS: Record<UnitType, { model: VehicleModel; color: number; label: string; station: Building['kind'] }> = {
  fire: { model: 'fire_engine', color: 0xc62f25, label: 'Engine', station: 'fire_station' },
  police: { model: 'police_car', color: 0xf4f6f8, label: 'Patrol', station: 'police_station' },
};

/**
 * Takes incident reports, picks the fastest available unit, tracks units
 * through en route → on scene → returning, and queues calls when every
 * unit is busy. The queue is served by priority, then by age; when no unit
 * is free, a call may take a unit that is still driving to a less urgent one.
 */
export class Dispatcher {
  readonly units: Unit[] = [];
  readonly incidents: Incident[] = [];
  /** Called when a more urgent call takes a unit away from the one it was driving to. */
  onDiverted: ((unit: Unit, from: Incident, to: Incident) => void) | null = null;
  private nextUnitId = 1;
  private nextIncidentId = 1;
  private time = 0;

  constructor(
    private readonly city: City,
    private readonly traffic: TrafficSystem,
    private readonly rng: Rng,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  report(type: IncidentType, buildingId: BuildingId): ReportResult {
    const building = this.city.buildings[buildingId];
    if (!building) return { ok: false, reason: 'unknown_building' };
    if (building.kind === 'fire_station' || building.kind === 'police_station') return { ok: false, reason: 'station' };
    if (this.activeIncidentAt(buildingId)) return { ok: false, reason: 'busy' };

    const [min, max] = ON_SCENE_DURATION[type];
    const incident: Incident = {
      id: this.nextIncidentId++,
      type,
      buildingId,
      priority: priorityFor(building),
      status: 'reported',
      reportedAt: this.time,
      dispatchAt: this.time + this.rng.range(...CALL_PROCESSING),
      unitId: null,
      scene: null,
      arrivedAt: null,
      duration: this.rng.range(min, max),
      workDone: 0,
      resolvedAt: null,
      diverted: 0,
    };
    this.incidents.push(incident);
    return { ok: true, incident };
  }

  /** Adds a unit parked in front of its station. Returns null when the station is full. */
  addUnit(type: UnitType): Unit | null {
    const spec = UNIT_SPECS[type];
    const station = this.city.buildings.find((b) => b.kind === spec.station);
    if (!station) throw new Error(`No ${spec.station} in the city`);
    const taken = new Set(this.units.filter((u) => u.type === type).map((u) => u.slot));
    const slot = SLOT_ORDER.findIndex((_, i) => !taken.has(i));
    if (slot < 0 || taken.size >= MAX_UNITS_PER_STATION) return null;

    const unit: Unit = {
      id: this.nextUnitId++,
      type,
      name: `${spec.label} ${this.lowestFreeNumber(type)}`,
      stationId: station.id,
      slot,
      status: 'at_station',
      incidentId: null,
      vehicle: undefined as unknown as Vehicle,
    };
    unit.vehicle = this.traffic.spawnParked({
      role: type,
      model: spec.model,
      color: spec.color,
      at: this.stationSlot(unit),
    });
    this.units.push(unit);
    this.serveQueue(unit);
    return unit;
  }

  /** Why a unit can't be removed, or null when it can. */
  removalBlocker(unit: Unit): string | null {
    if (this.unitsOfType(unit.type).length <= MIN_UNITS_PER_STATION) return 'A station needs at least one unit.';
    if (unit.status !== 'at_station') return 'Only units waiting at the station can be removed.';
    return null;
  }

  removeUnit(unitId: number): boolean {
    const unit = this.unit(unitId);
    if (!unit || this.removalBlocker(unit)) return false;
    this.traffic.removeVehicle(unit.vehicle);
    this.units.splice(this.units.indexOf(unit), 1);
    return true;
  }

  unitsOfType(type: UnitType): Unit[] {
    return this.units.filter((u) => u.type === type);
  }

  activeIncidentAt(buildingId: BuildingId): Incident | undefined {
    return this.incidents.find((i) => i.buildingId === buildingId && i.status !== 'resolved');
  }

  unit(id: number | null): Unit | undefined {
    return id === null ? undefined : this.units.find((u) => u.id === id);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(time: number, dt: number, events: readonly TrafficEvent[]): void {
    this.time = time;
    for (const event of events) this.handleTrafficEvent(event);

    for (const incident of this.incidents) {
      if (incident.status === 'reported' && time >= incident.dispatchAt) this.dispatch(incident);
      if (incident.status === 'on_scene') {
        incident.workDone += dt;
        if (incident.workDone >= incident.duration) this.resolve(incident);
      }
    }
    this.ensurePatrol();
  }

  /**
   * At least one police car is always on patrol. A car waiting at the station
   * takes over first; otherwise a car heading back from an incident does.
   */
  private ensurePatrol(): void {
    const police = this.unitsOfType('police');
    if (police.length === 0 || police.some((u) => u.status === 'patrolling')) return;
    const next = police.find((u) => u.status === 'at_station') ?? police.find((u) => u.status === 'returning');
    if (!next) return;
    this.traffic.patrol(next.vehicle);
    next.status = 'patrolling';
  }

  private lowestFreeNumber(type: UnitType): number {
    const prefix = `${UNIT_SPECS[type].label} `;
    const used = new Set(this.unitsOfType(type).map((u) => Number(u.name.slice(prefix.length))));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private handleTrafficEvent(event: TrafficEvent): void {
    const unit = this.units.find((u) => u.vehicle === event.vehicle);
    if (!unit) return;
    const incident = this.incidents.find((i) => i.id === unit.incidentId);

    if (event.kind === 'departed' && unit.status === 'en_route' && incident) {
      incident.status = 'en_route';
    }
    if (event.kind === 'parked') {
      if (unit.status === 'en_route' && incident) {
        unit.status = 'on_scene';
        incident.status = 'on_scene';
        incident.arrivedAt = this.time;
        unit.vehicle.sirens = true; // beacons stay on while working the scene
      } else if (unit.status === 'returning') {
        unit.status = 'at_station';
      }
    }
  }

  private dispatch(incident: Incident): void {
    const free = this.fastestUnit(incident, (u) => this.isAvailable(u));
    if (free) {
      this.assign(free, incident);
      return;
    }
    const busy = this.fastestUnit(incident, (u) => this.isDivertibleFor(u, incident));
    if (busy) {
      this.divert(busy, incident);
      return;
    }
    incident.status = 'queued';
  }

  /** The unit of the right type passing `eligible` with the shortest travel time. */
  private fastestUnit(incident: Incident, eligible: (unit: Unit) => boolean): Unit | null {
    const type = UNIT_TYPE_FOR[incident.type];
    let best: Unit | null = null;
    let bestTime = Infinity;
    for (const unit of this.units) {
      if (unit.type !== type || !eligible(unit)) continue;
      // Includes expected waits at level crossings, as the unit would drive it.
      const time = this.traffic.travelTime(unit.vehicle, this.sceneFor(incident, unit), true);
      if (time < bestTime) {
        bestTime = time;
        best = unit;
      }
    }
    return best;
  }

  private isAvailable(unit: Unit): boolean {
    return unit.status === 'at_station' || unit.status === 'returning' || unit.status === 'patrolling';
  }

  /** A unit still driving to a less urgent call (never one already on scene). */
  private isDivertibleFor(unit: Unit, incident: Incident): boolean {
    if (unit.status !== 'en_route') return false;
    const current = this.incidents.find((i) => i.id === unit.incidentId);
    return current !== undefined && PRIORITY_RANK[current.priority] > PRIORITY_RANK[incident.priority];
  }

  /**
   * Takes `unit` off its current call and sends it to the more urgent `incident`.
   * The dropped call queues first among calls of its priority, or in turn takes a
   * unit from an even less urgent call.
   */
  private divert(unit: Unit, incident: Incident): void {
    const dropped = this.incidents.find((i) => i.id === unit.incidentId)!;
    dropped.status = 'queued';
    dropped.unitId = null;
    dropped.scene = null;
    dropped.diverted++;
    unit.incidentId = null;
    if (this.assign(unit, incident)) {
      this.onDiverted?.(unit, dropped, incident);
    } else if (!this.serveQueue(unit)) {
      unit.status = 'returning';
      unit.vehicle.sirens = false;
      this.traffic.sendTo(unit.vehicle, this.stationSlot(unit), false);
    }
    if (dropped.status === 'queued') this.dispatch(dropped);
  }

  private assign(unit: Unit, incident: Incident): boolean {
    const scene = this.sceneFor(incident, unit);
    if (!this.traffic.sendTo(unit.vehicle, scene, true)) {
      incident.status = 'queued';
      return false;
    }
    incident.scene = scene;
    incident.unitId = unit.id;
    unit.incidentId = incident.id;
    unit.status = 'en_route';
    // A unit already on the road is en route at once; a parked one first has to pull out.
    incident.status = unit.vehicle.maneuver === 'driving' ? 'en_route' : 'assigned';
    return true;
  }

  private resolve(incident: Incident): void {
    incident.status = 'resolved';
    incident.resolvedAt = this.time;
    const unit = this.unit(incident.unitId);
    if (!unit) return;
    unit.incidentId = null;
    unit.vehicle.sirens = false;
    unit.status = 'returning';
    if (!this.serveQueue(unit)) this.traffic.sendTo(unit.vehicle, this.stationSlot(unit), false);
  }

  /**
   * Gives a free unit the most urgent queued call of its type: by priority, then
   * calls that lost their unit to a more urgent one, then the oldest.
   */
  private serveQueue(unit: Unit): boolean {
    const next = this.incidents
      .filter((i) => i.status === 'queued' && UNIT_TYPE_FOR[i.type] === unit.type)
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          Number(b.diverted > 0) - Number(a.diverted > 0) ||
          a.reportedAt - b.reportedAt,
      )[0];
    if (!next) return false;
    return this.assign(unit, next);
  }

  // -------------------------------------------------------------------------
  // Parking spots
  // -------------------------------------------------------------------------

  private stationSlot(unit: Unit): RoutePoint {
    const { length } = VEHICLE_DIMENSIONS[UNIT_SPECS[unit.type].model];
    const station = this.city.buildings[unit.stationId];
    return curbStop(this.traffic.graph, this.city.roads, station, length, SLOT_ORDER[unit.slot] * (length + 1.5));
  }

  /** Curb stop in front of the incident building that no other unit is using. */
  private sceneFor(incident: Incident, unit: Unit): RoutePoint {
    if (incident.scene && incident.unitId === unit.id) return incident.scene;
    const building = this.city.buildings[incident.buildingId];
    const length = unit.vehicle.length;
    const base = curbStop(this.traffic.graph, this.city.roads, building, length);
    const lane = this.traffic.segment(base.segment);
    // Kerb space in use: other calls' scenes, and anything standing at the kerb
    // (e.g. a unit that has just finished here and is waiting to pull out).
    const taken = [
      ...this.incidents
        .filter((i) => i !== incident && i.status !== 'resolved' && i.scene?.segment === base.segment)
        .map((i) => ({ s: i.scene!.s, length: this.unit(i.unitId)?.vehicle.length ?? length })),
      ...this.traffic.vehicles
        .filter((v) => v !== unit.vehicle && v.segment === base.segment && v.maneuver !== 'driving')
        .map((v) => ({ s: v.s, length: v.length })),
    ];
    // Vehicles occupy [s - length, s] along the lane.
    const free = (s: number) => taken.every((t) => s - length > t.s + SCENE_GAP || t.s - t.length > s + SCENE_GAP);
    if (lane.kind !== 'lane') return base;
    // Nearest free spot to the building, metre by metre in both directions.
    for (let d = 0; d <= lane.length; d++) {
      for (const s of [clampToLane(lane, base.s + d, length), clampToLane(lane, base.s - d, length)]) {
        if (free(s) && !this.traffic.blocksCrossing(base.segment, s, length)) return { segment: base.segment, s };
      }
    }
    return base;
  }
}
