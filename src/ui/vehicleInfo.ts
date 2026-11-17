import type { Unit } from '../sim/dispatch/types';
import type { LogisticsVehicle } from '../sim/logistics/logisticsSystem';
import type { Crew } from '../sim/power/powerSystem';
import type { Train } from '../sim/rail/railSystem';
import type { Simulation } from '../sim/Simulation';
import type { Bus } from '../sim/transit/busSystem';
import type { Vehicle } from '../sim/traffic/vehicle';
import { buildingLabel, formatAddress } from '../sim/world/address';
import type { Building } from '../sim/world/types';
import { CREW_STATUS, INCIDENT_NAME, PRIORITY_LABEL, UNIT_STATUS } from './labels';

/**
 * Something on the map that can be clicked, described and followed by the camera.
 * Utility crews are tracked as crews: their van leaves the road network on the driveway.
 */
export type Subject =
  | { kind: 'vehicle'; vehicle: Vehicle }
  | { kind: 'crew'; crew: Crew }
  | { kind: 'bus'; bus: Bus }
  | { kind: 'train'; train: Train };

export interface SubjectInfo {
  title: string;
  /** What it is, e.g. "Articulated lorry". */
  kind: string;
  status: string;
  /** Label / value rows (route, cargo, street…). */
  rows: [string, string][];
  color: number;
}

/** The subject for a road vehicle, resolving who owns it (bus, crew, or the vehicle itself). */
export function subjectForVehicle(sim: Simulation, vehicle: Vehicle): Subject {
  const bus = sim.buses.buses.find((b) => b.vehicle === vehicle);
  if (bus) return { kind: 'bus', bus };
  const crew = sim.power.crews.find((c) => c.vehicle === vehicle);
  if (crew) return { kind: 'crew', crew };
  return { kind: 'vehicle', vehicle };
}

/** False once the subject has left the map (a lorry back at its yard, a train in the tunnel…). */
export function subjectAlive(sim: Simulation, s: Subject): boolean {
  switch (s.kind) {
    case 'vehicle':
      return sim.traffic.vehicles.includes(s.vehicle);
    case 'crew':
      return sim.power.crews.includes(s.crew) && (s.crew.vehicle !== null || s.crew.move !== null);
    case 'bus':
      return sim.buses.buses.includes(s.bus);
    case 'train':
      return sim.rail.trains.includes(s.train);
  }
}

/** Where the subject is on the ground plane. */
export function subjectPosition(sim: Simulation, s: Subject): { x: number; z: number } {
  switch (s.kind) {
    case 'vehicle':
      return s.vehicle.pose;
    case 'crew':
      return s.crew.vehicle?.pose ?? s.crew.pose;
    case 'bus':
      return s.bus.vehicle.pose;
    case 'train':
      return sim.rail.trainCentre(s.train);
  }
}

const place = (sim: Simulation, b: Building) => `${buildingLabel(b)}, ${formatAddress(sim.city, b)}`;

/** Street a road vehicle is on (the street it is leaving while inside a junction). */
function streetOf(sim: Simulation, vehicle: Vehicle): string | null {
  const seg = sim.traffic.graph.segments[vehicle.segment];
  const lane = seg.kind === 'lane' ? seg : sim.traffic.graph.segments[seg.fromLane];
  if (lane.kind !== 'lane') return null;
  return sim.city.roads.edges[lane.edgeId]?.name ?? null;
}

const MODEL_NAME: Partial<Record<Vehicle['model'], string>> = { sedan: 'Sedan', hatchback: 'Hatchback', van: 'Van' };

export function describeSubject(sim: Simulation, s: Subject): SubjectInfo {
  switch (s.kind) {
    case 'train':
      return describeTrain(sim, s.train);
    case 'crew':
      return describeCrew(sim, s.crew);
    case 'bus':
      return describeBus(sim, s.bus);
    case 'vehicle': {
      const v = s.vehicle;
      const unit = sim.dispatcher.units.find((u) => u.vehicle === v);
      if (unit) return describeUnit(sim, unit);
      const item = sim.logistics.fleet.find((l) => l.vehicle === v);
      if (item) return describeLogistics(sim, item);
      const street = streetOf(sim, v);
      return {
        title: `Car ${v.id}`,
        kind: MODEL_NAME[v.model] ?? 'Car',
        status: v.yieldingTo !== null ? 'Pulling over for an emergency vehicle' : 'Driving around town',
        rows: street ? [['On', street]] : [],
        color: v.color,
      };
    }
  }
}

function describeUnit(sim: Simulation, unit: Unit): SubjectInfo {
  const incident = sim.dispatcher.incidents.find((i) => i.id === unit.incidentId);
  const station = sim.city.buildings[unit.stationId];
  const rows: [string, string][] = [];
  if (incident) {
    const priority = PRIORITY_LABEL[incident.priority];
    rows.push([INCIDENT_NAME[incident.type], formatAddress(sim.city, sim.city.buildings[incident.buildingId])]);
    if (priority) rows.push(['Priority', priority]);
  } else if (unit.status === 'returning') {
    rows.push(['To', place(sim, station)]);
  }
  const street = streetOf(sim, unit.vehicle);
  if (street && unit.status !== 'at_station') rows.push(['On', street]);
  return {
    title: unit.name,
    kind: unit.type === 'fire' ? 'Fire engine' : 'Police car',
    status: UNIT_STATUS[unit.status].label,
    rows,
    color: unit.type === 'fire' ? 0xc62f25 : 0x3557c9,
  };
}

const LOGISTICS_STATUS: Record<LogisticsVehicle['status'], string> = {
  loading: 'Loading',
  delivering: 'Delivering',
  unloading: 'Unloading',
  returning: 'Returning',
  collecting: 'Collecting waste',
  to_depot: 'Returning to the depot',
};

function describeLogistics(sim: Simulation, item: LogisticsVehicle): SubjectInfo {
  const rows: [string, string][] = [];
  let status = LOGISTICS_STATUS[item.status];
  if (item.kind === 'garbage') {
    if (item.status === 'collecting' && item.binsTotal > 0) {
      status = `Bin ${Math.min(item.binsDone + 1, item.binsTotal)} of ${item.binsTotal}`;
      if (item.bin) rows.push(['At', formatAddress(sim.city, item.bin)]);
    }
    if (item.status === 'unloading') status = 'Unloading at the depot';
    rows.push(['Depot', place(sim, item.home)]);
  } else {
    rows.push(['From', place(sim, item.home)]);
    if (item.customer) rows.push(['To', place(sim, item.customer)]);
    rows.push(['Cargo', item.cargo]);
  }
  const street = streetOf(sim, item.vehicle);
  if (street && item.vehicle.maneuver === 'driving') rows.push(['On', street]);
  return {
    title: item.name,
    kind: item.kind === 'truck' ? 'Articulated lorry' : item.kind === 'van' ? 'Delivery van' : 'Garbage truck',
    status,
    rows,
    color: item.vehicle.color,
  };
}

function describeCrew(sim: Simulation, crew: Crew): SubjectInfo {
  const rows: [string, string][] = [];
  if (crew.district !== null) rows.push(['District', sim.city.districts[crew.district].name]);
  if (crew.vehicle) {
    const street = streetOf(sim, crew.vehicle);
    if (street) rows.push(['On', street]);
  }
  return { title: crew.name, kind: 'Utility van', status: CREW_STATUS[crew.status], rows, color: 0xf2b134 };
}

function describeBus(sim: Simulation, bus: Bus): SubjectInfo {
  const stop = sim.buses.currentStop(bus);
  return {
    title: `${bus.name} · Line ${bus.line.name}`,
    kind: 'Bus',
    status: bus.status === 'at_stop' ? `At ${stop.name}` : `Next stop: ${stop.name}`,
    rows: [],
    color: bus.line.color,
  };
}

function describeTrain(sim: Simulation, train: Train): SubjectInfo {
  const next = sim.rail.nextStopName(train);
  const rows: [string, string][] = [];
  let status: string;
  if (train.stoppedAt) status = train.kind === 'passenger' ? `At ${train.stoppedAt}` : `Loading at ${train.stoppedAt}`;
  else if (next) status = `Next stop: ${next}`;
  else status = 'Leaving the city';
  if (train.stoppedAt && next) rows.push(['Next stop', next]);
  if (train.kind === 'passenger') rows.push(['Direction', train.track.kind === 'eastbound' ? 'Eastbound' : 'Westbound']);
  if (train.kind === 'longhaul') rows.push(['Route', 'East tunnel ⇄ Freight Hub']);
  rows.push(['Speed', `${Math.round(train.v * 3.6)} km/h`]);
  const look = TRAIN_LOOK[train.kind];
  return { ...look, title: train.kind === 'passenger' ? `Train ${train.id}` : `${look.kind} ${train.id}`, status, rows };
}

const TRAIN_LOOK: Record<Train['kind'], { kind: string; color: number }> = {
  passenger: { kind: 'Passenger train', color: 0xc8102e },
  freight: { kind: 'Freight shuttle', color: 0x2e7d5b },
  longhaul: { kind: 'Long-distance freight', color: 0x37474f },
};
