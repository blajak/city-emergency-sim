import { describe, expect, it } from 'vitest';
import { obbOverlap } from './math/geometry';
import { createRng } from './math/rng';
import { SpatialGrid, obbBox } from './math/spatialGrid';
import { Simulation } from './Simulation';
import type { Vehicle } from './traffic/vehicle';
import { generateCity } from './world/cityGenerator';

/**
 * Budgets for the 10× city. They are deliberately loose (CI machines are
 * slower than a laptop); locally the numbers are several times lower.
 */
const GENERATION_BUDGET_MS = 3000;
const STEP_BUDGET_MS = 5;

function footprint(v: Vehicle) {
  return { center: { x: v.pose.x, z: v.pose.z }, halfW: v.width / 2 - 0.2, halfD: v.length / 2 - 0.2, rotation: v.pose.yaw };
}

/** First overlapping pair, using a grid so it stays fast with hundreds of vehicles. */
function findOverlap(vehicles: readonly Vehicle[]): string | null {
  const grid = new SpatialGrid<Vehicle>(12);
  for (const v of vehicles) {
    const box = footprint(v);
    for (const other of grid.query(obbBox(box))) {
      if (obbOverlap(box, footprint(other))) return `${v.role} ${v.id} / ${other.role} ${other.id}`;
    }
    grid.insert(v, obbBox(box));
  }
  return null;
}

describe('10× city', () => {
  const started = performance.now();
  const city = generateCity(1337, { scale: 10 });
  const generationMs = performance.now() - started;

  it('generates ~10× the streets and buildings quickly', () => {
    expect(city.roads.edges.length).toBeGreaterThanOrEqual(250);
    expect(city.buildings.length).toBeGreaterThan(2000);
    expect(generationMs).toBeLessThan(GENERATION_BUDGET_MS);
  });

  it('runs 400 vehicles with incidents within the step budget, collision-free', () => {
    const sim = new Simulation(city, { civilianCount: 400, fireUnits: 3, policeUnits: 3 });
    const rng = createRng(3);
    const homes = city.buildings.filter((b) => b.kind === 'residential');
    let total = 0;
    const steps = 90 * 20;
    for (let t = 0; t < steps; t++) {
      if (t % 300 === 0) sim.reportIncident(rng.chance(0.5) ? 'fire' : 'crime', rng.pick(homes).id);
      const a = performance.now();
      sim.step();
      total += performance.now() - a;
      const hit = findOverlap(sim.traffic.vehicles);
      if (hit) throw new Error(`t=${sim.time.toFixed(2)} overlap: ${hit}`);
    }
    expect(sim.traffic.vehicles.length).toBeGreaterThanOrEqual(400);
    expect(total / steps).toBeLessThan(STEP_BUDGET_MS);
    // Calls reported in the first minute got a unit and are being handled or done.
    const early = sim.dispatcher.incidents.filter((i) => i.reportedAt < 30);
    expect(early.every((i) => i.status === 'on_scene' || i.status === 'resolved' || i.status === 'en_route')).toBe(true);
  });
});
