import { describe, expect, it } from 'vitest';
import { createRng } from '../math/rng';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';

describe('logistics', () => {
  it('delivers by lorry and van to off-road bays, collects garbage in the lane, collision-free', () => {
    const city = generateCity(1337, { scale: 10 });
    const sim = new Simulation(city, { civilianCount: 250, fireUnits: 2, policeUnits: 2 });
    const { logistics } = sim;
    expect(logistics.targets.truck).toBeGreaterThanOrEqual(10);
    expect(logistics.targets.van).toBeGreaterThanOrEqual(10);
    expect(logistics.targets.garbage).toBeGreaterThanOrEqual(1);
    const rng = createRng(8);
    const homes = city.buildings.filter((b) => b.kind === 'residential');

    const finished = { truck: 0, van: 0, garbage: 0, container: 0 };
    let unloadedAtBay = 0;
    let bins = 0;
    for (let step = 0; step < 10 * 60 * 20; step++) {
      if (step % 400 === 0) sim.reportIncident(rng.chance(0.5) ? 'fire' : 'crime', rng.pick(homes).id);
      const before = new Map(logistics.fleet.map((l) => [l.id, l]));
      const halted = new Set(logistics.fleet.filter((l) => l.vehicle.halted).map((l) => l.id));
      sim.step();
      for (const [id, l] of before) if (!logistics.fleet.some((x) => x.id === id)) finished[l.kind]++;
      for (const l of logistics.fleet) {
        if (l.kind === 'garbage' && l.vehicle.halted && !halted.has(l.id)) bins++;
        // Lorries and vans unload off the road, at the kerb in the customer's bay.
        if (l.status === 'unloading' && l.kind !== 'garbage' && l.vehicle.maneuver === 'parked') unloadedAtBay++;
      }
      const hit = findOverlap(sim.traffic.vehicles);
      if (hit) throw new Error(`t=${sim.time.toFixed(2)} overlap: ${hit}`);
    }
    expect(finished.truck).toBeGreaterThan(5);
    expect(finished.van).toBeGreaterThan(5);
    expect(unloadedAtBay).toBeGreaterThan(0);
    expect(bins).toBeGreaterThanOrEqual(3);
    // The fleet is kept up: new jobs replace finished ones.
    expect(logistics.count('truck')).toBeGreaterThanOrEqual(logistics.targets.truck - 3);
  });

  it('has no garbage trucks in the small town (no waste depot)', () => {
    const sim = new Simulation(generateCity(1337), { civilianCount: 10 });
    expect(sim.logistics.targets.garbage).toBe(0);
    expect(sim.logistics.targets.truck).toBeGreaterThan(0);
  });
});
