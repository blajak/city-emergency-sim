import type { IncidentStatus, IncidentType, UnitStatus } from '../sim/dispatch/types';

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
};

export const INCIDENT_NAME: Record<IncidentType, string> = { fire: 'Fire', crime: 'Crime' };
