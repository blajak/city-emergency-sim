import type { RoutePoint } from '../routing/router';
import type { Vehicle } from '../traffic/vehicle';
import type { BuildingId } from '../world/types';

export type UnitType = 'fire' | 'police';
export type UnitStatus = 'at_station' | 'patrolling' | 'en_route' | 'on_scene' | 'returning';

export type UnitId = number;
export type IncidentId = number;

export interface Unit {
  id: UnitId;
  type: UnitType;
  /** Display name, e.g. "Engine 1". */
  name: string;
  stationId: BuildingId;
  /** Parking slot in front of the station. */
  slot: number;
  status: UnitStatus;
  incidentId: IncidentId | null;
  vehicle: Vehicle;
}

export type IncidentType = 'fire' | 'crime';
export type IncidentStatus = 'reported' | 'queued' | 'assigned' | 'en_route' | 'on_scene' | 'resolved';

export interface Incident {
  id: IncidentId;
  type: IncidentType;
  buildingId: BuildingId;
  status: IncidentStatus;
  /** Sim time of the call. */
  reportedAt: number;
  /** Sim time when the dispatcher finishes processing the call. */
  dispatchAt: number;
  unitId: UnitId | null;
  /** Curb position the unit drives to. */
  scene: RoutePoint | null;
  arrivedAt: number | null;
  /** Seconds of work needed on scene. */
  duration: number;
  workDone: number;
  resolvedAt: number | null;
}

export type ReportResult =
  | { ok: true; incident: Incident }
  | { ok: false; reason: 'station' | 'busy' | 'unknown_building' };

export const UNIT_TYPE_FOR: Record<IncidentType, UnitType> = { fire: 'fire', crime: 'police' };
