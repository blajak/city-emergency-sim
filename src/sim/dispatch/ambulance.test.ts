import { describe, expect, it } from 'vitest';
import { describeSubject, subjectForVehicle } from '../../ui/vehicleInfo';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';
import { MAX_UNITS_PER_STATION } from './dispatcher';

const city = generateCity(1337, { scale: 10 });

describe('ambulances', () => {
  it('has none in a town without a hospital', () => {
    const small = generateCity(1337, { scale: 1 });
    expect(small.buildings.some((b) => b.kind === 'hospital')).toBe(false);
    const sim = new Simulation(small, { civilianCount: 0 });
    expect(sim.dispatcher.unitsOfType('ambulance')).toHaveLength(0);
  });

  it('parks one ambulance at the hospital kerb, which stays free of bus stops and delivery bays', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const [amb] = sim.dispatcher.unitsOfType('ambulance');
    const hospital = city.buildings.find((b) => b.kind === 'hospital')!;
    expect(amb).toMatchObject({ name: 'Ambulance 1', status: 'at_station', stationId: hospital.id });
    expect(amb.vehicle.model).toBe('ambulance');
    expect(amb.vehicle.maneuver).toBe('parked');
    // Close to the hospital's front.
    const lane = sim.traffic.graph.segments[amb.vehicle.segment];
    expect(lane.kind === 'lane' && lane.edgeId === hospital.address.edgeId).toBe(true);
    const { edgeId, side, s } = hospital.address;
    for (const stop of city.transit.stops) {
      if (stop.edgeId === edgeId && stop.side === side) expect(Math.abs(stop.s - s), 'bus stop').toBeGreaterThan(16);
    }
    for (const b of city.buildings) {
      if (b.bay?.edgeId === edgeId && b.bay.side === side) expect(Math.abs(b.bay.s - s), 'bay').toBeGreaterThan(16);
    }
    expect(describeSubject(sim, subjectForVehicle(sim, amb.vehicle))).toMatchObject({ title: 'Ambulance 1', kind: 'Ambulance', status: 'At station' });
  });

  it('can have one to three ambulances, and fires and crimes never get one', () => {
    const sim = new Simulation(city, { civilianCount: 60 });
    const { dispatcher } = sim;
    while (dispatcher.addUnit('ambulance'));
    expect(dispatcher.unitsOfType('ambulance')).toHaveLength(MAX_UNITS_PER_STATION);
    const homes = city.buildings.filter((b) => b.kind === 'house');
    for (let k = 0; k < 6; k++) sim.reportIncident(k % 2 ? 'crime' : 'fire', homes[k * 5].id);
    for (let i = 0; i < 20 * 120; i++) {
      sim.step();
      if (i % 20 === 0) {
        const hit = findOverlap(sim.traffic.vehicles);
        if (hit) throw new Error(`t=${sim.time.toFixed(1)} ${hit}`);
      }
    }
    for (const amb of dispatcher.unitsOfType('ambulance')) expect(amb.status).toBe('at_station');
    expect(dispatcher.incidents.filter((i) => i.unitId !== null).every((i) => dispatcher.unit(i.unitId)!.type !== 'ambulance')).toBe(true);
    // Back down to one; the last one stays.
    for (const amb of dispatcher.unitsOfType('ambulance').slice(1)) expect(dispatcher.removeUnit(amb.id)).toBe(true);
    expect(dispatcher.removalBlocker(dispatcher.unitsOfType('ambulance')[0])).toBe('A station needs at least one unit.');
  }, 60_000);
});
