import type { IncidentPriority, IncidentStatus, IncidentType, UnitStatus } from '../sim/dispatch/types';
import type { CrewStatus } from '../sim/power/powerSystem';

export interface StatusLabel {
  label: string;
  /** CSS tone suffix: neutral | info | warn | active | done. */
  tone: string;
}

export const INCIDENT_STATUS: Record<IncidentStatus, StatusLabel> = {
  reported: { label: 'Call received', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'warn' },
  assigned: { label: 'Assigned', tone: 'info' },
  en_route: { label: 'En route', tone: 'info' },
  on_scene: { label: 'On scene', tone: 'active' },
  resolved: { label: 'Resolved', tone: 'done' },
};

export const UNIT_STATUS: Record<UnitStatus, StatusLabel> = {
  at_station: { label: 'At station', tone: 'done' },
  patrolling: { label: 'Patrolling', tone: 'neutral' },
  en_route: { label: 'En route', tone: 'info' },
  on_scene: { label: 'On scene', tone: 'active' },
  returning: { label: 'Returning', tone: 'neutral' },
  on_duty: { label: 'On duty', tone: 'info' },
};

export const INCIDENT_NAME: Record<IncidentType, string> = { fire: 'Fire', crime: 'Crime' };

export const CREW_STATUS: Record<CrewStatus, string> = {
  at_depot: 'At the depot',
  leaving: 'Pulling out',
  to_substation: 'Driving to substation',
  repairing: 'Repairing',
  returning: 'Returning',
  entering: 'Parking',
};

/** Badge text for urgent calls (normal calls get none). */
export const PRIORITY_LABEL: Record<IncidentPriority, string | null> = {
  critical: 'Critical',
  high: 'High',
  normal: null,
};
