import type { RoutePoint } from '../routing/router';
import type { Vehicle } from '../traffic/vehicle';
import type { Building, BuildingId } from '../world/types';

/** Ambulances (based at the hospital) only stand by at stadium matches for now. */
export type UnitType = 'fire' | 'police' | 'ambulance';
/** on_duty: standing by at an event (a stadium match); takes no calls. */
export type UnitStatus = 'at_station' | 'patrolling' | 'en_route' | 'on_scene' | 'returning' | 'on_duty';

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
  /** Kerb spot of the event it stands by at (status `on_duty`). */
  duty: RoutePoint | null;
  vehicle: Vehicle;
}

export type IncidentType = 'fire' | 'crime';
export type IncidentStatus = 'reported' | 'queued' | 'assigned' | 'en_route' | 'on_scene' | 'resolved';
/** critical: power plant; high: hospital, school, mall; normal: everything else. */
export type IncidentPriority = 'critical' | 'high' | 'normal';

/** Lower rank = more urgent. */
export const PRIORITY_RANK: Record<IncidentPriority, number> = { critical: 0, high: 1, normal: 2 };

const HIGH_PRIORITY_KINDS: readonly Building['kind'][] = ['hospital', 'school', 'mall'];

export function priorityFor(building: Building): IncidentPriority {
  if (building.kind === 'power_plant') return 'critical';
  return HIGH_PRIORITY_KINDS.includes(building.kind) ? 'high' : 'normal';
}

export interface Incident {
  id: IncidentId;
  type: IncidentType;
  buildingId: BuildingId;
  priority: IncidentPriority;
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
  /** Times a more urgent call took this incident's unit away (it then queues first). */
  diverted: number;
}

export type ReportResult =
  | { ok: true; incident: Incident }
  | { ok: false; reason: 'station' | 'busy' | 'unknown_building' };

export const UNIT_TYPE_FOR: Record<IncidentType, UnitType> = { fire: 'fire', crime: 'police' };
