import { describe, expect, it } from 'vitest';
import { Simulation } from './Simulation';
import { generateCity } from './world/cityGenerator';

describe('city pulse', () => {
  it('counts deliveries, bins, punctual trains, blackouts and responses', () => {
    const city = generateCity(1337, { scale: 10 });
    const sim = new Simulation(city, { civilianCount: 100 });
    expect(sim.pulse()).toEqual({
      deliveries: 0,
      binsEmptied: 0,
      trainArrivals: 0,
      trainsOnTime: null,
      blackouts: 0,
      incidentsResolved: 0,
      averageResponse: null,
    });

    const house = city.buildings.find((b) => b.kind === 'house')!;
    sim.reportIncident('fire', house.id);
    sim.power.switchOff(1);
    for (let i = 0; i < 20 * 600; i++) sim.step();

    const pulse = sim.pulse();
    expect(pulse.deliveries).toBeGreaterThan(10);
    expect(pulse.binsEmptied).toBeGreaterThan(3);
    // About one train per direction every 150 s, two stations each.
    expect(pulse.trainArrivals).toBeGreaterThanOrEqual(10);
    expect(pulse.trainsOnTime).toBeGreaterThanOrEqual(0.8);
    expect(pulse.blackouts).toBe(1);
    expect(pulse.incidentsResolved).toBe(1);
    expect(pulse.averageResponse).toBeGreaterThan(0);
    expect(pulse.averageResponse).toBeLessThan(300);
  });
});
