import type { Rng } from '../math/rng';
import type { RoutePoint } from '../routing/router';
import type { TrafficEvent, TrafficSystem } from '../traffic/trafficSystem';
import { VEHICLE_DIMENSIONS, type Vehicle, type VehicleModel } from '../traffic/vehicle';
import type { Building, BuildingId, City } from '../world/types';
import { clampToLane, curbStop } from './curb';
import {
  type Incident,
  type IncidentType,
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
/** Parking slot offsets in front of a station, in vehicle lengths. */
const SLOT_ORDER = [0, 1, -1];

const UNIT_SPECS: Record<UnitType, { model: VehicleModel; color: number; label: string; station: Building['kind'] }> = {
  fire: { model: 'fire_engine', color: 0xc62f25, label: 'Engine', station: 'fire_station' },
  police: { model: 'police_car', color: 0xf4f6f8, label: 'Patrol', station: 'police_station' },
};

/**
 * Takes incident reports, picks the fastest available unit, tracks units
 * through en route → on scene → returning, and queues calls when every
 * unit is busy (FIFO per unit type).
 */
export class Dispatcher {
  readonly units: Unit[] = [];
  readonly incidents: Incident[] = [];
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
      status: 'reported',
      reportedAt: this.time,
      dispatchAt: this.time + this.rng.range(...CALL_PROCESSING),
      unitId: null,
      scene: null,
      arrivedAt: null,
      duration: this.rng.range(min, max),
      workDone: 0,
      resolvedAt: null,
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
    const unit = this.bestUnitFor(incident);
    if (!unit) {
      incident.status = 'queued';
      return;
    }
    this.assign(unit, incident);
  }

  /** The available unit of the right type with the shortest travel time. */
  private bestUnitFor(incident: Incident): Unit | null {
    const type = UNIT_TYPE_FOR[incident.type];
    let best: Unit | null = null;
    let bestTime = Infinity;
    for (const unit of this.units) {
      if (unit.type !== type || !this.isAvailable(unit)) continue;
      const time = this.traffic.travelTime(unit.vehicle, this.sceneFor(incident, unit));
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

  private assign(unit: Unit, incident: Incident): void {
    const scene = this.sceneFor(incident, unit);
    if (!this.traffic.sendTo(unit.vehicle, scene, true)) {
      incident.status = 'queued';
      return;
    }
    incident.scene = scene;
    incident.unitId = unit.id;
    unit.incidentId = incident.id;
    unit.status = 'en_route';
    // A unit already on the road is en route at once; a parked one first has to pull out.
    incident.status = unit.vehicle.maneuver === 'driving' ? 'en_route' : 'assigned';
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

  /** Gives a free unit the oldest queued call of its type. */
  private serveQueue(unit: Unit): boolean {
    const next = this.incidents
      .filter((i) => i.status === 'queued' && UNIT_TYPE_FOR[i.type] === unit.type)
      .sort((a, b) => a.reportedAt - b.reportedAt)[0];
    if (!next) return false;
    this.assign(unit, next);
    return true;
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
    const taken = this.incidents
      .filter((i) => i !== incident && i.status !== 'resolved' && i.scene?.segment === base.segment)
      .map((i) => i.scene!.s);
    for (const k of [0, 1, -1, 2, -2, 3, -3]) {
      const s = lane.kind === 'lane' ? clampToLane(lane, base.s + k * (length + 2), length) : base.s;
      if (taken.every((t) => Math.abs(t - s) > length + 1.5) && !this.traffic.blocksCrossing(base.segment, s, length)) {
        return { segment: base.segment, s };
      }
    }
    return base;
  }
}
